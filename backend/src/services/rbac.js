/**
 * RBAC engine for the Administration Center.
 *
 * One resolver answers every authorization question in the product:
 *
 *   Effective permissions = union(role permissions, incl. permission groups)
 *                         + direct user permissions
 *                         - explicit denies
 *
 * Roles are data, not code: system roles are seeded defaults, and companies can
 * create unlimited custom roles. Nothing in this file hard-codes what a role
 * may do — only which roles are *protected* from destructive edits and who may
 * author access in the first place (anti privilege-escalation).
 *
 * Caching: role→permission maps are cached per tenant with a short TTL, and every
 * mutation calls invalidate*() so a stale grant can never outlive the change.
 */
const { pool } = require('../config/db');
const { HttpError } = require('../utils/helpers');
const {
  PERMISSION_CATALOG, PERMISSIONS, ROLE_DEFS, DEFAULT_ROLES, MODULE_CATALOG, MODULE_PERMISSION_MODULES,
  hasPerm, allowedScopes, widestScope, aliasCandidates, SCOPES, SCOPE_RANK,
} = require('../utils/permissions');

const CACHE_TTL_MS = 30_000;

/** Roles that may never be edited destructively, deleted, or self-granted. */
const PROTECTED_ROLE_KEYS = ['platform_super_admin', 'company_owner'];

const isPlatformRole = (role) => role && role.tenant_id === null;

// ---------------------------------------------------------------- cache layer
const roleCache = new Map();   // `${tenantId}` -> { at, roles: Map(id|key -> role) }
const userCache = new Map();   // `${userId}` -> { at, effective }
const groupCache = new Map();  // `${tenantId}` -> { at, groups: Map(id -> {name, perms:Set}) }
const moduleCache = new Map(); // `${tenantId}` -> { at, enabled:Set<string> }

const fresh = (entry) => entry && Date.now() - entry.at < CACHE_TTL_MS;

/**
 * Drop one user's cached effective permissions.
 *
 * The cache is keyed by `id:tenantId:role:status` (the role and status are part of
 * the key so that a demotion or a deactivation cannot be served from a stale
 * entry), so invalidation has to match on that id rather than assume it is the
 * whole key. Getting this wrong leaves a revoked permission working for the whole
 * TTL, which is a security bug rather than a performance one.
 */
function invalidateUser(userId) {
  if (userId == null) return;
  const id = String(userId);
  for (const [key, value] of userCache) {
    if (key === id || key.startsWith(`${id}:`) || String(value.effective?.user?.id) === id) {
      userCache.delete(key);
    }
  }
}

function invalidateTenant(tenantId) {
  roleCache.delete(String(tenantId ?? 0));
  groupCache.delete(String(tenantId ?? 0));
  moduleCache.delete(String(tenantId ?? 0));
  for (const [k, v] of userCache) if (String(v.tenantId) === String(tenantId)) userCache.delete(k);
}

function invalidateAll() {
  roleCache.clear(); userCache.clear(); groupCache.clear(); moduleCache.clear();
}

const parseJson = (v, fallback) => {
  if (v === null || v === undefined) return fallback;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return fallback; }
};

// -------------------------------------------------------- role permission sets
/**
 * All roles visible to a tenant (its own + platform templates) with their
 * resolved permission sets. A role's permissions come from three places and the
 * union is authoritative:
 *   1. roles.permissions          — legacy JSON blob (still written by older code)
 *   2. role_permissions           — normalised individual grants
 *   3. permission groups          — via role_permission_groups
 */
