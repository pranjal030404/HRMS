/**
 * Roles, permissions and access review.
 *
 * Roles are rows, not code: any company can create unlimited custom roles, and
 * the permission catalog is the single vocabulary shared by roles, permission
 * groups and direct grants. The escalation ceiling from `services/rbac` applies
 * to every write here.
 */
const express = require('express');
const { pool } = require('../../config/db');
const { asyncH, HttpError } = require('../../utils/helpers');
const { requirePermission, invalidateRoleCache, canActOnEmployee } = require('../../middleware/auth');
const { tenantId, writeTenantId, audit, int } = require('./_shared');
const rbac = require('../../services/rbac');
const { PERMISSION_CATALOG, SCOPES, MODULE_CATALOG, PERMISSION_ALIASES } = require('../../utils/permissions');

const r = express.Router();

const ROLES_READ = requirePermission('administration.roles.view', { anyOf: ['settings.view'] });
const ROLES_WRITE = requirePermission('administration.roles.manage', { anyOf: ['role.manage'] });
const PERMS_READ = requirePermission('administration.permissions.view', { anyOf: ['settings.view'] });
// `administration.access.*` is the umbrella for a company's *own* access review.
// It deliberately cannot reach the cross-tenant company list.
const ACCESS_READ = requirePermission('administration.access_preview.view', { anyOf: ['administration.access.view', 'administration.users.view', 'user.manage'] });

/** Load a role inside the caller's company, with its resolved permission set. */
async function loadRole(req, id) {
  const t = tenantId(req);
  const role = await rbac.resolveRole(t, id);
  if (!role || role.id == null) throw new HttpError(404, 'Role not found');
  if (role.tenant_id != null && String(role.tenant_id) !== String(t)) throw new HttpError(404, 'Role not found');
  return role;
}

// ---------------------------------------------------------------- catalog
r.get('/permissions/catalog', PERMS_READ, asyncH(async (req, res) => {
  const data = await rbac.permissionCatalog({ q: req.query.q, module: req.query.module, scope: req.query.scope });
  res.json({ data: data.permissions, meta: { modules: data.modules, scopes: data.scopes, total: data.permissions.length, aliases: Object.keys(PERMISSION_ALIASES).length } });
}));

/** The matrix: modules → base permissions → scopes. Drives the role editor UI. */
r.get('/permissions/matrix', PERMS_READ, asyncH(async (req, res) => {
  const data = await rbac.permissionMatrix({ module: req.query.module });
  res.json({ data, meta: { modules: MODULE_CATALOG.map((m) => ({ key: m.key, name: m.name })), scopes: SCOPES } });
}));

// ---------------------------------------------------------------- roles
r.get('/roles', ROLES_READ, asyncH(async (req, res) => {
  const t = tenantId(req);
  const roles = await rbac.loadRoles(t);
  const [users] = await pool.query(
    `SELECT ur.role_id, COUNT(*) AS c FROM user_roles ur WHERE ur.tenant_id = ? GROUP BY ur.role_id`, [t]
  );
  const countBy = new Map(users.map((u) => [u.role_id, Number(u.c)]));
  const [groupRows] = await pool.query(
    `SELECT role_id, COUNT(*) AS c FROM role_permission_groups WHERE tenant_id = ? GROUP BY role_id`, [t]
  );
  const groupBy = new Map(groupRows.map((g) => [g.role_id, Number(g.c)]));
  const data = [...new Map([...roles.values()].map((x) => [x.id ?? x.name, x])).values()]
    .filter((x) => x.id != null && (x.tenant_id == null || String(x.tenant_id) === String(t)))
    .map((x) => ({
      ...rbac.roleSummary(x),
      tenantScoped: x.tenant_id != null,
      userCount: countBy.get(x.id) || 0,
      groupCount: groupBy.get(x.id) || 0,
      permissions: [...x.perms].sort(),
    }))
    .sort((a, b) => (a.label || '').localeCompare(b.label || ''));
  res.json({ data });
}));

/** Which roles the caller may hand out right now (drives assignment dropdowns). */
r.get('/roles/assignable', ROLES_READ, asyncH(async (req, res) => {
  const list = await rbac.assignableRoles(req.user);
  res.json({ data: list.map((x) => rbac.roleSummary(x)) });
}));

/** Compare two roles: shared, exclusive and scope differences. */
r.get('/roles/compare', ROLES_READ, asyncH(async (req, res) => {
  const { a, b } = req.query;
  if (!a || !b) throw new HttpError(400, 'Two roles are required (a and b) — id, name or code');
  res.json({ data: await rbac.compareRoles(tenantId(req), a, b) });
}));

