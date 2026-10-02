/**
 * User Administration — logins, roles, direct grants, sessions and invitations.
 *
 * Safety rules enforced here (not in the UI):
 *   - a user can never change their own role, status or company;
 *   - the last active Company Owner in a company cannot be removed or demoted;
 *   - every targeted user must belong to the caller's company;
 *   - role grants go through the RBAC privilege ceiling, so nobody can hand out
 *     (or take on) more access than they hold.
 */
const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { pool } = require('../../config/db');
const { asyncH, HttpError } = require('../../utils/helpers');
const { requirePermission, invalidateRoleCache } = require('../../middleware/auth');
const { tenantId, writeTenantId, audit, int, bool, paging, decode, insertRows } = require('./_shared');
const rbac = require('../../services/rbac');

const r = express.Router();

const USERS_READ = requirePermission('administration.users.view', { anyOf: ['user.manage'] });
const USERS_WRITE = requirePermission('administration.users.manage', { anyOf: ['user.manage'] });
const INVITE = requirePermission('administration.users.invite', { anyOf: ['user.manage'] });

async function loadTargetUser(req, id) {
  const t = writeTenantId(req);
  const [rows] = await pool.query('SELECT * FROM users WHERE id = ?', [int(id)]);
  const user = rows[0];
  if (!user || user.tenant_id == null || String(user.tenant_id) !== String(t)) {
    throw new HttpError(404, 'User not found');
  }
  return user;
}

/** Roles of a user, mirrored into the legacy users.role column. */
async function syncLegacyRole(userId) {
  const [rows] = await pool.query(
    `SELECT r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id
     WHERE ur.user_id = ? ORDER BY ur.is_primary DESC, r.label LIMIT 1`, [userId]
  );
  if (rows[0]) {
    await pool.query('UPDATE users SET role = ? WHERE id = ?', [rows[0].name, userId]);
  }
  invalidateRoleCache();
  rbac.invalidateUser(userId);
}