async function loadRoles(tenantId) {
  const key = String(tenantId ?? 0);
  if (fresh(roleCache.get(key))) return roleCache.get(key).roles;

  const [roleRows] = await pool.query(
    `SELECT id, tenant_id, name, code, label, description, role_type, is_system, is_custom,
            is_protected, status, permissions, created_at
     FROM roles WHERE tenant_id = ? OR tenant_id IS NULL`,
    [tenantId]
  );
  const [direct] = await pool.query(
    `SELECT rp.role_id AS rid, p.pkey
     FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id`
  );
  const [grouped] = await pool.query(
    `SELECT rpg.role_id AS rid, p.pkey
     FROM role_permission_groups rpg
     JOIN permission_group_permissions pgp ON pgp.group_id = rpg.group_id
     JOIN permissions p ON p.id = pgp.permission_id`
  );

  const directByRole = new Map();
  for (const r of direct) {
    if (!directByRole.has(r.rid)) directByRole.set(r.rid, []);
    directByRole.get(r.rid).push(r.pkey);
  }
  const groupByRole = new Map();
  for (const r of grouped) {
    if (!groupByRole.has(r.rid)) groupByRole.set(r.rid, []);
    groupByRole.get(r.rid).push(r.pkey);
  }

  const roles = new Map();
  for (const row of roleRows) {
    const set = new Set(parseJson(row.permissions, []) || []);
    for (const p of directByRole.get(row.id) || []) set.add(p);
    for (const p of groupByRole.get(row.id) || []) set.add(p);
    // A tenant may rename its copy of a system role; keep the code-keyed fallback
    // aligned so legacy users.role references still resolve.
    roles.set(row.id, { ...row, perms: set });
    if (row.name) roles.set(`name:${row.name}`, { ...row, perms: set });
    if (row.code) roles.set(`code:${row.code}`, { ...row, perms: set });
  }
  // System defaults for any role the database does not know about yet, so a fresh
  // install or a partially migrated install still resolves permissions.
  for (const [roleKey, def] of Object.entries(ROLE_DEFS)) {
    if (!roles.has(`name:${roleKey}`)) {
      roles.set(`name:${roleKey}`, {
        id: null, tenant_id: null, name: roleKey, label: def.label,
        is_system: true, is_custom: 0, status: 'active', role_type: 'system',
        perms: new Set(def.permissions), virtual: true,
      });
    }
  }
  const entry = { at: Date.now(), roles };
  roleCache.set(key, entry);
  return roles;
}

/** Resolve a role by id, name or code. Legacy `users.role` holds the code. */
async function resolveRole(tenantId, roleRef) {
  if (roleRef === null || roleRef === undefined || roleRef === '') return null;
  const roles = await loadRoles(tenantId);
  const raw = roleRef;
  if (roles.has(raw)) return roles.get(raw);
  if (roles.has(String(raw))) return roles.get(String(raw));
  const ref = String(raw).trim();
  for (const prefix of ['name:', 'code:']) {
    if (roles.has(prefix + ref)) return roles.get(prefix + ref);
    const lower = roles.get(prefix + ref.toLowerCase());
    if (lower) return lower;
  }
  // Last resort: a role id stored as a string, or a label that is unique.
  if (/^\d+$/.test(ref)) {
    const byId = roles.get(Number(ref));
    if (byId) return byId;
  }
  return null;
}

/** Permissions granted to a role, expanded from JSON + rows + groups. */
async function rolePermissions(tenantId, roleId) {
  const role = typeof roleId === 'object' && roleId ? roleId : await resolveRole(tenantId, roleId);
  if (!role) throw new HttpError(404, 'Role not found');
  return [...role.perms].sort();
}

// ------------------------------------------------------- effective permissions
/** Roles attached to a user (multi-role), falling back to the legacy role column. */
async function rolesForUser(user) {
  const [rows] = await pool.query(
    `SELECT ur.is_primary, r.id, r.name, r.label, r.is_system, r.is_custom, r.status, r.permissions
     FROM user_roles ur JOIN roles r ON r.id = ur.role_id
     WHERE ur.user_id = ? ORDER BY ur.is_primary DESC, r.label`,
    [user.id]
  );
  if (rows.length) return rows;
  if (!user.role) return [];
  const [fallback] = await pool.query(
    'SELECT id, name, label, is_system, is_custom, status, permissions FROM roles WHERE name = ? AND (tenant_id = ? OR tenant_id IS NULL) ORDER BY tenant_id IS NULL LIMIT 1',
    [user.role, user.tenant_id ?? null]
  );
  return fallback;
}

/** Explicit denies remove the matching grant, including every scoped variant. */
function applyDenies(allowed, denied) {
  if (!denied.length) return allowed;
  const out = new Set(allowed);
  for (const d of denied) {
    const [base, scope] = d.split(':');
    out.delete(d);
    if (scope) {
      for (const k of [...out]) if (k === base || k.startsWith(base + ':')) out.delete(k);
    } else {
      for (const k of [...out]) if (k === base || k.startsWith(base + ':')) out.delete(k);
    }
  }
  return out;
}

