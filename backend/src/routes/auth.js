const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const dayjs = require('dayjs');
const { pool } = require('../config/db');
const env = require('../config/env');
const { asyncH, HttpError } = require('../utils/helpers');
const { signAccessToken, verifyAccessToken, signRefreshToken, verifyRefreshToken } = require('../utils/jwt');
const { authenticate } = require('../middleware/auth');
const rbac = require('../services/rbac');
const { logAudit } = require('../services/audit');
const { notifyEvent } = require('../services/notify');

const r = express.Router();
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// ---------- Login events & suspicious-login detection (spec §12) ----------
async function logLoginEvent({ tenantId, userId, email, event, req, details }) {
  try {
    await pool.query(
      'INSERT INTO login_events (tenant_id, user_id, email, event, ip, user_agent, details) VALUES (?,?,?,?,?,?,?)',
      [tenantId || null, userId || null, email || null, event, req.ip || null, (req.headers['user-agent'] || '').slice(0, 250), details || null]
    );
  } catch (_) { /* logging must never break auth */ }
}

async function failedAttemptCount(email) {
  const [rows] = await pool.query(
    `SELECT COUNT(*) AS n FROM login_events WHERE email = ? AND event = 'login_failed' AND created_at >= DATE_SUB(NOW(), INTERVAL 15 MINUTE)`,
    [email]
  );
  return rows[0].n;
}

// ---------- TOTP (RFC 6238) via built-in crypto ----------
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function base32Decode(str) {
  let bits = 0, value = 0; const out = [];
  for (const ch of str.replace(/=+$/, '').toUpperCase()) {
    const idx = B32.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
function totpCode(secretBuf, offset = 0) {
  const counter = Math.floor(Date.now() / 30000) + offset;
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const h = crypto.createHmac('sha1', secretBuf).update(buf).digest();
  const off = h[h.length - 1] & 0xf;
  const code = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(code % 1e6).padStart(6, '0');
}
function verifyTotp(secret, code) {
  const buf = base32Decode(secret);
  return [-1, 0, 1].some((o) => totpCode(buf, o) === String(code).trim());
}
function signChallenge(user) {
  return jwtSign({ sub: user.id, challenge: 'mfa' }, '10m');
}
const jwtSign = (payload, ttl) => {
  // short-lived challenge token using the access secret
  const { sign } = require('jsonwebtoken');
  return sign(payload, env.jwt.accessSecret, { expiresIn: ttl });
};

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
  const emailNorm = String(email).toLowerCase().trim();
  const [rows] = await pool.query(
    `SELECT u.*, t.name AS tenant_name, t.branding, t.slug AS tenant_slug FROM users u
     LEFT JOIN tenants t ON t.id = u.tenant_id
     WHERE u.email = ?`, [emailNorm]
  );
  const user = rows[0];
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    await logAudit({ tenantId: user?.tenant_id || null, actor: null, action: 'auth.login_failed', entityType: 'user', entityId: user?.id, req });
    await logLoginEvent({ tenantId: user?.tenant_id || null, userId: user?.id || null, email: emailNorm, event: 'login_failed', req });
    throw new HttpError(401, 'Invalid email or password');
  }
  if (user.status !== 'active') throw new HttpError(403, 'Account is disabled');
  // MFA challenge (spec §12): privileged or opted-in users confirm a TOTP code before tokens are issued
  if (user.mfa_enabled) {
    const challenge = jwtSign({ sub: user.id, challenge: 'mfa' }, '10m');
    return res.json({ mfaRequired: true, challenge });
  }
  await pool.query('UPDATE users SET last_login_at = NOW() WHERE id = ?', [user.id]);
  const fails = await failedAttemptCount(emailNorm);
  if (fails >= 3) await logLoginEvent({ tenantId: user.tenant_id, userId: user.id, email: emailNorm, event: 'suspicious', req, details: `${fails} failed attempts in the last 15 minutes before this login` });
  const tokens = await issueTokens(user, req, res);
  await logAudit({ tenantId: user.tenant_id, actor: { id: user.id, name: user.name, role: user.role }, action: 'auth.login', entityType: 'user', entityId: user.id, req });
  await logLoginEvent({ tenantId: user.tenant_id, userId: user.id, email: emailNorm, event: 'login', req });
  res.json({ ...tokens, mustChangePassword: !!user.must_change_password, user: { id: user.id, name: user.name, email: user.email, role: user.role, tenantId: user.tenant_id, tenantName: user.tenant_name, tenantSlug: user.tenant_slug } });
}));

// MFA challenge verification → issues tokens
r.post('/mfa/verify', asyncH(async (req, res) => {
  const { challenge, code } = req.body || {};
  if (!challenge || !code) throw new HttpError(400, 'challenge and code required');
  let payload;
  try { payload = verifyAccessToken(challenge); } catch (_) { throw new HttpError(401, 'Challenge expired, login again'); }
  if (payload.challenge !== 'mfa') throw new HttpError(401, 'Invalid challenge');
  const [users] = await pool.query('SELECT * FROM users WHERE id = ?', [payload.sub]);
  const user = users[0];
  if (!user || user.status !== 'active' || !user.mfa_enabled) throw new HttpError(401, 'Account not eligible');
  if (!verifyTotp(user.mfa_secret || '', code)) {
    await logLoginEvent({ tenantId: user.tenant_id, userId: user.id, email: user.email, event: 'mfa_failed', req });
    throw new HttpError(401, 'Invalid verification code');
  }
  await pool.query('UPDATE users SET last_login_at = NOW() WHERE id = ?', [user.id]);
  const tokens = await issueTokens(user, req, res);
  await logAudit({ tenantId: user.tenant_id, actor: { id: user.id, name: user.name, role: user.role }, action: 'auth.login', entityType: 'user', entityId: user.id, req });
  await logLoginEvent({ tenantId: user.tenant_id, userId: user.id, email: user.email, event: 'login', req, details: 'mfa' });
  res.json({ ...tokens, mustChangePassword: !!user.must_change_password, user: { id: user.id, name: user.name, email: user.email, role: user.role, tenantId: user.tenant_id, tenantName: user.tenant_name, tenantSlug: user.tenant_slug } });
}));

