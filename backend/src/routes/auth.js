const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const dayjs = require('dayjs');
const { pool } = require('../config/db');
const env = require('../config/env');
const { asyncH, HttpError } = require('../utils/helpers');
const { signAccessToken, verifyAccessToken, signRefreshToken, verifyRefreshToken } = require('../utils/jwt');
const { authenticate, loadRolePermissions } = require('../middleware/auth');
const { logAudit } = require('../services/audit');
const { notifyEvent } = require('../services/notify');

const r = express.Router();
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

async function issueTokens(user, req, res) {
  const jti = crypto.randomUUID();
  const refresh = signRefreshToken(user, jti);
  await pool.query(
    'INSERT INTO refresh_tokens (user_id, token_hash, user_agent, ip, expires_at) VALUES (?,?,?,?,?)',
    [user.id, sha256(refresh), (req.headers['user-agent'] || '').slice(0, 250), req.ip, dayjs().add(env.jwt.refreshTtlDays, 'day').format('YYYY-MM-DD HH:mm:ss')]
  );
  const access = signAccessToken(user);
  res.cookie('hrms_refresh', refresh, {
    httpOnly: true, sameSite: 'lax', secure: env.nodeEnv === 'production', maxAge: env.jwt.refreshTtlDays * 24 * 3600 * 1000,
  });
  return { accessToken: access, expiresIn: env.jwt.accessTtl };
}

r.post('/login', asyncH(async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) throw new HttpError(400, 'Email and password are required');
  const [rows] = await pool.query(
    `SELECT u.*, t.name AS tenant_name, t.branding, t.slug AS tenant_slug FROM users u
     LEFT JOIN tenants t ON t.id = u.tenant_id
     WHERE u.email = ?`, [String(email).toLowerCase().trim()]
  );
  const user = rows[0];
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    await logAudit({ tenantId: user?.tenant_id || null, actor: null, action: 'auth.login_failed', entityType: 'user', entityId: user?.id, req });
    throw new HttpError(401, 'Invalid email or password');
  }
  if (user.status !== 'active') throw new HttpError(403, 'Account is disabled');
  await pool.query('UPDATE users SET last_login_at = NOW() WHERE id = ?', [user.id]);
  const tokens = await issueTokens(user, req, res);
  await logAudit({ tenantId: user.tenant_id, actor: { id: user.id, name: user.name, role: user.role }, action: 'auth.login', entityType: 'user', entityId: user.id, req });
  res.json({ ...tokens, mustChangePassword: !!user.must_change_password, user: { id: user.id, name: user.name, email: user.email, role: user.role, tenantId: user.tenant_id, tenantName: user.tenant_name, tenantSlug: user.tenant_slug } });
}));

r.post('/refresh', asyncH(async (req, res) => {
  const token = req.cookies?.hrms_refresh;
  if (!token) throw new HttpError(401, 'No refresh token');
  const [rows] = await pool.query('SELECT * FROM refresh_tokens WHERE token_hash = ?', [sha256(token)]);
  const stored = rows[0];
  if (!stored || stored.revoked_at || dayjs(stored.expires_at).isBefore(dayjs())) throw new HttpError(401, 'Invalid or expired session');
  let payload;
  try { payload = verifyRefreshToken(token); } catch (_) { throw new HttpError(401, 'Invalid session'); }
  // rotation: revoke old, issue new
  await pool.query('UPDATE refresh_tokens SET revoked_at = NOW() WHERE id = ?', [stored.id]);
  const [users] = await pool.query('SELECT * FROM users WHERE id = ?', [payload.sub]);
  const user = users[0];
  if (!user || user.status !== 'active') throw new HttpError(401, 'Account is disabled');
  await issueTokens(user, req, res);
  const access = signAccessToken(user);
  res.json({ ok: true, accessToken: access });
}));

r.post('/logout', asyncH(async (req, res) => {
  const token = req.cookies?.hrms_refresh;
  if (token) await pool.query('UPDATE refresh_tokens SET revoked_at = NOW() WHERE token_hash = ?', [sha256(token)]);
  res.clearCookie('hrms_refresh');
  res.json({ ok: true });
}));

/** Public branding for the login page (tenant resolved from ?tenant=slug or default first tenant). */
r.get('/branding', asyncH(async (req, res) => {
  let tenant = null;
  if (req.query.tenant) {
    const [rows] = await pool.query('SELECT name, slug, branding FROM tenants WHERE slug = ?', [req.query.tenant]);
    tenant = rows[0] || null;
  } else {
    const [rows] = await pool.query('SELECT name, slug, branding FROM tenants ORDER BY id LIMIT 1');
    tenant = rows[0] || null;
  }
  if (!tenant) return res.json({ data: { companyName: 'Arthvex HRMS' } });
  let branding = {};
  try { branding = typeof tenant.branding === 'string' ? JSON.parse(tenant.branding || '{}') : tenant.branding || {}; } catch (_) {}
  res.json({ data: { companyName: branding.companyName || tenant.name, logoUrl: branding.logoUrl || null, primaryColor: branding.primaryColor || null, slug: tenant.slug, loginTagline: branding.loginTagline || null } });
}));