/**
 * Effective permission set for a user row ({id, tenant_id, role, ...}).
 * Cached per user; every role/permission/assignment mutation invalidates.
 */
async function effectivePermissions(user) {
  if (!user || user.id == null) return emptyEffective(user);
  const cacheKey = `${user.id}:${user.tenant_id ?? 0}:${user.role || ''}:${user.status || ''}`;
  if (fresh(userCache.get(cacheKey))) return userCache.get(cacheKey).effective;

  const roleRows = await rolesForUser(user);
  const [direct] = await pool.query(
    `SELECT udp.effect, p.pkey
     FROM user_direct_permissions udp JOIN permissions p ON p.id = udp.permission_id
     WHERE udp.user_id = ?`,
    [user.id]
  );

  const allowed = new Set();
  const roleMeta = [];
  for (const r of roleRows) {
    const perms = new Set(parseJson(r.permissions, []) || []);
    if (r.id) {
      const roles = await loadRoles(user.tenant_id ?? 0);
      const resolved = roles.get(r.id);
      if (resolved) for (const p of resolved.perms) perms.add(p);
    }
    for (const p of perms) allowed.add(p);
    roleMeta.push({
      id: r.id, name: r.name, label: r.label,
      isSystem: !!r.is_system, isCustom: !!r.is_custom, status: r.status,
      permissionCount: perms.size,
    });
  }

  for (const d of direct) if (d.effect === 'allow') allowed.add(d.pkey);
  const denied = direct.filter((d) => d.effect === 'deny').map((d) => d.pkey);
  const effectiveSet = applyDenies(allowed, denied);

  const effective = {
    user: { id: user.id, role: user.role, tenantId: user.tenant_id, employeeId: user.employee_id },
    tenantId: user.tenant_id ?? null,
    roles: roleMeta,
    rolePermissions: Object.fromEntries(roleRows.map((r) => [r.name, [...new Set(parseJson(r.permissions, []) || [])]])),
    directPermissions: direct.filter((d) => d.effect === 'allow').map((d) => d.pkey),
    deniedPermissions: denied,
    permissions: [...effectiveSet].sort(),
    scopes: scopeMap([...effectiveSet]),
    // A platform super admin is exempt from the module gate in `requireModuleEnabled`,
    // so the honest answer for one is the whole catalog — even when the account is
    // bound to a company whose admin has switched a module off. Reporting the tenant's
    // enabled set instead would make the UI hide a screen the API still answers.
    // The *other* platform roles have no company, so they likewise see nothing:
    // reaching a customer's modules is what a support-access session is for.
    accessibleModules: await enabledModules(
      user.tenant_id == null || user.role === 'platform_super_admin' ? null : user.tenant_id
    ),
  };
  userCache.set(cacheKey, { at: Date.now(), effective, tenantId: user.tenant_id });
  return effective;
}

const emptyEffective = (user) => ({
  user: { id: user?.id ?? null, role: user?.role ?? null, tenantId: user?.tenant_id ?? null },
  tenantId: user?.tenant_id ?? null,
  roles: [], rolePermissions: {}, directPermissions: [], deniedPermissions: [],
  permissions: [], scopes: {}, accessibleModules: [],
});

/** { 'employee.view': 'team', ... } — widest scope held per base permission. */
function scopeMap(permissions) {
  const bases = new Set();
  for (const p of permissions) bases.add(p.split(':')[0]);
  const out = {};
  for (const base of bases) {
    const s = widestScope(permissions, base);
    if (s) out[base] = s;
  }
  return out;
}

// ------------------------------------------------------------- module gating
async function enabledModules(tenantId) {
  if (tenantId == null) return MODULE_CATALOG.map((m) => m.key);
  const key = String(tenantId);
  if (fresh(moduleCache.get(key))) return [...moduleCache.get(key).enabled];
  const [rows] = await pool.query(
    'SELECT module_key, enabled FROM module_configurations WHERE tenant_id = ?', [tenantId]
  );
  const byKey = new Map(rows.map((r) => [r.module_key, !!r.enabled]));
  // A module with no row of its own follows the catalog default. Reading only the
  // stored rows would mean that the first module an administrator ever touched
  // silently switched off every other module in the product.
  const enabled = MODULE_CATALOG
    .filter((m) => (byKey.has(m.key) ? byKey.get(m.key) : !!m.defaultEnabled))
    .map((m) => m.key);
  moduleCache.set(key, { at: Date.now(), enabled: new Set(enabled) });
  return enabled;
}

