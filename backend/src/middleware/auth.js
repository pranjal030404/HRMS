const crypto = require('crypto');
const { pool } = require('../config/db');
const { verifyAccessToken } = require('../utils/jwt');
const { hasPerm, allowedScopes, ROLE_DEFS, PLATFORM_ROLE_KEYS } = require('../utils/permissions');
const { HttpError } = require('../utils/helpers');
const rbac = require('../services/rbac');

// Per-request correlation id, echoed on every response and stamped onto admin audit rows.
function requestContext(req, res, next) {
  req.requestId = req.headers['x-request-id'] || crypto.randomUUID();
  res.setHeader('X-Request-Id', req.requestId);
  next();
}

// Kept for backwards compatibility with callers that expect a name→perms map.
const rolePermCache = new Map(); // tenantId -> {roleKey: perms[]}
async function loadRolePermissions(tenantId) {
  if (rolePermCache.has(tenantId)) return rolePermCache.get(tenantId);
  const roles = await rbac.loadRoles(tenantId ?? 0);
  const map = {};
  for (const [key, role] of roles.entries()) {
    if (typeof key !== 'string' || !key.startsWith('name:')) continue;
    map[key.slice(5)] = [...role.perms];
  }
  for (const [k, def] of Object.entries(ROLE_DEFS)) if (!map[k]) map[k] = def.permissions;
  rolePermCache.set(tenantId, map);
  return map;
}
function invalidateRoleCache() { rolePermCache.clear(); rbac.invalidateAll(); }

/**
 * Derive the tenant from the authenticated session — never from the request body
 * or a query parameter. A non-platform user may only ever address their own
 * company, whatever they send.
 *
 * Deliberately synchronous: it is called from a lot of places, and the
 * support-access check belongs on the paths that can actually *address another
 * company* — see `resolveTenantFor`, which the platform and administration
 * routers use in place of this.
 */
function tenantOf(req) {
  if (!req.user || req.user.role === 'platform_super_admin') return req.user?.tenant_id ?? null;
  if (req.user.tenant_id == null) throw new HttpError(403, 'Your account is not bound to a company');
  return req.user.tenant_id;
}

/**
 * The tenant a request may address, with the full evaluation chain applied
 * (spec §23). Use this wherever a caller can name a company other than its own.
 *
 * A platform operator reaching into a company it is not bound to must hold a
 * live support-access session. That check is the entire point of Support Access:
 * it is what stops "platform administrator" from being a synonym for "may read
 * every customer's payroll".
 */
async function resolveTenantFor(req) {
  const asked = req.query?.tenant_id ?? req.body?.tenant_id;
  const user = req.user;
  if (!user) throw new HttpError(401, 'Authentication required');
  if (user.tenant_id != null && (asked === undefined || asked === null || asked === '')) return user.tenant_id;
  if (user.isPlatformAdmin) {
    if (asked === undefined || asked === null || asked === '') return user.tenant_id ?? null;
    const supportAccess = require('../services/supportAccess');
    await supportAccess.assertTenantReach(user, Number(asked));
    return Number(asked);
  }
  if (user.tenant_id == null) throw new HttpError(403, 'Your account is not bound to a company');
  if (asked !== undefined && asked !== null && asked !== '' && Number(asked) !== Number(user.tenant_id)) {
    throw new HttpError(403, 'You cannot address another company');
  }
  return user.tenant_id;
}

