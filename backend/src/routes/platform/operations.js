/**
 * Control-plane operations: platform operators, platform security, and the
 * per-company tabs (users, roles, security, branding, domains, integrations,
 * audit, support, configuration).
 *
 * Mounted by `./index.js`, which has already applied `authenticate` and
 * `requirePlatformRole`. Anything addressed to a specific company goes through
 * `tenantReach` — i.e. it needs a live Support Access session — except the writes
 * that are ARTHVEX acting on the customer (revoking a leaked API key, for
 * instance), which are permission-gated, reasoned and audited instead.
 *
 * Secrets never leave this file: password hashes, MFA secrets, API key hashes and
 * webhook secrets are not selected.
 */
const express = require('express');
const crypto = require('crypto');
const dns = require('dns').promises;
const bcrypt = require('bcryptjs');
const { pool } = require('../../config/db');
const { asyncH, HttpError } = require('../../utils/helpers');
const { requirePermission } = require('../../middleware/auth');
const rbac = require('../../services/rbac');
const platformAudit = require('../../services/platformAudit');
const platformSecurity = require('../../services/platformSecurity');
const supportAccess = require('../../services/supportAccess');
const { PLATFORM_ROLE_KEYS, PLATFORM_PERMISSIONS, ROLE_DEFS } = require('../../utils/permissions');

const int = (v, d = null) => (v === undefined || v === null || v === '' || Number.isNaN(Number(v)) ? d : parseInt(v, 10));
const unj = (v, d) => {
  if (v === null || v === undefined) return d;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return d; }
};
const needReason = (reason, min = 5) => {
  const r = String(reason || '').trim();
  if (r.length < min) throw new HttpError(400, `A reason of at least ${min} characters is required — it is recorded in the audit trail`);
  return r;
};

const validRoleKeyFn = async (k) => PLATFORM_ROLE_KEYS.includes(k) || (await customRoles()).some((c) => c.key === k);
async function customRoles() {
  const [rows] = await pool.query(
    "SELECT name, label, description, permissions FROM roles WHERE tenant_id IS NULL AND is_custom = 1 AND role_type = 'platform' AND status = 'active' ORDER BY label");
  return rows.map((r) => ({
    key: r.name, label: r.label, description: r.description,
    permissions: Array.isArray(r.permissions) ? r.permissions : JSON.parse(r.permissions || '[]'),
  }));
}