/** True when the module is enabled for the tenant. Disabled ⇒ access denied. */
async function isModuleEnabled(tenantId, moduleKey) {
  if (!moduleKey) return true;
  const enabled = await enabledModules(tenantId);
  return enabled.includes(moduleKey);
}

// --------------------------------------------------------------- role safety
const canManageRoleObject = (actor) =>
  actor?.role === 'platform_super_admin' ||
  hasPerm(actor?.permissions || [], 'administration.roles.manage') ||
  hasPerm(actor?.permissions || [], 'role.manage');

const isOwnerLevel = (actor) => actor?.role === 'platform_super_admin' || actor?.role === 'company_owner';

/**
 * Compare two permission sets by *reach*, not by string equality.
 *
 * A role that holds `expense.view:department` is not "different" from one holding
 * `expense.view:own` — it simply sees more. So for every base permission the
 * target holds, the actor's widest scope must be at least as wide. An unscoped
 * key means full (company) reach.
 */
function privilegeExcess(actorPermissions, targetPermissions) {
  const actorReach = reachMap(actorPermissions);
  const targetReach = reachMap(targetPermissions);
  const excess = [];
  for (const [base, tRank] of targetReach) {
    const aRank = actorReach.get(base);
    if (aRank === undefined || aRank < tRank) excess.push({ base, actorScope: aRank === undefined ? null : SCOPES[aRank], targetScope: SCOPES[tRank] });
  }
  return excess;
}

/** base permission -> widest scope rank (unscoped = company reach). */
function reachMap(permissions) {
  const reach = new Map();
  for (const p of permissions) {
    const [base, scope] = p.split(':');
    const rank = scope ? (SCOPE_RANK[scope] ?? SCOPE_RANK.company) : SCOPE_RANK.company;
    if (!reach.has(base) || rank > reach.get(base)) reach.set(base, rank);
  }
  return reach;
}

/**
 * Does this permission set *cover* the requested key at least as widely?
 *
 * Direction matters: holding `expense.view:own` does not let you hand out
 * `expense.view:company`, but holding the company scope does let you hand out
 * the narrower `expense.view:own`. Aliases are followed one way only — a gate
 * written as `administration.users.manage` accepts the legacy `user.manage`, but
 * the reverse never holds, so you cannot hand out an umbrella you only hold one
 * narrow slice of.
 */
function coversPermission(permissions, requested) {
  if (!requested) return false;
  const list = permissions || [];
  if (list.includes(requested)) return true;
  const reach = reachMap(list);
  const [base, scope] = String(requested).split(':');
  const wanted = scope ? (SCOPE_RANK[scope] ?? SCOPE_RANK.company) : SCOPE_RANK.company;
  const bases = [base, ...aliasCandidates(base)];
  return bases.some((b) => (reach.get(b) ?? -1) >= wanted);
}

/**
 * The privilege ceiling that both role authoring and role assignment obey.
 *
 *  - the platform super admin may manage anything;
 *  - the company owner may manage every role inside the tenant, but never the
 *    platform super admin role;
 *  - any other administrator may only manage roles whose reach is no wider than
 *    their own, and never a protected role.
 *
 * A role holding *more* power than you can never be authored or handed out.
 */
async function assertPrivilegeCeiling(actor, target) {
  if (actor.role === 'platform_super_admin') return true;
  if (isPlatformRole(target)) throw new HttpError(403, 'Platform roles cannot be managed from a tenant');

  if (isOwnerLevel(actor)) {
    if (actor.tenant_id && target.tenant_id && String(target.tenant_id) !== String(actor.tenant_id)) {
      throw new HttpError(403, 'Cannot manage a role from another company');
    }
    return true;
  }

  if (PROTECTED_ROLE_KEYS.includes(target.name) || target.is_protected) {
    throw new HttpError(403, `${target.label || target.name} is a protected role`);
  }
  const extra = privilegeExcess(actor.permissions || [], target.perms || []);
  if (extra.length) {
    const sample = extra.slice(0, 3).map((e) => `${e.base} (${e.actorScope || 'none'} < ${e.targetScope})`).join(', ');
    throw new HttpError(403,
      `You cannot manage "${target.label || target.name}": it grants ${extra.length} permission(s) beyond your own access (e.g. ${sample})`
    );
  }
  return true;
}