/** Require a valid access token. Attaches req.user with *effective* permissions. */
async function authenticate(req, res, next) {
  // Idempotent: a mount-level gate (the module checks) may already have resolved the
  // session, in which case the router's own gate must not repeat the database lookup.
  if (req.user) return next();
  try {
    const hdr = req.headers.authorization || '';
    const token = hdr.startsWith('Bearer ') ? hdr.slice(7) : null;
    if (!token) throw new HttpError(401, 'Authentication required');
    const payload = verifyAccessToken(token);
    const [rows] = await pool.query(
      `SELECT u.id, u.tenant_id, u.role, u.employee_id, u.name, u.email, u.status,
              u.locked_until, u.must_change_password,
              t.status AS tenant_status, t.name AS tenant_name
       FROM users u LEFT JOIN tenants t ON t.id = u.tenant_id WHERE u.id = ?`,
      [payload.sub]
    );
    const user = rows[0];
    if (!user) throw new HttpError(401, 'Account not found');
    // suspended / locked / disabled / archived / invited-but-not-activated are all
    // refused at authentication time — a disabled user cannot hold a session.
    if (user.status !== 'active') throw new HttpError(401, `Account is ${user.status.replace(/_/g, ' ')}`);
    if (user.locked_until && new Date(user.locked_until) > new Date()) throw new HttpError(423, 'Account is temporarily locked');
    // The tenant lifecycle (spec §27) is the second gate in the evaluation chain:
    // a deleted company cannot hold a session at all. Every *other* non-active
    // state (suspended, past due, grace, archived) still authenticates — those are
    // handled as read-only by `requireTenantWritable` on the write paths, so a
    // company locked out of billing does not lose sight of its own payroll.
    if (user.tenant_id && user.tenant_status === 'deleted') throw new HttpError(403, 'This company account has been deleted');

    const effective = await rbac.effectivePermissions(user);
    user.permissions = effective.permissions;
    user.roles = effective.roles;
    user.scopes = effective.scopes;
    user.directPermissions = effective.directPermissions;
    user.deniedPermissions = effective.deniedPermissions;
    // Custom platform roles are `platform_custom_*` rows in `roles` and only ever
    // belong to company-less accounts, so a tenant user can never reach this branch.
    user.isPlatformAdmin = PLATFORM_ROLE_KEYS.includes(user.role)
      || (user.tenant_id == null && /^platform_custom_[a-z0-9_]+$/.test(String(user.role)));
    user.isPlatformSuperAdmin = user.role === 'platform_super_admin';
    // A platform role with no company bound is a pure control-plane operator: it
    // has no tenant HRMS modules, because reaching a customer's records is what
    // Support Access is for.
    user.accessibleModules = effective.accessibleModules;

    // Resolve entitlements once per request so the module gate, the limit gate and
    // the "why is this unavailable" panel all read the same snapshot.
    if (user.tenant_id) {
      try {
        const entitlementService = require('../services/entitlements');
        const snapshot = await entitlementService.resolveTenant(user.tenant_id);
        user.tenantStatus = snapshot.tenant.status;
        user.tenantReadOnly = snapshot.readOnly;
        user.tenantBlocked = snapshot.blocked;
        user.subscription = snapshot.subscription;
        user.plan = snapshot.plan;
        user.entitlements = snapshot.entitlements;
      } catch (e) {
        // A control-plane failure must not stop an employee reaching their own
        // payslips; the write gates re-resolve and will report the real problem.
        console.error('[auth] entitlement resolution failed:', e.message);
      }
    }

    // A live support session travels with the request so the banner can render and
    // every cross-tenant read can be attributed to it.
    if (user.isPlatformAdmin) {
      try {
        user.supportSession = await require('../services/supportAccess').currentSession(user.id);
      } catch (_) { user.supportSession = null; }
    }

    req.user = user;
    if (user.tenant_id) {
      pool.query('UPDATE tenants SET last_activity_at = NOW() WHERE id = ?', [user.tenant_id]).catch(() => {});
    }
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') return next(new HttpError(401, 'Session expired'));
    next(err.status ? err : new HttpError(401, 'Invalid or expired token'));
  }
}

/**
 * Gate a route on a permission string (e.g. 'payroll.approve').
 * opts.scope    — additionally require at least that scope for a base permission
 * opts.module   — require the tenant module to be enabled (disabled ⇒ 403)
 * opts.anyOf    — pass when any one of the permissions is held
 * Every gate is server-side: hiding a button in the UI is never the control.
 */