// MFA setup: generate secret + otpauth URL (enrollment confirms with a code)
r.post('/mfa/setup', authenticate, asyncH(async (req, res) => {
  const secret = base32Encode(crypto.randomBytes(20));
  await pool.query('UPDATE users SET mfa_secret = ?, mfa_enabled = 0 WHERE id = ?', [secret, req.user.id]);
  const url = `otpauth://totp/ArthvexHRMS:${encodeURIComponent(req.user.email)}?secret=${secret}&issuer=Arthvex%20HRMS&digits=6&period=30`;
  res.json({ data: { secret, url } });
}));

r.post('/mfa/enable', authenticate, asyncH(async (req, res) => {
  const { code } = req.body || {};
  const [users] = await pool.query('SELECT mfa_secret FROM users WHERE id = ?', [req.user.id]);
  if (!users[0].mfa_secret) throw new HttpError(400, 'Run setup first');
  if (!verifyTotp(users[0].mfa_secret, code)) throw new HttpError(400, 'Invalid code — check your authenticator app clock');
  await pool.query('UPDATE users SET mfa_enabled = 1 WHERE id = ?', [req.user.id]);
  await logAudit({ tenantId: req.user.tenant_id, actor: req.user, action: 'auth.mfa_enabled', entityType: 'user', entityId: req.user.id, req });
  res.json({ ok: true });
}));

r.post('/mfa/disable', authenticate, asyncH(async (req, res) => {
  const { password } = req.body || {};
  const [users] = await pool.query('SELECT password_hash FROM users WHERE id = ?', [req.user.id]);
  if (!(await bcrypt.compare(password || '', users[0].password_hash))) throw new HttpError(400, 'Password confirmation required');
  await pool.query('UPDATE users SET mfa_enabled = 0, mfa_secret = NULL WHERE id = ?', [req.user.id]);
  await logAudit({ tenantId: req.user.tenant_id, actor: req.user, action: 'auth.mfa_disabled', entityType: 'user', entityId: req.user.id, req });
  res.json({ ok: true });
}));

r.get('/mfa/status', authenticate, asyncH(async (req, res) => {
  const [users] = await pool.query('SELECT mfa_enabled FROM users WHERE id = ?', [req.user.id]);
  res.json({ data: { enabled: !!users[0].mfa_enabled } });
}));

// ---- Session & device management (spec §12) ----
r.get('/sessions', authenticate, asyncH(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT id, user_agent, ip, created_at, expires_at, revoked_at FROM refresh_tokens
     WHERE user_id = ? AND expires_at > NOW() ORDER BY created_at DESC LIMIT 30`,
    [req.user.id]
  );
  const [currentRows] = await pool.query(
    'SELECT token_hash FROM refresh_tokens WHERE user_id = ? AND expires_at > NOW() AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1', [req.user.id]
  );
  const currentHash = currentRows[0]?.token_hash;
  res.json({ data: rows.map((s) => ({ ...s, current: currentHash ? s.token_hash === currentHash : false })) });
}));

r.delete('/sessions/:id', authenticate, asyncH(async (req, res) => {
  await pool.query('UPDATE refresh_tokens SET revoked_at = NOW() WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
  res.json({ ok: true });
}));

r.post('/sessions/revoke-others', authenticate, asyncH(async (req, res) => {
  const [currentRows] = await pool.query(
    'SELECT token_hash FROM refresh_tokens WHERE user_id = ? AND expires_at > NOW() AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1', [req.user.id]
  );
  if (currentRows[0]) {
    await pool.query('UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = ? AND token_hash != ?', [req.user.id, currentRows[0].token_hash]);
  }
  res.json({ ok: true });
}));

// ---- My login history ----
r.get('/my/login-history', authenticate, asyncH(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT event, ip, user_agent, details, created_at FROM login_events
     WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`,
    [req.user.id]
  );
  res.json({ data: rows });
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
  if (req.headers.authorization?.startsWith('Bearer ')) {
    try {
      const payload = verifyAccessToken(req.headers.authorization.slice(7));
      await logLoginEvent({ tenantId: payload.tenant ?? null, userId: payload.sub, email: null, event: 'logout', req });
    } catch (_) {}
  }
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
  // Effective access (roles + groups + direct grants - denies) as resolved during
  // authentication, so the UI and the server enforce exactly the same thing.
  const permissions = req.user.permissions || [];
  let branding = {};
  let flags = {};
  try { branding = typeof u.branding === 'string' ? JSON.parse(u.branding || '{}') : u.branding || {}; } catch (_) {}
  try { flags = typeof u.feature_flags === 'string' ? JSON.parse(u.feature_flags || '{}') : u.feature_flags || {}; } catch (_) {}
  res.json({
    data: {
      id: u.id, name: u.name, email: u.email, role: u.role, tenantId: u.tenant_id, employeeId: u.employee_id,
      tenantName: u.tenant_name, mustChangePassword: !!u.must_change_password, lastLoginAt: u.last_login_at,
      permissions,
      roles: req.user.roles || [],
      deniedPermissions: req.user.deniedPermissions || [],
      isPlatformAdmin: !!req.user.isPlatformAdmin,
      accessibleModules: req.user.accessibleModules || (await rbac.enabledModules(req.user.isPlatformAdmin ? null : u.tenant_id)),
      branding, featureFlags: flags,
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