/** May `actor` author or edit the definition of `target`? */
async function assertCanManageRole(actor, target) {
  if (!canManageRoleObject(actor)) throw new HttpError(403, 'Missing permission: administration.roles.manage');
  return assertPrivilegeCeiling(actor, target);
}

/**
 * May `actor` assign `role` to a user? Requires user administration, then obeys
 * the same ceiling — so an HR Admin may hand out any role they could hold
 * themselves (including a new custom role below their own level) but can never
 * mint a role above their own, nor grant themselves extra reach.
 */
async function assertCanAssignRole(actor, role) {
  if (actor.role !== 'platform_super_admin'
      && !hasPerm(actor.permissions || [], 'administration.users.manage')
      && !hasPerm(actor.permissions || [], 'user.manage')) {
    throw new HttpError(403, 'Missing permission: administration.users.manage');
  }
  if (actor.tenant_id != null && role.tenant_id != null && String(role.tenant_id) !== String(actor.tenant_id)) {
    throw new HttpError(403, 'Cannot assign a role from another company');
  }
  return assertPrivilegeCeiling(actor, role);
}

/** Roles the actor may hand out right now — drives the assignment dropdown. */
async function assignableRoles(actor) {
  const roles = await loadRoles(actor.tenant_id ?? 0);
  const out = [];
  const owner = isOwnerLevel(actor);
  const actorPerms = actor.permissions || [];
  for (const role of roles.values()) {
    if (role.id == null || role.virtual) continue;
    if (isPlatformRole(role)) continue;
    if (role.status && role.status !== 'active') continue;
    if (owner) { out.push(role); continue; }
    if (PROTECTED_ROLE_KEYS.includes(role.name) || role.is_protected) continue;
    if (!privilegeExcess(actorPerms, role.perms).length) out.push(role);
  }
  return [...new Map(out.map((r) => [r.id, r])).values()].sort((a, b) => String(a.label).localeCompare(String(b.label)));
}

// ------------------------------------------------------------ role operations
/** Write a role's permission set to every storage location so all readers agree. */
async function writeRolePermissions(tenantId, roleId, permissionKeys, actorId = null) {
  const wanted = [...new Set(permissionKeys.filter(Boolean))];
  // Reject unknown keys outright — a typo must never become a silent no-op grant.
  if (wanted.length) {
    const [found] = await pool.query('SELECT pkey FROM permissions WHERE pkey IN (?)', [wanted]);
    const unknown = wanted.filter((p) => !found.some((f) => f.pkey === p));
    if (unknown.length) throw new HttpError(400, `Unknown permission(s): ${unknown.join(', ')}`);
  }
  await pool.query('UPDATE roles SET permissions = ? WHERE id = ?', [JSON.stringify(wanted), roleId]);
  await pool.query('DELETE FROM role_permissions WHERE role_id = ?', [roleId]);
  if (wanted.length) {
    const [ids] = await pool.query('SELECT id FROM permissions WHERE pkey IN (?)', [wanted]);
    await pool.query(
      'INSERT IGNORE INTO role_permissions (tenant_id, role_id, permission_id, granted_by) VALUES ?',
      [ids.map((p) => [tenantId, roleId, p.id, actorId])]
    );
  }
  invalidateTenant(tenantId);
  invalidateAll();
  return wanted;
}

/** Set the groups a role receives; the group's permissions flow in automatically. */
async function writeRoleGroups(tenantId, roleId, groupIds, actorId = null) {
  const ids = [...new Set((groupIds || []).map(Number).filter(Boolean))];
  await pool.query('DELETE FROM role_permission_groups WHERE role_id = ?', [roleId]);
  if (ids.length) {
    const [rows] = await pool.query(
      `SELECT id FROM permission_groups WHERE id IN (?) AND (tenant_id = ? OR tenant_id IS NULL)`,
      [ids, tenantId]
    );
    if (rows.length !== ids.length) throw new HttpError(400, 'Unknown or foreign permission group');
    await pool.query(
      'INSERT IGNORE INTO role_permission_groups (tenant_id, role_id, group_id, granted_by) VALUES ?',
      [rows.map((r) => [tenantId, roleId, r.id, actorId])]
    );
  }
  invalidateAll();
}