// ---------------------------------------------------------------- listing
r.get('/users', USERS_READ, asyncH(async (req, res) => {
  const t = tenantId(req);
  const { limit, offset, page } = paging(req.query, 25);
  const where = ['u.tenant_id = ?'];
  const params = [t];
  if (req.query.q) {
    where.push('(u.name LIKE ? OR u.email LIKE ? OR e.employee_code LIKE ?)');
    params.push(`%${req.query.q}%`, `%${req.query.q}%`, `%${req.query.q}%`);
  }
  if (req.query.role) { where.push('u.role = ?'); params.push(req.query.role); }
  if (req.query.status) { where.push('u.status = ?'); params.push(req.query.status); }
  const base = `FROM users u LEFT JOIN employees e ON e.id = u.employee_id WHERE ${where.join(' AND ')}`;
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total ${base}`, params);
  const [rows] = await pool.query(
    `SELECT u.id, u.name, u.email, u.role, u.status, u.employee_id, u.last_login_at, u.must_change_password,
            u.locked_until, u.created_at, e.employee_code,
            (SELECT COUNT(*) FROM user_roles ur WHERE ur.user_id = u.id) AS role_count,
            (SELECT COUNT(*) FROM user_direct_permissions d WHERE d.user_id = u.id) AS direct_permission_count,
            (SELECT COUNT(*) FROM refresh_tokens rt WHERE rt.user_id = u.id AND rt.revoked_at IS NULL AND rt.expires_at > NOW()) AS active_sessions
     ${base} ORDER BY u.name LIMIT ${limit} OFFSET ${offset}`, params
  );
  res.json({ data: rows, meta: { total, page, pages: Math.ceil(total / limit), limit } });
}));

r.get('/users/:id', USERS_READ, asyncH(async (req, res) => {
  const user = await loadTargetUser(req, req.params.id);
  const [roles] = await pool.query(
    `SELECT ur.id AS assignment_id, ur.is_primary, ur.assigned_at, r.id AS role_id, r.name, r.label, r.description,
            r.is_system, r.is_custom,
            (SELECT COUNT(*) FROM role_permissions rp WHERE rp.role_id = r.id) AS permission_count
     FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ? ORDER BY ur.is_primary DESC, r.label`, [user.id]
  );
  const [direct] = await pool.query(
    `SELECT d.id, d.effect, d.reason, d.granted_at, p.pkey FROM user_direct_permissions d
     JOIN permissions p ON p.id = d.permission_id WHERE d.user_id = ? ORDER BY p.pkey`, [user.id]
  );
  const [sessions] = await pool.query(
    `SELECT id, user_agent, ip, created_at, expires_at, revoked_at FROM refresh_tokens
     WHERE user_id = ? ORDER BY created_at DESC LIMIT 20`, [user.id]
  );
  const effective = await rbac.effectivePermissions(user);
  const [employee] = user.employee_id
    ? await pool.query(
      `SELECT e.id, e.employee_code, e.first_name, e.last_name, e.email, e.status, e.joined_on,
              d.name AS department, ds.name AS designation, l.name AS location, p.title AS position
       FROM employees e
       LEFT JOIN departments d ON d.id = e.department_id
       LEFT JOIN designations ds ON ds.id = e.designation_id
       LEFT JOIN locations l ON l.id = e.location_id
       LEFT JOIN positions p ON p.id = e.position_id
       WHERE e.id = ?`, [user.employee_id])
    : [[]];
  res.json({
    data: {
      user: { ...user, password_hash: undefined },
      roles,
      directPermissions: direct,
      deniedPermissions: direct.filter((d) => d.effect === 'deny').map((d) => d.pkey),
      sessions,
      employee: employee[0] || null,
      effectivePermissions: effective.permissions,
      scopes: effective.scopes,
    },
  });
}));

// ---------------------------------------------------------------- create
r.post('/users', USERS_WRITE, asyncH(async (req, res) => {
  const t = writeTenantId(req);
  const { name, email, role, employee_id, sendInvite = true } = req.body || {};
  if (!name || !email || !role) throw new HttpError(400, 'name, email and role are required');
  const mail = String(email).toLowerCase().trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail)) throw new HttpError(400, 'A valid email address is required');

  const [exists] = await pool.query('SELECT id, tenant_id FROM users WHERE email = ?', [mail]);
  if (exists[0]) {
    if (String(exists[0].tenant_id) === String(t)) throw new HttpError(409, 'That email already has a login in this company');
    throw new HttpError(409, 'That email is already in use');
  }
  if (employee_id) {
    const [emp] = await pool.query('SELECT id FROM employees WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL', [int(employee_id), t]);
    if (!emp[0]) throw new HttpError(400, 'That employee does not belong to this company');
  }

  let roleId = null;
  if (role) {
    const roleRow = await rbac.resolveRole(t, role);
    if (!roleRow || roleRow.id == null) throw new HttpError(400, `Unknown role: ${role}`);
    await rbac.assertCanAssignRole(req.user, roleRow);
    roleId = roleRow.id;
  }

  // A fresh login starts unusable: the user must complete the invitation first.
  const tempPassword = `Av@${crypto.randomBytes(3).toString('hex')}`;
  const status = sendInvite ? 'invited' : 'active';
  const [ins] = await pool.query(
    `INSERT INTO users (tenant_id, employee_id, email, password_hash, name, role, status, must_change_password)
     VALUES (?,?,?,?,?,?,?,1)`,
    [t, int(employee_id), mail, await bcrypt.hash(tempPassword, 10), name, role, status]
  );
  if (roleId) {
    await pool.query(
      `INSERT IGNORE INTO user_roles (tenant_id, user_id, role_id, is_primary, assigned_by) VALUES (?,?,?,1,?)`,
      [t, ins.insertId, roleId, req.user.id]
    );
  }

  let invitation = null;
  if (sendInvite) {
    const token = crypto.randomBytes(24).toString('hex');
    const [inv] = await pool.query(
      `INSERT INTO user_invitations (tenant_id, email, name, role_id, employee_id, invited_by, token_hash, status, expires_at)
       VALUES (?,?,?,?,?,?,?, 'pending', DATE_ADD(NOW(), INTERVAL 7 DAY))`,
      [t, mail, name, roleId, int(employee_id), req.user.id, crypto.createHash('sha256').update(token).digest('hex')]
    );
    invitation = { id: inv.insertId, token, expiresInDays: 7 };
  }

  await audit(req, { action: 'user.create', entityType: 'user', entityId: ins.insertId, after: { email: mail, role, status } });
  res.status(201).json({
    data: { id: ins.insertId, email: mail, status },
    ...(invitation ? { invitation } : { tempPassword }),
  });
}));

// ---------------------------------------------------------------- update
r.put('/users/:id', USERS_WRITE, asyncH(async (req, res) => {
  const user = await loadTargetUser(req, req.params.id);
  const { name, status, employee_id } = req.body || {};
  const isSelf = Number(user.id) === Number(req.user.id);

  if (isSelf && status && status !== 'active') {
    throw new HttpError(400, 'You cannot change the status of your own login');
  }
  if (status && ['suspended', 'disabled', 'archived'].includes(status) && isSelf) {
    throw new HttpError(400, 'You cannot suspend your own login');
  }
  const [targetRoles] = await pool.query(
    `SELECT r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ?`, [user.id]
  );
  const isOwner = targetRoles.some((x) => x.name === 'company_owner') || user.role === 'company_owner';
  if (isOwner && status && status !== 'active') {
    const [[{ owners }]] = await pool.query(
      `SELECT COUNT(*) AS owners FROM users WHERE tenant_id = ? AND status = 'active'
       AND (role = 'company_owner' OR id IN (SELECT user_id FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE r.name = 'company_owner'))`,
      [user.tenant_id]
    );
    if (Number(owners) <= 1) throw new HttpError(400, 'This is the last active Company Owner — appoint another owner first');
  }

  const sets = []; const params = [];
  if (name) { sets.push('name = ?'); params.push(name); }
  if (status) { sets.push('status = ?'); params.push(status); }
  if (employee_id !== undefined) {
    if (int(employee_id)) {
      const [emp] = await pool.query('SELECT id FROM employees WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL', [int(employee_id), user.tenant_id]);
      if (!emp[0]) throw new HttpError(400, 'That employee does not belong to this company');
    }
    sets.push('employee_id = ?'); params.push(int(employee_id));
  }
  if (!sets.length) throw new HttpError(400, 'Nothing to update');

  // Disabling access ends every live session for that user.
  if (status && status !== 'active') {
    await pool.query('UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = ? AND revoked_at IS NULL', [user.id]);
  }

  params.push(user.id);
  await pool.query(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, params);
  rbac.invalidateUser(user.id);
  await audit(req, { action: 'user.update', entityType: 'user', entityId: user.id, before: { name: user.name, status: user.status, employee_id: user.employee_id }, after: { name, status, employee_id } });
  res.json({ ok: true });
}));

r.delete('/users/:id', USERS_WRITE, asyncH(async (req, res) => {
  const user = await loadTargetUser(req, req.params.id);
  if (Number(user.id) === Number(req.user.id)) throw new HttpError(400, 'You cannot remove your own login');
  if (user.role === 'company_owner') {
    const [[{ owners }]] = await pool.query(
      `SELECT COUNT(*) AS owners FROM users WHERE tenant_id = ? AND status = 'active' AND role = 'company_owner'`, [user.tenant_id]);
    if (Number(owners) <= 1) throw new HttpError(400, 'This is the last active Company Owner');
  }
  // Deactivate rather than delete: audit history and past approvals must survive.
  await pool.query("UPDATE users SET status = 'disabled' WHERE id = ?", [user.id]);
  await pool.query('UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = ? AND revoked_at IS NULL', [user.id]);
  rbac.invalidateUser(user.id);
  await audit(req, { action: 'user.disable', entityType: 'user', entityId: user.id, before: { status: user.status } });
  res.json({ ok: true });
}));

// ---------------------------------------------------------------- roles on a user
r.put('/users/:id/roles', USERS_WRITE, asyncH(async (req, res) => {
  const user = await loadTargetUser(req, req.params.id);
  const { role_ids, primary_role_id } = req.body || {};
  if (!Array.isArray(role_ids)) throw new HttpError(400, 'role_ids[] is required');
  const ids = [...new Set(role_ids.map((x) => int(x)).filter(Boolean))];
  if (!ids.length) throw new HttpError(400, 'At least one role is required');

  const [current] = await pool.query(
    `SELECT r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ?`, [user.id]
  );
  const wasOwner = current.some((x) => x.name === 'company_owner');
  const willHaveOwner = ids.length && (await Promise.all(ids.map(async (id) => {
    const role = await rbac.resolveRole(user.tenant_id, id);
    return role?.name === 'company_owner';
  }))).some(Boolean);
  if (wasOwner && !willHaveOwner) {
    const [[{ owners }]] = await pool.query(
      `SELECT COUNT(*) AS owners FROM users u WHERE u.tenant_id = ? AND u.status = 'active'
        AND (u.role = 'company_owner' OR u.id IN (SELECT user_id FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE r.name = 'company_owner'))`,
      [user.tenant_id]
    );
    if (Number(owners) <= 1) throw new HttpError(400, 'This is the last active Company Owner — appoint another owner first');
  }
  if (Number(user.id) === Number(req.user.id)) {
    throw new HttpError(400, 'You cannot change your own roles — ask another administrator');
  }

  // Every requested role must be assignable by the actor (privilege ceiling).
  const resolved = [];
  for (const id of ids) {
    const role = await rbac.resolveRole(user.tenant_id, id);
    if (!role || role.id == null) throw new HttpError(404, `Role ${id} not found`);
    await rbac.assertCanAssignRole(req.user, role);
    resolved.push(role);
  }

  await pool.query('DELETE FROM user_roles WHERE user_id = ?', [user.id]);
  await pool.query(
    'INSERT INTO user_roles (tenant_id, user_id, role_id, is_primary, assigned_by) VALUES ?',
    [ids.map((id) => [user.tenant_id, user.id, id, Number(id) === Number(primary_role_id) || (!primary_role_id && id === ids[0]) ? 1 : 0, req.user.id])]
  );
  await syncLegacyRole(user.id);
  await audit(req, { action: 'user.roles.update', entityType: 'user', entityId: user.id, before: current.map((x) => x.name), after: resolved.map((x) => x.name) });
  res.json({ ok: true, data: { roles: resolved.map((x) => ({ id: x.id, name: x.name, label: x.label })) } });
}));

r.delete('/users/:id/roles/:roleId', USERS_WRITE, asyncH(async (req, res) => {
  const user = await loadTargetUser(req, req.params.id);
  if (Number(user.id) === Number(req.user.id)) throw new HttpError(400, 'You cannot change your own roles');
  const role = await rbac.resolveRole(user.tenant_id, int(req.params.roleId));
  if (!role || role.id == null) throw new HttpError(404, 'Role not found');
  if (role.name === 'company_owner') {
    const [[{ owners }]] = await pool.query(
      `SELECT COUNT(*) AS owners FROM users u WHERE u.tenant_id = ? AND u.status = 'active'
        AND (u.role = 'company_owner' OR u.id IN (SELECT user_id FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE r.name = 'company_owner'))`,
      [user.tenant_id]
    );
    if (Number(owners) <= 1) throw new HttpError(400, 'This is the last active Company Owner');
  }
  const [[{ assigned }]] = await pool.query('SELECT COUNT(*) AS assigned FROM user_roles WHERE user_id = ?', [user.id]);
  if (Number(assigned) <= 1) throw new HttpError(400, 'A user must keep at least one role');
  await pool.query('DELETE FROM user_roles WHERE user_id = ? AND role_id = ?', [user.id, role.id]);
  await syncLegacyRole(user.id);
  await audit(req, { action: 'user.role.remove', entityType: 'user', entityId: user.id, after: { role: role.name } });
  res.json({ ok: true });
}));

// ---------------------------------------------------------------- direct grants
/**
 * PUT /users/:id/direct-permissions
 * Per-user exceptions on top of the roles: `allow` grants one permission to one
 * person, `deny` removes a permission a role would otherwise give. Both are
 * checked against the actor's own reach, so a direct grant can never exceed the
 * administrator handing it out.
 */
r.put('/users/:id/direct-permissions', USERS_WRITE, asyncH(async (req, res) => {
  const user = await loadTargetUser(req, req.params.id);
  if (Number(user.id) === Number(req.user.id)) {
    throw new HttpError(400, 'You cannot change your own direct permissions');
  }
  const body = req.body || {};
  const allow = [...(body.allow || body.allowed || [])];
  const deny = [...(body.deny || body.denied || body.denies || [])];
  // Granting needs reach; denying does not — a deny can only ever remove access,
  // and requiring the actor to hold the permission would make revocations impossible.
  const actorPerms = req.user.permissions || [];
  for (const key of allow) {
    if (!rbac.coversPermission(actorPerms, key)) {
      throw new HttpError(403, `You cannot grant "${key}" — you do not hold it yourself`);
    }
  }
  const keys = [...allow, ...deny];
  const known = new Map();
  if (keys.length) {
    const [all] = await pool.query('SELECT id, pkey FROM permissions WHERE pkey IN (?)', [keys]);
    for (const p of all) known.set(p.pkey, p.id);
    const unknown = keys.filter((k) => !known.has(k));
    if (unknown.length) throw new HttpError(400, `Unknown permission(s): ${unknown.join(', ')}`);
  }

  await pool.query('DELETE FROM user_direct_permissions WHERE user_id = ?', [user.id]);
  const rows = [
    ...allow.map((k) => [user.tenant_id, user.id, known.get(k), 'allow', 'Direct grant', req.user.id]),
    ...deny.map((k) => [user.tenant_id, user.id, known.get(k), 'deny', 'Direct deny', req.user.id]),
  ];
  if (rows.length) {
    // Explicit placeholders: mysql2 does not expand a `VALUES ?` array of arrays here.
    await pool.query(
      `INSERT INTO user_direct_permissions (tenant_id, user_id, permission_id, effect, reason, granted_by)
       VALUES ${rows.map(() => '(?,?,?,?,?,?)').join(', ')}`,
      rows.flat()
    );
  }
  rbac.invalidateUser(user.id);
  await audit(req, { action: 'user.direct_permissions', entityType: 'user', entityId: user.id, after: { allow, deny } });
  res.json({ ok: true, data: { allow, deny } });
}));

// ---------------------------------------------------------------- credentials & sessions
r.post('/users/:id/reset-password', USERS_WRITE, asyncH(async (req, res) => {
  const user = await loadTargetUser(req, req.params.id);
  const tempPassword = `Av@${crypto.randomBytes(3).toString('hex')}`;
  await pool.query('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?', [await bcrypt.hash(tempPassword, 10), user.id]);
  await pool.query('UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = ? AND revoked_at IS NULL', [user.id]);
  await audit(req, { action: 'user.reset_password', entityType: 'user', entityId: user.id });
  res.json({ ok: true, tempPassword });
}));

r.get('/users/:id/sessions', USERS_READ, asyncH(async (req, res) => {
  const user = await loadTargetUser(req, req.params.id);
  const [rows] = await pool.query(
    `SELECT id, user_agent, ip, created_at, expires_at, revoked_at FROM refresh_tokens
     WHERE user_id = ? ORDER BY (revoked_at IS NULL) DESC, created_at DESC LIMIT 50`, [user.id]
  );
  res.json({ data: rows });
}));

r.post('/users/:id/revoke-sessions', USERS_WRITE, asyncH(async (req, res) => {
  const user = await loadTargetUser(req, req.params.id);
  const sessionId = int(req.body?.session_id);
  if (sessionId) {
    const [res2] = await pool.query(
      'UPDATE refresh_tokens SET revoked_at = NOW() WHERE id = ? AND user_id = ? AND revoked_at IS NULL', [sessionId, user.id]
    );
    if (!res2.affectedRows) throw new HttpError(404, 'Session not found or already revoked');
  } else {
    const [res2] = await pool.query(
      'UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = ? AND revoked_at IS NULL', [user.id]
    );
    if (!res2.affectedRows) throw new HttpError(400, 'That user has no active sessions');
  }
  await audit(req, { action: 'user.sessions.revoke', entityType: 'user', entityId: user.id, after: { sessionId: sessionId || 'all' } });
  res.json({ ok: true });
}));

// ---------------------------------------------------------------- invitations
r.get('/invitations', USERS_READ, asyncH(async (req, res) => {
  const t = tenantId(req);
  const [rows] = await pool.query(
    `SELECT i.id, i.email, i.name, i.status, i.expires_at, i.created_at, i.accepted_at,
            r.name AS role_name, e.employee_code, u.id AS user_id,
            CONCAT(i2.name) AS invited_by_name
     FROM user_invitations i
     LEFT JOIN roles r ON r.id = i.role_id
     LEFT JOIN employees e ON e.id = i.employee_id
     LEFT JOIN users u ON u.email = i.email AND u.tenant_id = i.tenant_id
     LEFT JOIN users i2 ON i2.id = i.invited_by
     WHERE i.tenant_id = ? ORDER BY (i.status = 'pending') DESC, i.created_at DESC LIMIT 200`, [t]
  );
  res.json({ data: rows });
}));

/** POST /invitations — invite an existing user row to a different address. */
r.post('/invitations', INVITE, asyncH(async (req, res) => {
  const t = writeTenantId(req);
  const { email, name, role, employee_id } = req.body || {};
  const mail = String(email || '').toLowerCase().trim();
  if (!mail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail)) throw new HttpError(400, 'A valid email address is required');
  let roleId = null;
  if (role) {
    const roleRow = await rbac.resolveRole(t, role);
    if (!roleRow || roleRow.id == null) throw new HttpError(400, `Unknown role: ${role}`);
    await rbac.assertCanAssignRole(req.user, roleRow);
    roleId = roleRow.id;
  }
  const [pending] = await pool.query(
    "SELECT id FROM user_invitations WHERE tenant_id = ? AND email = ? AND status = 'pending'", [t, mail]
  );
  if (pending[0]) throw new HttpError(409, 'An invitation is already pending for that address');
  const token = crypto.randomBytes(24).toString('hex');
  const [ins] = await pool.query(
    `INSERT INTO user_invitations (tenant_id, email, name, role_id, employee_id, invited_by, token_hash, status, expires_at)
     VALUES (?,?,?,?,?,?,?, 'pending', DATE_ADD(NOW(), INTERVAL 7 DAY))`,
    [t, mail, name || null, roleId, int(employee_id), req.user.id, crypto.createHash('sha256').update(token).digest('hex')]
  );
  await audit(req, { action: 'user.invite', entityType: 'user_invitation', entityId: ins.insertId, after: { email: mail, role } });
  res.status(201).json({ data: { id: ins.insertId, token, expiresInDays: 7 } });
}));

r.post('/invitations/:id/revoke', USERS_WRITE, asyncH(async (req, res) => {
  const t = writeTenantId(req);
  const [rows] = await pool.query('SELECT * FROM user_invitations WHERE id = ? AND tenant_id = ?', [req.params.id, t]);
  if (!rows[0]) throw new HttpError(404, 'Invitation not found');
  await pool.query("UPDATE user_invitations SET status = 'revoked' WHERE id = ? AND tenant_id = ?", [req.params.id, t]);
  await audit(req, { action: 'user.invite.revoke', entityType: 'user_invitation', entityId: req.params.id, before: rows[0] });
  res.json({ ok: true });
}));

// -------------------------------------------------------- access requests
/**
 * Self-service access requests. A user asks for a permission they do not have;
 * an administrator approves (creating a direct grant) or denies it, with a reason.
 */
r.get('/access-requests', requirePermission('administration.access_requests.manage', { anyOf: ['administration.access.manage', 'administration.users.manage', 'user.manage'] }), asyncH(async (req, res) => {
  const t = tenantId(req);
  const where = ['ar.tenant_id = ?']; const params = [t];
  if (req.query.status) { where.push('ar.status = ?'); params.push(req.query.status); }
  const [rows] = await pool.query(
    `SELECT ar.*, u.name AS user_name, u.email AS user_email, p.pkey
     FROM access_requests ar
     JOIN users u ON u.id = ar.user_id
     LEFT JOIN permissions p ON p.id = ar.permission_id
     WHERE ${where.join(' AND ')} ORDER BY (ar.status = 'pending') DESC, ar.created_at DESC LIMIT 200`, params
  );
  res.json({ data: decode(rows, []) });
}));

r.put('/access-requests/:id', requirePermission('administration.access_requests.manage', { anyOf: ['administration.access.manage', 'administration.users.manage', 'user.manage'] }), asyncH(async (req, res) => {
  const t = writeTenantId(req);
  const { status } = req.body || {};
  // The UI and the API have both used "denied" and "rejected" for the same
  // decision. The column is an ENUM and only accepts 'rejected', so accept the
  // plain-English word from clients but always persist the vocabulary the schema
  // defines — otherwise a decision silently fails on write.
  const DECISIONS = { approved: 'approved', denied: 'rejected', rejected: 'rejected' };
  const decision = DECISIONS[String(status || '').toLowerCase()];
  if (!decision) throw new HttpError(400, 'status must be approved or denied');
  const [rows] = await pool.query('SELECT * FROM access_requests WHERE id = ? AND tenant_id = ?', [req.params.id, t]);
  const request = rows[0];
  if (!request) throw new HttpError(404, 'Access request not found');
  if (request.status !== 'pending') throw new HttpError(400, 'That request has already been decided');

  if (decision === 'approved' && request.permission_id) {
    const [perm] = await pool.query('SELECT pkey FROM permissions WHERE id = ?', [request.permission_id]);
    if (perm[0] && !rbac.coversPermission(req.user.permissions || [], perm[0].pkey)) {
      throw new HttpError(403, `You cannot approve "${perm[0].pkey}" — you do not hold it yourself`);
    }
    if (request.permission_id) {
      await pool.query(
        `INSERT INTO user_direct_permissions (tenant_id, user_id, permission_id, effect, reason, granted_by)
         VALUES (?,?,?,'allow',?,?)
         ON DUPLICATE KEY UPDATE effect = 'allow', granted_by = VALUES(granted_by)`,
        [t, request.user_id, request.permission_id, `Access request #${request.id}`, req.user.id]
      );
      rbac.invalidateUser(request.user_id);
    }
  }
  await pool.query('UPDATE access_requests SET status = ?, decided_by = ?, decided_at = NOW() WHERE id = ? AND tenant_id = ?',
    [decision, req.user.id, req.params.id, t]);
  await audit(req, { action: 'access_request.decision', entityType: 'access_request', entityId: req.params.id, before: request, after: { status: decision } });
  res.json({ ok: true });
}));

module.exports = r;