function requirePermission(perm, opts = {}) {
  return (req, res, next) => {
    const user = req.user;
    if (!user) return next(new HttpError(401, 'Authentication required'));
    // Only the Platform Super Admin bypasses. The narrower platform roles
    // (billing, support, security, auditor) hold real, enumerated grants, so the
    // same predicate that decides a tenant's access decides theirs.
    if (user.role === 'platform_super_admin') return next();
    const perms = user.permissions || [];
    const allowed = opts.anyOf
      ? opts.anyOf.some((p) => hasPerm(perms, p))
      : hasPerm(perms, perm);
    if (!allowed) return next(new HttpError(403, `Missing permission: ${perm}`));

    if (opts.scope && perm && !perm.includes(':')) {
      const widest = allowedScopes(perms, perm).pop();
      if (!widest || SCOPE_ORDER.indexOf(widest) < SCOPE_ORDER.indexOf(opts.scope)) {
        return next(new HttpError(403, `${perm} requires at least the "${opts.scope}" scope`));
      }
    }
    if (opts.module) {
      return rbac.isModuleEnabled(user.tenant_id, opts.module)
        .then((on) => (on ? next() : next(new HttpError(403, `The ${opts.module} module is disabled for this company`))))
        .catch(next);
    }
    next();
  };
}
/**
 * Gate a whole router on a tenant module.
 *
 * Turning a module off in the Administration Center is meant to be real: the menu
 * disappears *and* the module's endpoints stop answering, so a feature cannot keep
 * running through a bookmark or an old client. Mount it in front of the router:
 *
 *   app.use('/api/payroll', requireModuleEnabled('payroll'), payrollRouter);
 *
 * The gate is the conjunction of two independent decisions (spec §23):
 *   • entitlement — does the tenant's plan grant `<module>.enabled`?
 *   • configuration — has the company switched it on?
 * A module the tenant paid for but did not switch on is refused with the same
 * message as one the plan does not include; `err.reason` tells them which, so the
 * UI can render the right diagnostic instead of a bare "forbidden".
 *
 * The platform super admin is exempt (they operate the platform itself).
 */
function requireModuleEnabled(moduleKey) {
  return (req, res, next) => {
    const user = req.user;
    // Mounted in front of a router, so authentication has usually not run yet.
    // Authenticate here once; the router's own `authenticate` then finds the user
    // already on the request and skips the second lookup.
    if (!user) return authenticate(req, res, (err) => (err ? next(err) : requireModuleEnabled(moduleKey)(req, res, next)));
    if (user.role === 'platform_super_admin') return next();
    if (user.tenant_id == null) return next(new HttpError(403, 'Your account is not bound to a company'));
    Promise.all([
      rbac.isModuleEnabled(user.tenant_id, moduleKey),
      require('../services/entitlements').moduleAvailability(user.tenant_id, moduleKey).catch(() => null),
    ])
      .then(([on, availability]) => {
        if (on && (!availability || availability.enabled)) return next();
        const err = new HttpError(403,
          availability && availability.missingDependencies && availability.missingDependencies.length
            ? `The ${moduleKey} module requires ${availability.missingDependencies.map((m) => m.name).join(', ')}`
            : `The ${moduleKey} module is disabled for this company`);
        err.module = moduleKey;
        err.entitlement = availability ? availability.entitlement : null;
        err.reason = availability ? availability.reason : null;
        return next(err);
      })
      .catch(next);
  };
}

/**
 * Gate a write on the tenant's lifecycle and subscription state (spec §26, §27).
 *
 * Reads are deliberately not gated: a company suspended for non-payment keeps
 * full sight of its own payroll history — that is both the humane reading and the
 * one that makes a customer pay.
 */
function requireTenantWritable() {
  return (req, res, next) => {
    const user = req.user;
    if (!user) return next(new HttpError(401, 'Authentication required'));
    if (user.role === 'platform_super_admin') return next();
    if (user.tenant_id == null) return next(new HttpError(403, 'Your account is not bound to a company'));
    if (user.tenantBlocked) return next(new HttpError(403, 'This company has been deleted'));
    if (user.tenantReadOnly) {
      const status = user.subscription?.status || user.tenantStatus;
      return next(new HttpError(402,
        `Your company is ${String(status).replace(/_/g, ' ')} — existing records remain readable but nothing new can be created until billing is resolved.`,
        { tenantStatus: user.tenantStatus, subscriptionStatus: user.subscription?.status || null }));
    }
    next();
  };
}

/**
 * Gate a route on an entitlement (`payroll.statutory.enabled`) or a numeric limit.
 * `usageKey` turns the same middleware into the limit check the server must own.
 */
function requireEntitlement(entitlementKey) {
  return (req, res, next) => {
    const user = req.user;
    if (!user) return next(new HttpError(401, 'Authentication required'));
    if (user.role === 'platform_super_admin') return next();
    if (user.tenant_id == null) return next(new HttpError(403, 'Your account is not bound to a company'));
    const entry = user.entitlements && user.entitlements[entitlementKey];
    if (entry) {
      if (entry.kind === 'boolean' ? !entry.enabled : entry.value <= 0) {
        const err = new HttpError(402, `${entry.name} is not included in your plan`, { entitlementKey });
        err.entitlement = entitlementKey;
        return next(err);
      }
      return next();
    }
    require('../services/entitlements').isEnabled(user.tenant_id, entitlementKey)
      .then((on) => (on ? next() : next(new HttpError(402, 'That capability is not included in your plan', { entitlementKey }))))
      .catch(next);
  };
}