/**
 * Give a brand new tenant its own copy of the system roles.
 *
 * Role rows are tenant-scoped, so a tenant without them resolves *no* permissions
 * for anybody — the failure is silent (every admin screen 403s) rather than
 * obvious. Every tenant-creation path goes through here so that cannot drift.
 */
async function provisionTenantRoles(tenantId) {
  for (const key of DEFAULT_ROLES) {
    const def = ROLE_DEFS[key];
    if (!def) continue;
    await pool.query(
      `INSERT IGNORE INTO roles (tenant_id, name, label, permissions, is_system, is_protected, role_type, status)
       VALUES (?,?,?,?,1,1,'system','active')`,
      [tenantId, key, def.label, JSON.stringify(def.permissions)]
    );
  }
  invalidateAll();
  return DEFAULT_ROLES.length;
}

/** Clone a role: permissions, scopes and groups only — never users, audit or system flags. */
async function cloneRole({ tenantId, roleId, newName, newCode, actor }) {
  const source = await resolveRole(tenantId, roleId);
  if (!source || source.id == null) throw new HttpError(404, 'Role not found');
  const targetName = String(newName || '').trim();
  if (!targetName) throw new HttpError(400, 'A name is required to clone a role');
  const [dupe] = await pool.query('SELECT id FROM roles WHERE tenant_id = ? AND name = ?', [tenantId, targetName]);
  if (dupe[0]) throw new HttpError(409, 'A role with that name already exists');

  const code = String(newCode || targetName).trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_');
  const [ins] = await pool.query(
    `INSERT INTO roles (tenant_id, name, code, label, description, role_type, is_system, is_custom, is_protected, status, permissions, created_by)
     VALUES (?,?,?,?,?, 'custom', 0, 1, 0, 'active', ?, ?)`,
    [tenantId, targetName, code, targetName, source.description ? `${source.description} (copy)` : null,
      JSON.stringify([...source.perms]), actor?.id ?? null]
  );
  // Groups: copy the membership, but re-map onto this tenant's own group copies.
  const [groupLinks] = await pool.query('SELECT group_id FROM role_permission_groups WHERE role_id = ?', [source.id]);
  if (groupLinks.length) {
    const [groups] = await pool.query(
      `SELECT id FROM permission_groups WHERE code IN (
         SELECT code FROM permission_groups WHERE id IN (?)) AND tenant_id = ?`,
      [groupLinks.map((g) => g.group_id), tenantId]
    );
    if (groups.length) {
      await pool.query(
        'INSERT IGNORE INTO role_permission_groups (tenant_id, role_id, group_id, granted_by) VALUES ?',
        [groups.map((g) => [tenantId, ins.insertId, g.id, actor?.id ?? null])]
      );
    }
  }
  invalidateAll();
  return ins.insertId;
}

/** Common / only-in-A / only-in-B / scope differences between two roles. */
async function compareRoles(tenantId, roleAId, roleBId) {
  const [a, b] = await Promise.all([resolveRole(tenantId, roleAId), resolveRole(tenantId, roleBId)]);
  if (!a || !b) throw new HttpError(404, 'Role not found');
  const setA = new Set(a.perms);
  const setB = new Set(b.perms);
  const onlyA = [...setA].filter((p) => !setB.has(p)).sort();
  const onlyB = [...setB].filter((p) => !setA.has(p)).sort();
  const common = [...setA].filter((p) => setB.has(p)).sort();
  const bases = [...new Set([...onlyA, ...onlyB].map((p) => p.split(':')[0]))];
  const scopeDiffs = bases.map((base) => ({
    base,
    a: widestScope([...setA], base) || null,
    b: widestScope([...setB], base) || null,
  })).filter((s) => s.a !== s.b);
  return {
    a: roleSummary(a), b: roleSummary(b),
    common, onlyInA: onlyA, onlyInB: onlyB, scopeDifferences: scopeDiffs,
  };
}

const roleSummary = (r) => ({
  id: r.id, name: r.name, label: r.label, description: r.description,
  isSystem: !!r.is_system, isCustom: !!r.is_custom, protected: !!r.is_protected || PROTECTED_ROLE_KEYS.includes(r.name),
  status: r.status, permissionCount: (r.perms || []).size,
});