r.get('/roles/:id', ROLES_READ, asyncH(async (req, res) => {
  const role = await loadRole(req, req.params.id);
  const groups = await rbac.groupsForRole(role.id);
  const [[{ users }]] = await pool.query('SELECT COUNT(*) AS users FROM user_roles WHERE role_id = ?', [role.id]);
  // Anything this role grants beyond the caller's own reach.
  const beyond = req.user.isPlatformSuperAdmin ? [] : rbac.privilegeExcess(req.user.permissions || [], role.perms);
  res.json({
    data: {
      ...rbac.roleSummary(role),
      description: role.description,
      permissions: [...role.perms].sort(),
      groups,
      userCount: Number(users),
      editable: rbac.canManageRoleObject(req.user) && beyond.length === 0 && (role.tenant_id != null || req.user.isPlatformSuperAdmin),
      beyondYourAccess: beyond,
    },
  });
}));

r.post('/roles', ROLES_WRITE, asyncH(async (req, res) => {
  const t = writeTenantId(req);
  const { name, code, label, description, permissions = [], group_ids = [] } = req.body || {};
  const roleName = String(name || '').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_');
  if (!roleName) throw new HttpError(400, 'A role name is required');
  const [dupe] = await pool.query('SELECT id FROM roles WHERE tenant_id = ? AND name = ?', [t, roleName]);
  if (dupe[0]) throw new HttpError(409, 'A role with that name already exists');

  // The new role may never exceed the creator's own reach.
  const excess = rbac.privilegeExcess(req.user.permissions || [], permissions);
  if (excess.length && !req.user.isPlatformSuperAdmin) {
    throw new HttpError(403, `These permissions exceed your own access: ${excess.slice(0, 5).map((e) => e.base).join(', ')}`);
  }

  const [ins] = await pool.query(
    `INSERT INTO roles (tenant_id, name, code, label, description, role_type, is_system, is_custom, is_protected, status, permissions, created_by)
     VALUES (?,?,?,?,?, 'custom', 0, 1, 0, 'active', ?, ?)`,
    [t, roleName, String(code || roleName).trim().toLowerCase(), label || name || roleName, description || null,
      JSON.stringify([...new Set(permissions)]), req.user.id]
  );
  await rbac.writeRolePermissions(t, ins.insertId, permissions, req.user.id);
  if (Array.isArray(group_ids) && group_ids.length) await rbac.writeRoleGroups(t, ins.insertId, group_ids, req.user.id);
  await audit(req, { action: 'role.create', entityType: 'role', entityId: ins.insertId, after: { name: roleName, permissions: permissions.length } });
  res.status(201).json({ data: { id: ins.insertId, name: roleName } });
}));

r.put('/roles/:id', ROLES_WRITE, asyncH(async (req, res) => {
  const t = writeTenantId(req);
  const role = await loadRole(req, req.params.id);
  await rbac.assertCanManageRole(req.user, role);
  const { label, description, status, permissions, group_ids } = req.body || {};

  const sets = []; const vals = [];
  if (label !== undefined) { sets.push('label = ?'); vals.push(label); }
  if (description !== undefined) { sets.push('description = ?'); vals.push(description); }
  if (status !== undefined) {
    if (!['active', 'inactive'].includes(status)) throw new HttpError(400, 'status must be active or inactive');
    if (status === 'inactive' && role.name === 'company_owner') {
      const [[{ owners }]] = await pool.query(
        `SELECT COUNT(*) AS owners FROM users u WHERE u.tenant_id = ? AND u.status = 'active'
          AND (u.role = 'company_owner' OR u.id IN (SELECT user_id FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE r.name = 'company_owner'))`,
        [t]
      );
      if (Number(owners) <= 0) throw new HttpError(400, 'The Company Owner role cannot be deactivated while it is in use');
    }
    sets.push('status = ?'); vals.push(status);
  }
  if (sets.length) {
    vals.push(role.id, t);
    await pool.query(`UPDATE roles SET ${sets.join(', ')} WHERE id = ? AND tenant_id = ?`, vals);
  }

  if (Array.isArray(permissions)) {
    // The edited role must still not exceed the editor's reach.
    const excess = rbac.privilegeExcess(req.user.permissions || [], permissions);
    if (excess.length && !req.user.isPlatformSuperAdmin) {
      throw new HttpError(403, `These permissions exceed your own access: ${excess.slice(0, 5).map((e) => e.base).join(', ')}`);
    }
    await rbac.writeRolePermissions(t, role.id, permissions, req.user.id);
  }
  if (Array.isArray(group_ids)) await rbac.writeRoleGroups(t, role.id, group_ids, req.user.id);

  invalidateRoleCache();
  await audit(req, { action: 'role.update', entityType: 'role', entityId: role.id, before: rbac.roleSummary(role), after: { label, description, status, permissions: permissions?.length } });
  res.json({ ok: true });
}));