/**
 * Require a platform role. Unlike `requirePermission` this is the *layer*, not a
 * capability: a company owner holding a stray `platform.*` direct permission still
 * cannot open the control plane.
 */
function requirePlatformRole() {
  return (req, res, next) => {
    if (!req.user) return next(new HttpError(401, 'Authentication required'));
    if (!req.user.isPlatformAdmin) {
      return next(new HttpError(403, 'The ARTHVEX platform console is restricted to platform administrators'));
    }
    // Platform-only security policy (IP allowlist, mandatory MFA, session age) —
    // separate from, and unaffected by, any company's own security settings.
    require('../services/platformSecurity').assertAllowed(req.user, req).then(() => next(), next);
  };
}

const SCOPE_ORDER = ['own', 'team', 'department', 'business_unit', 'location', 'company', 'platform'];

/** Gate on any one of several permissions (used where legacy and admin keys overlap). */
const requireAnyPermission = (perms) => requirePermission(null, { anyOf: perms });

/** Returns the widest employee-scope the user holds for a base perm (e.g. 'employee.view'). */
function scopeFor(user, base) {
  if (user.role === 'platform_super_admin') return 'company';
  const scopes = allowedScopes(user.permissions || [], base);
  if (scopes.includes('platform') || scopes.includes('company') || scopes.includes('tenant')) return 'company';
  if (scopes.includes('business_unit')) return 'business_unit';
  if (scopes.includes('department')) return 'department';
  if (scopes.includes('location')) return 'location';
  if (scopes.includes('team')) return 'team';
  return scopes[0] || 'none';
}

/** Department subtree ids under a department (used by department/biz-unit scope checks). */
async function departmentSubtree(tenantId, departmentId) {
  if (!departmentId) return [];
  const [rows] = await pool.query(
    `WITH RECURSIVE dept AS (
       SELECT id FROM departments WHERE tenant_id = ? AND id = ?
       UNION ALL
       SELECT d.id FROM departments d JOIN dept ON d.parent_id = dept.id
     ) SELECT id FROM dept`,
    [tenantId, departmentId]
  );
  return rows.map((r) => r.id);
}

/** SQL condition fragment limiting employees to the user's scope. */
function employeeScopeCondition(user, base, alias = 'e') {
  const scope = scopeFor(user, base);
  if (scope === 'company') return { sql: '1=1', params: [] };
  const me = user.employee_id || 0;
  if (scope === 'business_unit') {
    return {
      sql: `(${alias}.id = ? OR ${alias}.department_id IN (
              SELECT d.id FROM departments d JOIN business_units bu ON bu.id = d.parent_id
              WHERE bu.head_employee_id = ?))`,
      params: [me, me],
    };
  }
  if (scope === 'location') {
    return { sql: `(${alias}.id = ? OR ${alias}.location_id IN (SELECT id FROM locations WHERE tenant_id = ? AND id = (SELECT location_id FROM employees WHERE id = ?)))`, params: [me, user.tenant_id, me] };
  }
  if (scope === 'department') {
    // The user's department, its sub-tree, and every department they head.
    return {
      sql: `(${alias}.id = ? OR ${alias}.department_id IN (
              SELECT id FROM departments WHERE tenant_id = ? AND (head_employee_id = ? OR id = (SELECT department_id FROM employees WHERE id = ?))
            )
            OR ${alias}.department_id IN (
              SELECT id FROM (
                WITH RECURSIVE dept AS (
                  SELECT id FROM departments WHERE tenant_id = ? AND (head_employee_id = ? OR id = (SELECT department_id FROM employees WHERE id = ?))
                  UNION ALL
                  SELECT d.id FROM departments d JOIN dept ON d.parent_id = dept.id
                ) SELECT id FROM dept
              ) AS subtree
            ))`,
      params: [me, user.tenant_id, me, me, user.tenant_id, me, me],
    };
  }
  if (scope === 'team') {
    // The user plus everyone they manage, plus co-members of the teams they lead.
    return {
      sql: `(${alias}.id = ? OR ${alias}.manager_id = ? OR ${alias}.reporting_head_id = ?
             OR ${alias}.id IN (SELECT tm.employee_id FROM team_members tm JOIN teams t ON t.id = tm.team_id
                                WHERE t.tenant_id = ? AND (t.manager_id = ? OR t.team_lead_id = ?) AND tm.status = 'active'))`,
      params: [me, me, me, user.tenant_id, me, me],
    };
  }
  if (scope === 'own') return { sql: `${alias}.id = ?`, params: [me] };
  return { sql: '1=0', params: [] };
}