r.get('/me', authenticate, asyncH(async (req, res) => {
  const [users] = await pool.query(
    `SELECT u.id, u.name, u.email, u.role, u.tenant_id, u.employee_id, u.must_change_password, u.last_login_at,
            t.name AS tenant_name, t.branding, t.feature_flags
     FROM users u LEFT JOIN tenants t ON t.id = u.tenant_id WHERE u.id = ?`, [req.user.id]
  );
  const u = users[0];
  const permMap = await loadRolePermissions(u.tenant_id || 0);
  let branding = {};
  let flags = {};
  try { branding = typeof u.branding === 'string' ? JSON.parse(u.branding || '{}') : u.branding || {}; } catch (_) {}
  try { flags = typeof u.feature_flags === 'string' ? JSON.parse(u.feature_flags || '{}') : u.feature_flags || {}; } catch (_) {}
  res.json({
    data: {
      id: u.id, name: u.name, email: u.email, role: u.role, tenantId: u.tenant_id, employeeId: u.employee_id,
      tenantName: u.tenant_name, mustChangePassword: !!u.must_change_password, lastLoginAt: u.last_login_at,
      permissions: permMap[u.role] || [], branding, featureFlags: flags,
    },
  });
}));

r.post('/change-password', authenticate, asyncH(async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!newPassword || String(newPassword).length < 8) throw new HttpError(400, 'New password must be at least 8 characters');
  const [users] = await pool.query('SELECT * FROM users WHERE id = ?', [req.user.id]);
  if (!(await bcrypt.compare(currentPassword || '', users[0].password_hash))) throw new HttpError(400, 'Current password is incorrect');
  await pool.query('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?', [await bcrypt.hash(newPassword, 10), req.user.id]);
  await pool.query('UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = ?', [req.user.id]);
  await notifyEvent({ tenantId: req.user.tenant_id, eventKey: 'password.security', vars: {}, recipients: [{ userId: req.user.id, email: req.user.email }] });
  await logAudit({ tenantId: req.user.tenant_id, actor: req.user, action: 'auth.password_changed', entityType: 'user', entityId: req.user.id, req });
  res.json({ ok: true });
}));

r.post('/forgot-password', asyncH(async (req, res) => {
  const { email } = req.body || {};
  const [users] = await pool.query('SELECT * FROM users WHERE email = ?', [String(email || '').toLowerCase().trim()]);
  if (users[0]) {
    const raw = crypto.randomBytes(24).toString('hex');
    await pool.query(
      'INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (?,?,?)',
      [users[0].id, sha256(raw), dayjs().add(1, 'hour').format('YYYY-MM-DD HH:mm:ss')]
    );
    await notifyEvent({
      tenantId: users[0].tenant_id, eventKey: 'password.security',
      vars: { title: 'Password reset requested', body: 'Use this token to reset your password (valid 1 hour): ' + raw },
      recipients: [{ userId: users[0].id, email: users[0].email }],
    });
    // In dev (no SMTP), return the token so the flow is testable.
    if (env.nodeEnv !== 'production') return res.json({ ok: true, devResetToken: raw });
  }
  res.json({ ok: true });
}));

r.post('/reset-password', asyncH(async (req, res) => {
  const { token, newPassword } = req.body || {};
  if (!token || !newPassword || String(newPassword).length < 8) throw new HttpError(400, 'Token and new password (min 8 chars) required');
  const [rows] = await pool.query('SELECT * FROM password_resets WHERE token_hash = ? AND used_at IS NULL AND expires_at > NOW()', [sha256(token)]);
  if (!rows[0]) throw new HttpError(400, 'Invalid or expired reset token');
  await pool.query('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?', [await bcrypt.hash(newPassword, 10), rows[0].user_id]);
  await pool.query('UPDATE password_resets SET used_at = NOW() WHERE id = ?', [rows[0].id]);
  await pool.query('UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = ?', [rows[0].user_id]);
  res.json({ ok: true });
}));

// Platform super admin: verify token works even without tenant
r.get('/verify', asyncH(async (req, res) => {
  const hdr = req.headers.authorization || '';
  const token = hdr.startsWith('Bearer ') ? hdr.slice(7) : null;
  try {
    const payload = verifyAccessToken(token);
    res.json({ valid: true, sub: payload.sub });
  } catch (_) {
    res.json({ valid: false });
  }
}));

module.exports = r;