r.delete('/roles/:id', ROLES_WRITE, asyncH(async (req, res) => {
  const t = writeTenantId(req);
  const role = await loadRole(req, req.params.id);
  await rbac.assertCanManageRole(req.user, role);
  if (role.is_system) throw new HttpError(400, 'System roles cannot be deleted — clone it instead');
  const [[{ assigned }]] = await pool.query('SELECT COUNT(*) AS assigned FROM user_roles WHERE role_id = ?', [role.id]);
  if (Number(assigned) > 0) {
    throw new HttpError(400, `${assigned} user(s) still hold this role — reassign them first`);
  }
  await pool.query('DELETE FROM role_permissions WHERE role_id = ?', [role.id]);
  await pool.query('DELETE FROM role_permission_groups WHERE role_id = ?', [role.id]);
  await pool.query('DELETE FROM roles WHERE id = ? AND tenant_id = ?', [role.id, t]);
  invalidateRoleCache();
  await audit(req, { action: 'role.delete', entityType: 'role', entityId: role.id, before: rbac.roleSummary(role) });
  res.json({ ok: true });
}));

/** Clone a role — the safe way to build a variant of a system role. */
r.post('/roles/:id/clone', ROLES_WRITE, asyncH(async (req, res) => {
  const t = writeTenantId(req);
  const role = await loadRole(req, req.params.id);
  const id = await rbac.cloneRole({ tenantId: t, roleId: role.id, newName: req.body?.name, newCode: req.body?.code, actor: req.user });
  invalidateRoleCache();
  await audit(req, { action: 'role.clone', entityType: 'role', entityId: id, after: { from: role.name, name: req.body?.name } });
  res.status(201).json({ data: { id, name: req.body?.name } });
}));

// ---------------------------------------------------------------- groups
r.get('/permission-groups', PERMS_READ, asyncH(async (req, res) => {
  res.json({ data: await rbac.groupsForTenant(tenantId(req)) });
}));

r.post('/permission-groups', ROLES_WRITE, asyncH(async (req, res) => {
  const t = writeTenantId(req);
  const { code, name, description } = req.body || {};
  if (!name) throw new HttpError(400, 'A group name is required');
  const groupCode = String(code || name).trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_');
  const [dupe] = await pool.query('SELECT id FROM permission_groups WHERE tenant_id = ? AND code = ?', [t, groupCode]);
  if (dupe[0]) throw new HttpError(409, 'A permission group with that code already exists');
  const [ins] = await pool.query(
    `INSERT INTO permission_groups (tenant_id, code, name, description, is_system, status, created_by)
     VALUES (?,?,?,?,0,'active',?)`,
    [t, groupCode, name, description || null, req.user.id]
  );
  await audit(req, { action: 'permission_group.create', entityType: 'permission_group', entityId: ins.insertId, after: { code: groupCode, name } });
  res.status(201).json({ data: { id: ins.insertId, code: groupCode } });
}));

r.put('/permission-groups/:id/permissions', ROLES_WRITE, asyncH(async (req, res) => {
  const t = writeTenantId(req);
  const { permissions = [] } = req.body || {};
  const [rows] = await pool.query(
    'SELECT * FROM permission_groups WHERE id = ? AND (tenant_id = ? OR tenant_id IS NULL)', [int(req.params.id), t]
  );
  if (!rows[0]) throw new HttpError(404, 'Permission group not found');
  if (rows[0].tenant_id === null && !req.user.isPlatformSuperAdmin) {
    throw new HttpError(403, 'Platform permission groups cannot be edited by a company administrator');
  }
  const excess = rbac.privilegeExcess(req.user.permissions || [], permissions);
  if (excess.length && !req.user.isPlatformSuperAdmin) {
    throw new HttpError(403, `These permissions exceed your own access: ${excess.slice(0, 5).map((e) => e.base).join(', ')}`);
  }
  const [known] = await pool.query('SELECT id, pkey FROM permissions WHERE pkey IN (?)', [[...new Set(permissions)]]);
  const unknown = [...new Set(permissions)].filter((p) => !known.some((k) => k.pkey === p));
  if (unknown.length) throw new HttpError(400, `Unknown permission(s): ${unknown.join(', ')}`);
  await pool.query('DELETE FROM permission_group_permissions WHERE group_id = ?', [rows[0].id]);
  await insertRows('permission_group_permissions',
    ['tenant_id', 'group_id', 'permission_id'],
    known.map((k) => [rows[0].tenant_id, rows[0].id, k.id]));
  rbac.invalidateAll();
  await audit(req, { action: 'permission_group.permissions', entityType: 'permission_group', entityId: rows[0].id, after: { count: known.length } });
  res.json({ ok: true });
}));