/** SQL condition fragment for a non-employee row (e.g. 'lr.employee_id') within the user's department scope. */
function departmentRowCondition(user, column) {
  return {
    sql: `(${column} = ? OR ${column} IN (SELECT id FROM employees WHERE department_id IN (
            SELECT id FROM departments WHERE tenant_id = ? AND head_employee_id = ?)))`,
    params: [user.employee_id, user.tenant_id, user.employee_id],
  };
}

/** Department ids whose head is the user's linked employee record. */
async function headedDepartmentIds(employeeId) {
  if (!employeeId) return [];
  const [rows] = await pool.query('SELECT id FROM departments WHERE head_employee_id = ?', [employeeId]);
  return rows.map((r) => r.id);
}

/**
 * Guard: is `user` allowed to act on `targetEmployeeId` for a permission scoped to `base`?
 * Mirrors employeeScopeCondition so list filtering and single-record checks agree.
 */
async function canActOnEmployee(user, base, targetEmployeeId) {
  if (user.role === 'platform_super_admin') return true;
  const scope = scopeFor(user, base);
  if (scope === 'company') return true;
  if (!user.employee_id || !targetEmployeeId) return false;
  if (Number(targetEmployeeId) === Number(user.employee_id)) return true;
  const me = user.employee_id;
  if (scope === 'team') {
    const [rows] = await pool.query(
      `SELECT 1 AS ok FROM employees target
       JOIN employees me ON me.id = ? AND me.tenant_id = target.tenant_id
       WHERE target.id = ? AND (
         target.manager_id = me.id OR target.reporting_head_id = me.id
         OR target.id IN (SELECT tm.employee_id FROM team_members tm JOIN teams t ON t.id = tm.team_id
                          WHERE t.tenant_id = me.tenant_id AND (t.manager_id = me.id OR t.team_lead_id = me.id) AND tm.status = 'active')
       ) LIMIT 1`,
      [me, targetEmployeeId]
    );
    return rows.length > 0;
  }
  if (scope === 'department' || scope === 'business_unit') {
    const [rows] = await pool.query(
      `SELECT 1 AS ok FROM employees target
       JOIN employees me ON me.id = ? AND me.tenant_id = target.tenant_id
       LEFT JOIN departments target_dept ON target_dept.id = target.department_id
       WHERE target.id = ? AND (
         target_dept.head_employee_id = me.id
         OR target_dept.id IN (WITH RECURSIVE dept AS (
              SELECT id FROM departments WHERE tenant_id = me.tenant_id AND (head_employee_id = me.id OR id = me.department_id)
              UNION ALL
              SELECT d.id FROM departments d JOIN dept ON d.parent_id = dept.id
            ) SELECT id FROM dept)
         OR target_dept.parent_id IN (SELECT id FROM business_units WHERE head_employee_id = me.id)
       ) LIMIT 1`,
      [me, targetEmployeeId]
    );
    return rows.length > 0;
  }
  if (scope === 'location') {
    const [rows] = await pool.query(
      'SELECT 1 AS ok FROM employees target JOIN employees me ON me.id = ? AND me.tenant_id = target.tenant_id WHERE target.id = ? AND target.location_id = me.location_id LIMIT 1',
      [me, targetEmployeeId]
    );
    return rows.length > 0;
  }
  return false;
}

/**
 * Hard tenant guard for any record fetch: the row must belong to the caller's
 * company. Use whenever a request supplies an id that maps to tenant data.
 */
function tenantRow(rows, tenantId, label = 'Record') {
  const row = Array.isArray(rows) ? rows[0] : rows;
  if (!row) throw new HttpError(404, `${label} not found`);
  if (tenantId != null && row.tenant_id != null && String(row.tenant_id) !== String(tenantId)) {
    throw new HttpError(404, `${label} not found`); // 404, never 403 — do not confirm existence
  }
  return row;
}

module.exports = {
  authenticate, requirePermission, requireAnyPermission, requireModuleEnabled, requireEntitlement,
  requirePlatformRole, requireTenantWritable, scopeFor, employeeScopeCondition,
  departmentRowCondition, headedDepartmentIds, canActOnEmployee, tenantOf, resolveTenantFor, tenantRow,
  departmentSubtree, invalidateRoleCache, loadRolePermissions, requestContext,
};