module.exports = function operationsRouter({ tenantReach }) {
  const r = express.Router();
  const validRoleKey = validRoleKeyFn;

  // ======================================================== platform operators
  r.get('/operators', requirePermission('platform.users.view'), asyncH(async (req, res) => {
    const [rows] = await pool.query(
      `SELECT id, name, email, role, status, mfa_enabled, last_login_at, created_at
         FROM users WHERE tenant_id IS NULL ORDER BY created_at`
    );
    res.json({
      data: rows.map((u) => ({ ...u, roleLabel: ROLE_DEFS[u.role]?.label || u.role })),
      roles: [...PLATFORM_ROLE_KEYS.map((k) => ({ key: k, label: ROLE_DEFS[k]?.label || k })), ...(await customRoles()).map((c) => ({ key: c.key, label: c.label }))],
    });
  }));

  /**
   * GET /health — real measurements only: database round-trip, webhook delivery
   * outcomes over the last 24h, and the support / deletion queues. Nothing here is
   * a placeholder; a number that cannot be measured is simply absent.
   */
  r.get('/health', requirePermission('platform.dashboard.view'), asyncH(async (req, res) => {
    const t0 = Date.now();
    await pool.query('SELECT 1');
    const dbMs = Date.now() - t0;
    const [hooks] = await pool.query(
      `SELECT status, COUNT(*) AS n FROM webhook_deliveries WHERE created_at > DATE_SUB(NOW(), INTERVAL 24 HOUR) GROUP BY status`);
    const [[sup]] = await pool.query("SELECT COUNT(*) AS n FROM support_access_sessions WHERE status = 'active' AND expires_at > NOW()");
    const [[del]] = await pool.query("SELECT COUNT(*) AS n FROM tenant_deletion_requests WHERE status IN ('requested','scheduled')");
    const [[exp]] = await pool.query("SELECT COUNT(*) AS n FROM data_export_requests WHERE status IN ('requested','running')").catch(() => [[{ n: null }]]);
    const byStatus = Object.fromEntries(hooks.map((h) => [h.status, Number(h.n)]));
    res.json({
      data: {
        api: { ok: true, uptimeSeconds: Math.round(process.uptime()) },
        database: { ok: true, latencyMs: dbMs },
        webhooks24h: { success: byStatus.success || 0, failed: byStatus.failed || 0, dead: byStatus.dead || 0, pending: byStatus.pending || 0 },
        queues: { activeSupportSessions: Number(sup.n), openDeletionRequests: Number(del.n), pendingExports: exp.n === null ? null : Number(exp.n) },
        checkedAt: new Date().toISOString(),
      },
    });
  }));

  /** The platform role catalogue: each role's permissions and how many operators hold it. */
  r.get('/roles', requirePermission('platform.users.view'), asyncH(async (req, res) => {
    const [counts] = await pool.query(
      `SELECT role, COUNT(*) AS n FROM users WHERE tenant_id IS NULL AND status = 'active' GROUP BY role`
    );
    const byRole = Object.fromEntries(counts.map((c) => [c.role, Number(c.n)]));
    const custom = await customRoles();
    res.json({
      data: [
        ...PLATFORM_ROLE_KEYS.map((k) => ({
          key: k, label: ROLE_DEFS[k]?.label || k, operators: byRole[k] || 0,
          permissions: ROLE_DEFS[k]?.permissions || [], isSystem: true,
        })),
        ...custom.map((c) => ({ ...c, operators: byRole[c.key] || 0, isSystem: false })),
      ],
      permissions: PLATFORM_PERMISSIONS,
    });
  }));

  const roleKeyOf = (label) => 'platform_custom_' + String(label).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30);
  function cleanPerms(input, actor) {
    const list = [...new Set(Array.isArray(input) ? input : [])];
    const bad = list.filter((p) => !PLATFORM_PERMISSIONS.includes(p));
    if (bad.length) throw new HttpError(400, `Unknown platform permission: ${bad[0]}`);
    if (!list.length) throw new HttpError(400, 'Pick at least one permission');
    // Privilege ceiling: nobody can mint a role stronger than their own.
    const mine = new Set(actor.permissions || []);
    const over = list.filter((p) => !mine.has(p));
    if (over.length) throw new HttpError(403, `You cannot grant a permission you do not hold: ${over[0]}`);
    return list;
  }

  r.post('/roles', requirePermission('platform.users.manage'), asyncH(async (req, res) => {
    const label = String(req.body?.label || '').trim();
    const reason = needReason(req.body?.reason);
    if (label.length < 3) throw new HttpError(400, 'A role name of at least 3 characters is required');
    const permissions = cleanPerms(req.body?.permissions, req.user);
    const key = roleKeyOf(label);
    const [dupe] = await pool.query('SELECT id FROM roles WHERE name = ? AND tenant_id IS NULL', [key]);
    if (dupe[0] || PLATFORM_ROLE_KEYS.includes(key)) throw new HttpError(409, 'A platform role with that name already exists');
    const [ins] = await pool.query(
      `INSERT INTO roles (tenant_id, name, code, label, description, permissions, is_system, is_protected, is_custom, role_type, status, created_by)
       VALUES (NULL,?,?,?,?,?,0,0,1,'platform','active',?)`,
      [key, key, label, String(req.body?.description || '').slice(0, 250) || null, JSON.stringify(permissions), req.user.id]
    );
    rbac.invalidateAll();
    await platformAudit.logPlatformAudit({
      actor: req.user, action: 'security.platform_role_created', category: 'security',
      entityType: 'platform_role', entityId: ins.insertId, after: { key, label, permissions }, reason, req,
    });
    res.status(201).json({ data: { key, label, permissions } });
  }));

  r.put('/roles/:key', requirePermission('platform.users.manage'), asyncH(async (req, res) => {
    const key = String(req.params.key);
    const reason = needReason(req.body?.reason);
    const [[role]] = await pool.query(
      "SELECT id, label, permissions FROM roles WHERE name = ? AND tenant_id IS NULL AND is_custom = 1 AND role_type = 'platform'", [key]);
    if (!role) throw new HttpError(404, 'Custom platform role not found (built-in roles cannot be edited)');
    const permissions = cleanPerms(req.body?.permissions, req.user);
    const label = String(req.body?.label || role.label).trim();
    await pool.query('UPDATE roles SET label = ?, description = ?, permissions = ?, updated_by = ? WHERE id = ?',
      [label, String(req.body?.description || '').slice(0, 250) || null, JSON.stringify(permissions), req.user.id, role.id]);
    rbac.invalidateAll();
    await platformAudit.logPlatformAudit({
      actor: req.user, action: 'security.platform_role_updated', category: 'security',
      entityType: 'platform_role', entityId: role.id,
      before: { label: role.label, permissions: role.permissions }, after: { label, permissions }, reason, req,
    });
    res.json({ data: { key, label, permissions } });
  }));

  r.delete('/roles/:key', requirePermission('platform.users.manage'), asyncH(async (req, res) => {
    const key = String(req.params.key);
    const reason = needReason(req.body?.reason ?? req.query?.reason);
    const [[role]] = await pool.query(
      "SELECT id, label FROM roles WHERE name = ? AND tenant_id IS NULL AND is_custom = 1 AND role_type = 'platform'", [key]);
    if (!role) throw new HttpError(404, 'Custom platform role not found (built-in roles cannot be deleted)');
    const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM users WHERE tenant_id IS NULL AND role = ?', [key]);
    if (Number(n)) throw new HttpError(409, `${n} operator(s) still hold this role — reassign them first`);
    await pool.query('DELETE FROM roles WHERE id = ?', [role.id]);
    rbac.invalidateAll();
    await platformAudit.logPlatformAudit({
      actor: req.user, action: 'security.platform_role_deleted', category: 'security',
      entityType: 'platform_role', entityId: role.id, before: { key, label: role.label }, reason, req,
    });
    res.json({ data: { key } });
  }));

  r.post('/operators', requirePermission('platform.users.manage'), asyncH(async (req, res) => {
    const { name, email, role } = req.body || {};
    const reason = needReason(req.body?.reason);
    if (!name || !email) throw new HttpError(400, 'name and email are required');
    if (!(await validRoleKey(role))) throw new HttpError(400, 'Unknown platform role');
    const emailNorm = String(email).toLowerCase().trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(emailNorm)) throw new HttpError(400, 'That is not a valid email address');
    const [dupe] = await pool.query('SELECT id FROM users WHERE email = ?', [emailNorm]);
    if (dupe[0]) throw new HttpError(409, 'An account with that email already exists');
    const tempPassword = `Av@${crypto.randomBytes(5).toString('hex')}`;
    const [ins] = await pool.query(
      `INSERT INTO users (tenant_id, email, password_hash, name, role, status, must_change_password)
       VALUES (NULL,?,?,?,?, 'active', 1)`,
      [emailNorm, await bcrypt.hash(tempPassword, 10), String(name).trim(), role]
    );
    await platformAudit.logPlatformAudit({
      actor: req.user, action: 'security.operator_created', category: 'security',
      entityType: 'platform_user', entityId: ins.insertId, after: { email: emailNorm, role }, reason, req,
    });
    // The temporary password is shown once, here, and stored nowhere in clear.
    res.status(201).json({ data: { id: ins.insertId, email: emailNorm, role }, tempPassword });
  }));

  r.patch('/operators/:id', requirePermission('platform.users.manage'), asyncH(async (req, res) => {
    const id = int(req.params.id);
    const reason = needReason(req.body?.reason);
    const [[u]] = await pool.query('SELECT id, email, role, status FROM users WHERE id = ? AND tenant_id IS NULL', [id]);
    if (!u) throw new HttpError(404, 'Platform operator not found');
    const { role, status } = req.body || {};
    const next = { role: role ?? u.role, status: status ?? u.status };
    if (!(await validRoleKey(next.role))) throw new HttpError(400, 'Unknown platform role');
    if (!['active', 'disabled'].includes(next.status)) throw new HttpError(400, 'status must be active or disabled');
    if (id === req.user.id && (next.status !== 'active' || next.role !== u.role)) {
      throw new HttpError(400, 'You cannot change your own role or disable your own account');
    }
    if (u.role === 'platform_super_admin' && (next.role !== u.role || next.status !== 'active')) {
      const [[{ n }]] = await pool.query(
        `SELECT COUNT(*) AS n FROM users WHERE tenant_id IS NULL AND role = 'platform_super_admin' AND status = 'active' AND id <> ?`, [id]
      );
      if (!Number(n)) throw new HttpError(400, 'At least one active Platform Super Admin must remain');
    }
    await pool.query('UPDATE users SET role = ?, status = ? WHERE id = ?', [next.role, next.status, id]);
    if (next.status !== 'active') {
      await pool.query('UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = ? AND revoked_at IS NULL', [id]);
    }
    await platformAudit.logPlatformAudit({
      actor: req.user,
      action: next.status !== u.status ? (next.status === 'active' ? 'security.operator_enabled' : 'security.operator_disabled') : 'security.operator_role_changed',
      category: 'security', entityType: 'platform_user', entityId: id,
      before: { role: u.role, status: u.status }, after: next, reason, req,
    });
    res.json({ data: { id, ...next } });
  }));

  r.post('/operators/:id/reset-mfa', requirePermission('platform.users.manage'), asyncH(async (req, res) => {
    const id = int(req.params.id);
    const reason = needReason(req.body?.reason);
    const [[u]] = await pool.query('SELECT id, email FROM users WHERE id = ? AND tenant_id IS NULL', [id]);
    if (!u) throw new HttpError(404, 'Platform operator not found');
    await pool.query('UPDATE users SET mfa_enabled = 0, mfa_secret = NULL WHERE id = ?', [id]);
    await pool.query('UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = ? AND revoked_at IS NULL', [id]);
    await platformAudit.logPlatformAudit({
      actor: req.user, action: 'security.operator_mfa_reset', category: 'security',
      entityType: 'platform_user', entityId: id, after: { email: u.email }, reason, req,
    });
    res.json({ ok: true });
  }));

  // ======================================================== platform security
  r.get('/security', requirePermission('platform.security.view'), asyncH(async (req, res) => {
    const policy = await platformSecurity.getPolicy({ fresh: true });
    const [sessions] = await pool.query(
      `SELECT rt.id, rt.user_id, u.name, u.email, u.role, rt.ip, rt.user_agent, rt.created_at, rt.expires_at
         FROM refresh_tokens rt JOIN users u ON u.id = rt.user_id
        WHERE u.tenant_id IS NULL AND rt.revoked_at IS NULL AND rt.expires_at > NOW()
        ORDER BY rt.created_at DESC LIMIT 200`
    );
    const [events] = await pool.query(
      `SELECT le.id, le.email, le.event, le.ip, le.user_agent, le.details, le.created_at
         FROM login_events le LEFT JOIN users u ON u.id = le.user_id
        WHERE le.tenant_id IS NULL AND (u.tenant_id IS NULL OR le.user_id IS NULL)
        ORDER BY le.created_at DESC LIMIT 100`
    );
    const [[ops]] = await pool.query(
      `SELECT COUNT(*) AS total, COALESCE(SUM(mfa_enabled = 1), 0) AS withMfa
         FROM users WHERE tenant_id IS NULL AND status = 'active'`
    );
    const [[fails]] = await pool.query(
      `SELECT COUNT(*) AS n FROM login_events WHERE tenant_id IS NULL
          AND event IN ('login_failed','mfa_failed','suspicious') AND created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)`
    );
    res.json({
      data: {
        policy,
        yourIp: platformSecurity.cleanIp(req.ip),
        operators: { total: Number(ops.total), withMfa: Number(ops.withMfa) },
        failedLast24h: Number(fails.n),
        sessions, events,
      },
    });
  }));

  r.put('/security/policy', requirePermission('platform.security.manage'), asyncH(async (req, res) => {
    const reason = needReason(req.body?.reason);
    const before = await platformSecurity.getPolicy({ fresh: true });
    const { mfaRequired, ipAllowlist, sessionMaxHours } = req.body || {};
    if (ipAllowlist !== undefined) {
      if (!Array.isArray(ipAllowlist)) throw new HttpError(400, 'ipAllowlist must be a list');
      // Refuse the one change that locks the caller out of the console they are using.
      const probe = { ipAllowlist: ipAllowlist.map((c) => platformSecurity.normaliseCidr(c)).filter(Boolean) };
      if (probe.ipAllowlist.length && !platformSecurity.ipAllowed(probe, req.ip)) {
        throw new HttpError(400, `That allowlist would lock you out: your address ${platformSecurity.cleanIp(req.ip)} is not in it`);
      }
    }
    if (mfaRequired === true && !req.user.mfa_enabled) {
      throw new HttpError(400, 'Enrol MFA on your own account before making it mandatory — otherwise you would lock yourself out');
    }
    const after = await platformSecurity.setPolicy({ mfaRequired, ipAllowlist, sessionMaxHours }, req.user.id);
    await platformAudit.logPlatformAudit({
      actor: req.user, action: 'security.policy_changed', category: 'security',
      entityType: 'platform_security_policy', before, after, reason, req,
    });
    res.json({ data: after });
  }));

  r.post('/security/sessions/:id/revoke', requirePermission('platform.security.manage'), asyncH(async (req, res) => {
    const reason = needReason(req.body?.reason);
    const [[s]] = await pool.query(
      `SELECT rt.id, rt.user_id, u.email FROM refresh_tokens rt JOIN users u ON u.id = rt.user_id
        WHERE rt.id = ? AND u.tenant_id IS NULL`, [int(req.params.id)]
    );
    if (!s) throw new HttpError(404, 'Session not found');
    await pool.query('UPDATE refresh_tokens SET revoked_at = NOW() WHERE id = ?', [s.id]);
    await platformAudit.logPlatformAudit({
      actor: req.user, action: 'security.session_revoked', category: 'security',
      entityType: 'refresh_token', entityId: s.id, after: { user: s.email }, reason, req,
    });
    res.json({ ok: true });
  }));

  // ======================================================== audit export (server side, uncapped)
  r.get('/audit/export', requirePermission('platform.audit.export'), asyncH(async (req, res) => {
    const where = []; const params = [];
    if (req.query.tenantId) { where.push('tenant_id = ?'); params.push(int(req.query.tenantId)); }
    if (req.query.category) { where.push('category = ?'); params.push(req.query.category); }
    if (req.query.action) { where.push('action LIKE ?'); params.push(`${req.query.action}%`); }
    if (req.query.since) { where.push('created_at >= ?'); params.push(req.query.since); }
    if (req.query.until) { where.push('created_at <= ?'); params.push(req.query.until); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const cols = ['id', 'created_at', 'tenant_id', 'actor_name', 'actor_email', 'actor_role', 'action', 'category',
      'entity_type', 'entity_id', 'reason', 'outcome', 'ip', 'request_id', 'before_json', 'after_json'];
    // CSV cells beginning with = + - @ are formula-injection vectors in a spreadsheet.
    const cell = (v) => {
      if (v === null || v === undefined) return '';
      let s = typeof v === 'object' ? JSON.stringify(v) : String(v);
      if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
      return `"${s.replace(/"/g, '""')}"`;
    };
    // The export is itself an auditable act.
    await platformAudit.logPlatformAudit({
      actor: req.user, action: 'security.audit_exported', category: 'security',
      after: { filters: req.query }, reason: 'Platform audit CSV export', req,
    });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="platform-audit-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.write(`${cols.join(',')}\n`);
    // Keyset pagination so memory stays flat however large the trail is.
    let last = 0;
    for (;;) {
      const [rows] = await pool.query(
        `SELECT ${cols.join(',')} FROM platform_audit_logs ${clause ? `${clause} AND` : 'WHERE'} id > ? ORDER BY id LIMIT 1000`,
        [...params, last]
      );
      if (!rows.length) break;
      for (const row of rows) res.write(`${cols.map((c) => cell(row[c])).join(',')}\n`);
      last = rows[rows.length - 1].id;
    }
    res.end();
  }));

  // ======================================================== company tabs
  /** A read-only support session may look but not change anything. */
  const writableReach = asyncH(async (req, res, next) => {
    if (req.supportSession && req.supportSession.access_type === 'read_only') {
      throw new HttpError(403, 'This support session is read-only. Request tenant_administration or configuration access to make changes.',
        { requiresSupportAccess: true, tenantId: int(req.params.id) });
    }
    next();
  });

  r.get('/tenants/:id/users', requirePermission('platform.tenants.view'), tenantReach, asyncH(async (req, res) => {
    const [rows] = await pool.query(
      `SELECT id, name, email, role, status, mfa_enabled, last_login_at, created_at
         FROM users WHERE tenant_id = ? ORDER BY created_at LIMIT 500`, [int(req.params.id)]
    );
    res.json({ data: rows });
  }));

  r.get('/tenants/:id/roles', requirePermission('platform.tenants.view'), tenantReach, asyncH(async (req, res) => {
    const id = int(req.params.id);
    const [rows] = await pool.query(
      `SELECT r.id, r.name, r.label, r.is_system, r.permissions,
              (SELECT COUNT(*) FROM users u WHERE u.tenant_id = r.tenant_id AND u.role = r.name) AS users
         FROM roles r WHERE r.tenant_id = ? ORDER BY r.is_system DESC, r.label`, [id]
    );
    res.json({ data: rows.map((x) => ({ ...x, permissions: unj(x.permissions, []) })) });
  }));

  r.get('/tenants/:id/security', requirePermission('platform.tenants.view'), tenantReach, asyncH(async (req, res) => {
    const id = int(req.params.id);
    const [policies] = await pool.query('SELECT policy_key, policy_value, updated_at FROM security_policies WHERE tenant_id = ?', [id]);
    const [ips] = await pool.query('SELECT id, cidr, scope, applies_to, note, active FROM ip_restrictions WHERE tenant_id = ?', [id]);
    const [events] = await pool.query(
      `SELECT email, event, ip, details, created_at FROM login_events WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 50`, [id]
    );
    const [[mfa]] = await pool.query(
      `SELECT COUNT(*) AS total, COALESCE(SUM(mfa_enabled = 1),0) AS withMfa FROM users WHERE tenant_id = ? AND status = 'active'`, [id]
    );
    res.json({
      data: {
        policies: policies.map((p) => ({ ...p, policy_value: unj(p.policy_value, null) })),
        ipRestrictions: ips, loginEvents: events,
        mfa: { total: Number(mfa.total), enrolled: Number(mfa.withMfa) },
      },
    });
  }));

  // ---- branding
  const HEX = /^#[0-9a-fA-F]{6}$/;
  const BRANDING_FIELDS = ['companyName', 'logoUrl', 'primaryColor', 'accentColor', 'loginTagline', 'supportEmail', 'emailFromName', 'emailFooter'];

  async function snapshotConfig(tenantId, configKey, config, notes, userId) {
    const [[{ v }]] = await pool.query('SELECT MAX(version) AS v FROM config_versions WHERE tenant_id = ? AND config_key = ?', [tenantId, configKey]);
    await pool.query(
      `UPDATE config_versions SET status = 'expired', effective_to = CURDATE() WHERE tenant_id = ? AND config_key = ? AND status = 'active'`,
      [tenantId, configKey]
    );
    const version = Number(v || 0) + 1;
    const [ins] = await pool.query(
      `INSERT INTO config_versions (tenant_id, config_key, module, version, status, config, notes, effective_from, created_by, published_at)
       VALUES (?,?,?,?, 'active', ?, ?, CURDATE(), ?, NOW())`,
      [tenantId, configKey, 'platform', version, JSON.stringify(config), String(notes || '').slice(0, 255), userId]
    );
    return { id: ins.insertId, version };
  }

  r.get('/tenants/:id/branding', requirePermission('platform.tenants.view'), tenantReach, asyncH(async (req, res) => {
    const [[t]] = await pool.query('SELECT name, branding FROM tenants WHERE id = ?', [int(req.params.id)]);
    if (!t) throw new HttpError(404, 'Tenant not found');
    res.json({ data: { name: t.name, branding: unj(t.branding, {}) } });
  }));

  r.put('/tenants/:id/branding', requirePermission('platform.tenants.manage'), tenantReach, writableReach, asyncH(async (req, res) => {
    const id = int(req.params.id);
    const reason = needReason(req.body?.reason);
    const input = req.body?.branding || {};
    const [[t]] = await pool.query('SELECT branding FROM tenants WHERE id = ?', [id]);
    if (!t) throw new HttpError(404, 'Tenant not found');
    const before = unj(t.branding, {});
    const next = { ...before };
    for (const f of BRANDING_FIELDS) {
      if (input[f] === undefined) continue;
      const v = input[f] === '' ? null : input[f];
      if ((f === 'primaryColor' || f === 'accentColor') && v && !HEX.test(v)) throw new HttpError(400, `${f} must be a #RRGGBB colour`);
      if (f === 'logoUrl' && v && !/^(https:\/\/|\/uploads\/)/.test(v)) throw new HttpError(400, 'logoUrl must be an https:// URL or an uploaded file path');
      if (f === 'supportEmail' && v && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) throw new HttpError(400, 'supportEmail is not a valid email address');
      if (typeof v === 'string' && v.length > 300) throw new HttpError(400, `${f} is too long`);
      next[f] = v;
    }
    await pool.query('UPDATE tenants SET branding = ? WHERE id = ?', [JSON.stringify(next), id]);
    const ver = await snapshotConfig(id, 'branding', next, reason, req.user.id);
    await platformAudit.logPlatformAudit({
      tenantId: id, actor: req.user, action: 'branding.updated', category: 'tenant',
      entityType: 'tenant_branding', entityId: id, before, after: next, reason, req,
    });
    res.json({ data: { branding: next, configVersion: ver.version } });
  }));

  // ---- domains (real DNS TXT verification)
  const HOST = /^(?=.{4,190}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;
  r.get('/tenants/:id/domains', requirePermission('platform.tenants.view'), tenantReach, asyncH(async (req, res) => {
    const [rows] = await pool.query(
      `SELECT id, hostname, is_primary, verified, verification_token, ssl_status, status, created_at
         FROM tenant_domains WHERE tenant_id = ? AND status = 'active' ORDER BY is_primary DESC, hostname`, [int(req.params.id)]
    );
    res.json({ data: rows.map((d) => ({ ...d, txtRecord: d.verified ? null : { name: `_arthvex-verify.${d.hostname}`, value: d.verification_token } })) });
  }));

  r.post('/tenants/:id/domains', requirePermission('platform.tenants.manage'), tenantReach, writableReach, asyncH(async (req, res) => {
    const id = int(req.params.id);
    const reason = needReason(req.body?.reason);
    const hostname = String(req.body?.hostname || '').toLowerCase().trim();
    if (!HOST.test(hostname)) throw new HttpError(400, 'That is not a valid hostname');
    const [dupe] = await pool.query('SELECT id, tenant_id, status FROM tenant_domains WHERE hostname = ?', [hostname]);
    if (dupe[0] && dupe[0].status === 'active') {
      // Do not reveal which company owns it.
      throw new HttpError(409, 'That hostname is already registered');
    }
    const token = `arthvex-${crypto.randomBytes(12).toString('hex')}`;
    let domainId;
    if (dupe[0]) {
      await pool.query(`UPDATE tenant_domains SET tenant_id=?, status='active', verified=0, is_primary=0, verification_token=?, ssl_status='none', created_by=? WHERE id=?`,
        [id, token, req.user.id, dupe[0].id]);
      domainId = dupe[0].id;
    } else {
      const [ins] = await pool.query(
        `INSERT INTO tenant_domains (tenant_id, hostname, verification_token, created_by) VALUES (?,?,?,?)`, [id, hostname, token, req.user.id]
      );
      domainId = ins.insertId;
    }
    await platformAudit.logPlatformAudit({
      tenantId: id, actor: req.user, action: 'domain.added', category: 'tenant',
      entityType: 'tenant_domain', entityId: domainId, after: { hostname }, reason, req,
    });
    res.status(201).json({ data: { id: domainId, hostname, txtRecord: { name: `_arthvex-verify.${hostname}`, value: token } } });
  }));

  r.post('/tenants/:id/domains/:domainId/verify', requirePermission('platform.tenants.manage'), tenantReach, writableReach, asyncH(async (req, res) => {
    const id = int(req.params.id);
    const [[d]] = await pool.query('SELECT * FROM tenant_domains WHERE id = ? AND tenant_id = ? AND status = \'active\'', [int(req.params.domainId), id]);
    if (!d) throw new HttpError(404, 'Domain not found');
    if (d.verified) return res.json({ data: { verified: true } });
    let found = false;
    try {
      const records = await dns.resolveTxt(`_arthvex-verify.${d.hostname}`);
      found = records.some((chunks) => chunks.join('') === d.verification_token);
    } catch (e) {
      if (!['ENOTFOUND', 'ENODATA', 'ETIMEOUT', 'ECONNREFUSED', 'ESERVFAIL'].includes(e.code)) throw e;
    }
    if (!found) {
      return res.status(422).json({
        error: 'The verification TXT record was not found yet. DNS changes can take time to propagate.',
        data: { verified: false, txtRecord: { name: `_arthvex-verify.${d.hostname}`, value: d.verification_token } },
      });
    }
    await pool.query(`UPDATE tenant_domains SET verified = 1, ssl_status = 'pending' WHERE id = ?`, [d.id]);
    await platformAudit.logPlatformAudit({
      tenantId: id, actor: req.user, action: 'domain.verified', category: 'tenant',
      entityType: 'tenant_domain', entityId: d.id, after: { hostname: d.hostname }, reason: 'DNS TXT record matched', req,
    });
    res.json({ data: { verified: true } });
  }));

  r.post('/tenants/:id/domains/:domainId/primary', requirePermission('platform.tenants.manage'), tenantReach, writableReach, asyncH(async (req, res) => {
    const id = int(req.params.id);
    const reason = needReason(req.body?.reason);
    const [[d]] = await pool.query(`SELECT * FROM tenant_domains WHERE id = ? AND tenant_id = ? AND status = 'active'`, [int(req.params.domainId), id]);
    if (!d) throw new HttpError(404, 'Domain not found');
    if (!d.verified) throw new HttpError(400, 'Only a verified domain can be primary');
    await pool.query('UPDATE tenant_domains SET is_primary = (id = ?) WHERE tenant_id = ?', [d.id, id]);
    await platformAudit.logPlatformAudit({
      tenantId: id, actor: req.user, action: 'domain.primary_changed', category: 'tenant',
      entityType: 'tenant_domain', entityId: d.id, after: { hostname: d.hostname }, reason, req,
    });
    res.json({ ok: true });
  }));

  r.delete('/tenants/:id/domains/:domainId', requirePermission('platform.tenants.manage'), tenantReach, writableReach, asyncH(async (req, res) => {
    const id = int(req.params.id);
    const reason = needReason(req.body?.reason || req.query.reason);
    const [[d]] = await pool.query(`SELECT * FROM tenant_domains WHERE id = ? AND tenant_id = ? AND status = 'active'`, [int(req.params.domainId), id]);
    if (!d) throw new HttpError(404, 'Domain not found');
    await pool.query(`UPDATE tenant_domains SET status = 'removed', is_primary = 0 WHERE id = ?`, [d.id]);
    await platformAudit.logPlatformAudit({
      tenantId: id, actor: req.user, action: 'domain.removed', category: 'tenant',
      entityType: 'tenant_domain', entityId: d.id, before: { hostname: d.hostname }, reason, req,
    });
    res.json({ ok: true });
  }));

  // ---- integrations (secrets are never selected)
  r.get('/tenants/:id/integrations', requirePermission('platform.integrations.view'), tenantReach, asyncH(async (req, res) => {
    const id = int(req.params.id);
    const [keys] = await pool.query(
      `SELECT id, name, key_prefix, scopes, last_used_at, revoked_at, created_at FROM api_keys WHERE tenant_id = ? ORDER BY created_at DESC`, [id]
    );
    const [hooks] = await pool.query(
      `SELECT w.id, w.url, w.events, w.active, w.created_at,
              (SELECT COUNT(*) FROM webhook_deliveries d WHERE d.subscription_id = w.id AND d.status IN ('failed','dead')
                  AND d.created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)) AS recent_failures
         FROM webhook_subscriptions w WHERE w.tenant_id = ? ORDER BY w.created_at DESC`, [id]
    );
    const [conns] = await pool.query(
      `SELECT id, itype, name, status, last_sync_at, last_error FROM integration_connections WHERE tenant_id = ? ORDER BY created_at DESC`, [id]
    );
    res.json({
      data: {
        apiKeys: keys.map((k) => ({ ...k, scopes: unj(k.scopes, []) })),
        webhooks: hooks.map((h) => ({ ...h, events: unj(h.events, []) })),
        connections: conns,
      },
    });
  }));

  r.post('/tenants/:id/integrations/api-keys/:keyId/revoke', requirePermission('platform.integrations.manage'), asyncH(async (req, res) => {
    const id = int(req.params.id);
    const reason = needReason(req.body?.reason);
    const [[k]] = await pool.query('SELECT id, name, key_prefix FROM api_keys WHERE id = ? AND tenant_id = ? AND revoked_at IS NULL', [int(req.params.keyId), id]);
    if (!k) throw new HttpError(404, 'Active API key not found');
    await pool.query('UPDATE api_keys SET revoked_at = NOW() WHERE id = ?', [k.id]);
    await platformAudit.logPlatformAudit({
      tenantId: id, actor: req.user, action: 'api_key.revoked', category: 'integration',
      entityType: 'api_key', entityId: k.id, before: { name: k.name, prefix: k.key_prefix }, reason, req,
    });
    res.json({ ok: true });
  }));

  r.post('/tenants/:id/integrations/webhooks/:hookId/disable', requirePermission('platform.integrations.manage'), asyncH(async (req, res) => {
    const id = int(req.params.id);
    const reason = needReason(req.body?.reason);
    const [[h]] = await pool.query('SELECT id, url FROM webhook_subscriptions WHERE id = ? AND tenant_id = ? AND active = 1', [int(req.params.hookId), id]);
    if (!h) throw new HttpError(404, 'Active webhook not found');
    await pool.query('UPDATE webhook_subscriptions SET active = 0 WHERE id = ?', [h.id]);
    await platformAudit.logPlatformAudit({
      tenantId: id, actor: req.user, action: 'integration.webhook_disconnected', category: 'integration',
      entityType: 'webhook_subscription', entityId: h.id, before: { url: h.url }, reason, req,
    });
    res.json({ ok: true });
  }));

  // ---- audit tab: the customer's own trail + what ARTHVEX did to them
  r.get('/tenants/:id/audit', requirePermission('platform.audit.view'), tenantReach, asyncH(async (req, res) => {
    const id = int(req.params.id);
    const limit = Math.min(200, int(req.query.limit, 50));
    const offset = (Math.max(1, int(req.query.page, 1)) - 1) * limit;
    const source = req.query.source === 'tenant' ? 'tenant' : 'platform';
    if (source === 'platform') {
      const result = await platformAudit.list({ tenantId: id, limit, offset, category: req.query.category });
      return res.json({ data: result.rows, meta: { total: result.total, limit, source } });
    }
    const [[{ total }]] = await pool.query('SELECT COUNT(*) AS total FROM audit_logs WHERE tenant_id = ?', [id]);
    const [rows] = await pool.query(
      `SELECT id, actor_name, actor_role, action, entity_type, entity_id, ip, created_at
         FROM audit_logs WHERE tenant_id = ? ORDER BY id DESC LIMIT ? OFFSET ?`, [id, limit, offset]
    );
    res.json({ data: rows, meta: { total: Number(total), limit, source } });
  }));

  // ---- support access tab
  r.get('/tenants/:id/support-access', requirePermission('platform.support.view'), tenantReach, asyncH(async (req, res) => {
    const result = await supportAccess.list({ tenantId: int(req.params.id), limit: 50 });
    res.json({ data: result.rows, meta: { total: result.total } });
  }));

  // ---- configuration tab: versions, diff, rollback-as-new-version
  r.get('/tenants/:id/configuration', requirePermission('platform.config.view'), tenantReach, asyncH(async (req, res) => {
    const [rows] = await pool.query(
      `SELECT cv.id, cv.config_key, cv.module, cv.version, cv.status, cv.notes, cv.effective_from, cv.created_at, cv.created_by,
              u.name AS created_by_name
         FROM config_versions cv LEFT JOIN users u ON u.id = cv.created_by
        WHERE cv.tenant_id = ? ORDER BY cv.config_key, cv.version DESC LIMIT 300`, [int(req.params.id)]
    );
    res.json({ data: rows });
  }));

  const flatten = (obj, prefix = '', out = {}) => {
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      for (const [k, v] of Object.entries(obj)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
      if (!Object.keys(obj).length && prefix) out[prefix] = {};
    } else out[prefix || '(root)'] = obj;
    return out;
  };
  const diff = (a, b) => {
    const fa = flatten(a || {}); const fb = flatten(b || {});
    const keys = [...new Set([...Object.keys(fa), ...Object.keys(fb)])].sort();
    return keys
      .filter((k) => JSON.stringify(fa[k]) !== JSON.stringify(fb[k]))
      .map((k) => ({ path: k, from: k in fa ? fa[k] : undefined, to: k in fb ? fb[k] : undefined,
        change: !(k in fa) ? 'added' : !(k in fb) ? 'removed' : 'changed' }));
  };

  r.get('/tenants/:id/configuration/:versionId', requirePermission('platform.config.view'), tenantReach, asyncH(async (req, res) => {
    const id = int(req.params.id);
    const [[v]] = await pool.query('SELECT * FROM config_versions WHERE id = ? AND tenant_id = ?', [int(req.params.versionId), id]);
    if (!v) throw new HttpError(404, 'Configuration version not found');
    let against = null;
    if (req.query.against) {
      [[against]] = await pool.query('SELECT * FROM config_versions WHERE id = ? AND tenant_id = ? AND config_key = ?',
        [int(req.query.against), id, v.config_key]);
    } else {
      // default: compare with the previous version of the same key
      [[against]] = await pool.query(
        'SELECT * FROM config_versions WHERE tenant_id = ? AND config_key = ? AND version < ? ORDER BY version DESC LIMIT 1',
        [id, v.config_key, v.version]
      );
    }
    res.json({ data: { version: { ...v, config: unj(v.config, {}) }, against: against ? { id: against.id, version: against.version } : null,
      diff: diff(against ? unj(against.config, {}) : {}, unj(v.config, {})) } });
  }));

  /**
   * Rollback never rewrites history: it appends a new version holding the old
   * content and, for the keys the platform owns (branding), applies it live.
   */
  r.post('/tenants/:id/configuration/:versionId/rollback', requirePermission('platform.config.manage'), tenantReach, writableReach, asyncH(async (req, res) => {
    const id = int(req.params.id);
    const reason = needReason(req.body?.reason);
    const [[v]] = await pool.query('SELECT * FROM config_versions WHERE id = ? AND tenant_id = ?', [int(req.params.versionId), id]);
    if (!v) throw new HttpError(404, 'Configuration version not found');
    const snapshot = unj(v.config, {});
    const [[current]] = await pool.query(
      `SELECT config FROM config_versions WHERE tenant_id = ? AND config_key = ? AND status = 'active' ORDER BY version DESC LIMIT 1`, [id, v.config_key]
    );
    const ver = await snapshotConfig(id, v.config_key, snapshot, `Rollback to version ${v.version}: ${reason}`, req.user.id);
    let applied = false;
    if (v.config_key === 'branding') {
      await pool.query('UPDATE tenants SET branding = ? WHERE id = ?', [JSON.stringify(snapshot), id]);
      applied = true;
    }
    await platformAudit.logPlatformAudit({
      tenantId: id, actor: req.user, action: 'config.rolled_back', category: 'tenant',
      entityType: 'config_version', entityId: ver.id,
      before: current ? unj(current.config, {}) : null, after: snapshot, reason, req,
    });
    res.json({ data: { newVersion: ver.version, rolledBackTo: v.version, appliedLive: applied } });
  }));

  return r;
};