r.delete('/permission-groups/:id', ROLES_WRITE, asyncH(async (req, res) => {
  const t = writeTenantId(req);
  const [rows] = await pool.query('SELECT * FROM permission_groups WHERE id = ? AND tenant_id = ?', [int(req.params.id), t]);
  if (!rows[0]) throw new HttpError(404, 'Permission group not found');
  if (rows[0].is_system) throw new HttpError(400, 'System permission groups cannot be deleted');
  const [[{ linked }]] = await pool.query('SELECT COUNT(*) AS linked FROM role_permission_groups WHERE group_id = ?', [rows[0].id]);
  if (Number(linked) > 0) throw new HttpError(400, `${linked} role(s) still use this group`);
  await pool.query('DELETE FROM permission_group_permissions WHERE group_id = ?', [rows[0].id]);
  await pool.query('DELETE FROM permission_groups WHERE id = ? AND tenant_id = ?', [rows[0].id, t]);
  rbac.invalidateAll();
  await audit(req, { action: 'permission_group.delete', entityType: 'permission_group', entityId: rows[0].id, before: rows[0] });
  res.json({ ok: true });
}));

// ---------------------------------------------------------------- access review
/** What can this person reach, and why? (roles, scopes, per-module verdicts) */
r.get('/access/preview/:userId', ACCESS_READ, asyncH(async (req, res) => {
  res.json({ data: await rbac.previewAccess(int(req.params.userId), tenantId(req)) });
}));

/** My own access — same report, for the signed-in user. */
r.get('/access/mine', asyncH(async (req, res) => {
  res.json({ data: await rbac.previewAccess(req.user.id, req.user.tenant_id) });
}));

/**
 * Why can I access this record? Returns the chain of reasoning for one
 * (permission, subject) pair so an admin never has to guess.
 */
r.get('/access/explain', ACCESS_READ, asyncH(async (req, res) => {
  const { user_id: userId, userId: userIdCamel, permission, employee_id: employeeId } = req.query;
  const targetUserId = userId ?? userIdCamel;
  const employee_id = employeeId;
  if (!permission) throw new HttpError(400, 'permission is required');
  const result = await rbac.explainAccess({
    tenantId: tenantId(req),
    userId: int(targetUserId || req.user.id),
    permission,
    subject: employee_id ? { employeeId: int(employee_id) } : undefined,
  });
  if (employee_id) {
    // Second question: does the *caller's* scope actually reach that employee?
    result.subjectReachable = await canActOnEmployee(req.user, String(permission).split(':')[0], int(employee_id));
    if (!result.subjectReachable) result.reasons.push('The caller\'s scope does not include this employee record');
  }
  res.json({ data: result });
}));

/** Cross-tenant probe: proves the boundary rather than assuming it. */
r.get('/access/tenant-check/:userId', requirePermission('platform.tenants.view', { anyOf: ['administration.users.view', 'user.manage'] }), asyncH(async (req, res) => {
  const target = int(req.params.userId);
  const [rows] = await pool.query('SELECT id, name, email, tenant_id FROM users WHERE id = ?', [target]);
  const t = tenantId(req);
  const sameTenant = rows[0] && rows[0].tenant_id != null && String(rows[0].tenant_id) === String(t);
  res.json({
    data: {
      userId: target,
      found: !!rows[0],
      sameTenant,
      canRead: sameTenant || req.user.isPlatformSuperAdmin,
      note: sameTenant
        ? 'The user belongs to your company — their details are readable.'
        : req.user.isPlatformSuperAdmin
          ? 'The user belongs to another company; platform administrators may inspect it.'
          : 'The user belongs to another company — treated as not found.',
    },
  });
}));

module.exports = r;