// -------------------------------------------------------------- catalog reads
async function permissionCatalog({ q, module, scope } = {}) {
  let rows = PERMISSION_CATALOG;
  if (module) rows = rows.filter((p) => p.module === module);
  if (scope) rows = rows.filter((p) => p.scope === scope || p.scopes.includes(scope));
  if (q) {
    const needle = String(q).toLowerCase();
    rows = rows.filter((p) => p.key.toLowerCase().includes(needle) || p.label.toLowerCase().includes(needle));
  }
  const modules = [...new Set(PERMISSION_CATALOG.map((p) => p.module))].sort();
  return { permissions: rows, modules, scopes: SCOPES };
}

/** Matrix shape: modules → base permissions → scopes, for the Role Permission Matrix UI. */
async function permissionMatrix({ module } = {}) {
  const [db] = await pool.query('SELECT pkey FROM permissions');
  const known = new Set(db.map((r) => r.pkey));
  const list = PERMISSION_CATALOG.filter((p) => known.has(p.key) && (!module || p.module === module));
  const byModule = new Map();
  for (const p of list) {
    if (!byModule.has(p.module)) byModule.set(p.module, []);
    byModule.get(p.module).push(p);
  }
  return [...byModule.entries()].map(([moduleKey, perms]) => ({
    module: moduleKey,
    label: perms[0].label.split(' · ')[0],
    permissions: perms.filter((p) => !p.scope),
    scoped: perms.filter((p) => p.scope),
  }));
}

// -------------------------------------------------------------- access review
/**
 * "Preview access" — what can this user reach, and why. Explains each module by
 * the role/permission/scope that grants it so access problems are debuggable
 * without reading logs.
 */
async function previewAccess(userId, tenantId) {
  const [rows] = await pool.query(
    `SELECT id, name, email, role, tenant_id, employee_id, status FROM users WHERE id = ?`,
    [userId]
  );
  if (!rows[0]) throw new HttpError(404, 'User not found');
  if (rows[0].tenant_id != null && String(rows[0].tenant_id) !== String(tenantId)) {
    throw new HttpError(403, 'User belongs to another company');
  }
  const eff = await effectivePermissions(rows[0]);

  const canAccess = [];
  const cannotAccess = [];
  for (const m of MODULE_CATALOG) {
    // Which permission namespaces belong to this module is data, not a prefix guess.
    const namespaces = MODULE_PERMISSION_MODULES[m.key] || [m.key];
    const related = PERMISSION_CATALOG.filter((p) => namespaces.includes(p.module));
    const granted = related.filter((p) => hasPerm(eff.permissions, p.key));
    const enabled = eff.accessibleModules.includes(m.key);
    if (granted.length && enabled) {
      canAccess.push({
        module: m.key, name: m.name, enabled: true,
        reason: granted.slice(0, 6).map((g) => ({
          permission: g.key,
          scope: allowedScopes(eff.permissions, g.base).pop() || g.scope || 'company',
          via: eff.roles.find((r) => (eff.rolePermissions[r.name] || []).includes(g.key))?.label
            || (eff.directPermissions.includes(g.key) ? 'Direct permission' : 'Role'),
        })),
      });
    } else if (granted.length && !enabled) {
      // Permission exists but the company has switched the module off: the module is
      // unreachable for everyone, which is a different answer and worth saying so.
      cannotAccess.push({ module: m.key, name: m.name, enabled: false, reason: `The ${m.name} module is disabled for this company` });
    } else {
      cannotAccess.push({ module: m.key, name: m.name, enabled, reason: 'No role or direct permission grants this module' });
    }
  }
  return {
    user: rows[0],
    roles: eff.roles,
    directPermissions: eff.directPermissions,
    deniedPermissions: eff.deniedPermissions,
    permissionCount: eff.permissions.length,
    scopes: eff.scopes,
    canAccess,
    cannotAccess,
    enabledModules: eff.accessibleModules,
  };
}

/**
 * "Why can I access this?" — evaluates one (resource, action) pair and returns the
 * exact chain of reasoning: role → permission → scope → subject comparison.
 */
async function explainAccess({ tenantId, userId, permission, subject }) {
  const [rows] = await pool.query(
    'SELECT id, name, email, role, tenant_id, employee_id, status FROM users WHERE id = ?', [userId]
  );
  const target = rows[0];
  if (!target) throw new HttpError(404, 'User not found');
  if (target.tenant_id != null && String(target.tenant_id) !== String(tenantId)) {
    return { allowed: false, reasons: ['The user belongs to a different company'], crossTenant: true };
  }

  const eff = await effectivePermissions(target);
  const allowed = hasPerm(eff.permissions, permission);
  const reasons = [];
  const [base] = permission.split(':');
  const grantSource = eff.roles.find((r) => (eff.rolePermissions[r.name] || []).some((p) => p === permission || p.split(':')[0] === base));

  reasons.push(grantSource
    ? `Role: ${grantSource.label}`
    : (eff.directPermissions.includes(permission) ? 'Direct user permission' : 'No role grants this permission'));
  if (allowed) {
    reasons.push(`Permission: ${permission.split(':')[0]}`);
    const scope = widestScope(eff.permissions, base);
    reasons.push(`Scope: ${scope}`);
    if (subject?.employeeId && target.employee_id) {
      const same = Number(subject.employeeId) === Number(target.employee_id);
      reasons.push(same
        ? `Subject is the user's own record → within "${scope}" scope`
        : `Subject #${subject.employeeId} is compared against the user's scope "${scope}"`);
    }
    if (subject?.deptMatch === true) reasons.push('Subject shares the user\'s department → within scope');
    if (subject?.deptMatch === false) reasons.push('Subject is outside the user\'s department → outside scope');
  } else if (eff.deniedPermissions.length) {
    reasons.push(`An explicit deny is in effect for: ${eff.deniedPermissions.join(', ')}`);
  }
  return {
    allowed,
    permission,
    scope: widestScope(eff.permissions, base),
    reasons,
    crossTenant: false,
    effectivePermissionCount: eff.permissions.length,
  };
}

// ------------------------------------------------------------- lookup helpers
async function groupsForTenant(tenantId) {
  const [rows] = await pool.query(
    `SELECT g.id, g.tenant_id, g.code, g.name, g.description, g.is_system, g.status,
            (SELECT COUNT(*) FROM permission_group_permissions pgp WHERE pgp.group_id = g.id) AS permission_count,
            (SELECT COUNT(*) FROM roles r JOIN role_permission_groups rpg ON rpg.role_id = r.id WHERE rpg.group_id = g.id) AS role_count
     FROM permission_groups g WHERE g.tenant_id = ? OR g.tenant_id IS NULL
     ORDER BY g.is_system DESC, g.name`,
    [tenantId]
  );
  const [perms] = await pool.query(
    `SELECT pgp.group_id, p.pkey FROM permission_group_permissions pgp JOIN permissions p ON p.id = pgp.permission_id`
  );
  const byGroup = new Map();
  for (const p of perms) {
    if (!byGroup.has(p.group_id)) byGroup.set(p.group_id, []);
    byGroup.get(p.group_id).push(p.pkey);
  }
  return rows.map((g) => ({ ...g, permissions: (byGroup.get(g.id) || []).sort() }));
}

async function groupsForRole(roleId) {
  const [rows] = await pool.query(
    `SELECT g.id, g.code, g.name FROM role_permission_groups rpg
     JOIN permission_groups g ON g.id = rpg.group_id WHERE rpg.role_id = ? ORDER BY g.name`,
    [roleId]
  );
  return rows;
}

module.exports = {
  // reads
  loadRoles, resolveRole, rolePermissions, rolesForUser, effectivePermissions,
  scopeMap, enabledModules, isModuleEnabled, permissionCatalog, permissionMatrix,
  previewAccess, explainAccess, groupsForTenant, groupsForRole, compareRoles, assignableRoles, roleSummary,
  // writes
  writeRolePermissions, writeRoleGroups, cloneRole, provisionTenantRoles,
  // guards
  assertCanManageRole, assertCanAssignRole, assertPrivilegeCeiling, canManageRoleObject,
  isOwnerLevel, privilegeExcess, reachMap, coversPermission,
  // cache
  invalidateUser, invalidateTenant, invalidateAll,
  // constants
  PROTECTED_ROLE_KEYS, isPlatformRole, PERMISSIONS, MODULE_CATALOG, MODULE_PERMISSION_MODULES,
};