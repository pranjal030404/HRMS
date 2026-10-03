/**
 * Platform security policy (spec §3 Security Admin, §43).
 *
 * Deliberately separate from tenant security: these rows live in `security_policies`
 * with `tenant_id IS NULL` and govern ARTHVEX staff only. A company owner turning
 * MFA off for their company cannot weaken the control plane, and vice versa.
 *
 * Policies
 *   platform.mfa.required   { value: true|false }   staff must have MFA enrolled
 *   platform.ip.allowlist   { value: ['1.2.3.4/32'] } empty = no restriction
 *   platform.session.max_hours { value: number }    cap on refresh-token lifetime shown/enforced on revoke sweep
 */
const { pool } = require('../config/db');
const { HttpError } = require('../utils/helpers');

const KEYS = {
  mfa: 'platform.mfa.required',
  ips: 'platform.ip.allowlist',
  sessionHours: 'platform.session.max_hours',
};
// MFA for ARTHVEX staff is on by default in production; development and tests keep it off so
// seeded operators can sign in. An explicit saved policy always wins either way.
const DEFAULTS = { mfaRequired: process.env.NODE_ENV === 'production', ipAllowlist: [], sessionMaxHours: 0 };

let cache = null;
let cachedAt = 0;
const TTL_MS = 10_000;

const unwrap = (v) => {
  let x = v;
  if (typeof x === 'string') { try { x = JSON.parse(x); } catch { return x; } }
  return x && typeof x === 'object' && 'value' in x ? x.value : x;
};

async function getPolicy({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cachedAt < TTL_MS) return cache;
  const [rows] = await pool.query(
    'SELECT policy_key, policy_value FROM security_policies WHERE tenant_id IS NULL AND policy_key LIKE ?', ['platform.%']
  );
  const by = Object.fromEntries(rows.map((r) => [r.policy_key, unwrap(r.policy_value)]));
  cache = {
    mfaRequired: KEYS.mfa in by ? (by[KEYS.mfa] === true || by[KEYS.mfa] === 'true') : DEFAULTS.mfaRequired,
    ipAllowlist: Array.isArray(by[KEYS.ips]) ? by[KEYS.ips] : DEFAULTS.ipAllowlist,
    sessionMaxHours: Number(by[KEYS.sessionHours] || 0),
  };
  cachedAt = Date.now();
  return cache;
}

/** Validate an IPv4 address or CIDR; returns the normalised `a.b.c.d/n` or null. */
function normaliseCidr(value) {
  const [addr, bitsRaw] = String(value).trim().split('/');
  const o = addr.split('.');
  if (o.length !== 4 || !o.every((x) => /^\d{1,3}$/.test(x) && Number(x) <= 255)) return null;
  const bits = bitsRaw === undefined ? 32 : Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return null;
  return `${o.map(Number).join('.')}/${bits}`;
}

const toInt = (ip) => ip.split('.').reduce((a, b) => ((a << 8) + Number(b)) >>> 0, 0);

function ipInCidr(ip, cidr) {
  const [base, bitsRaw] = cidr.split('/');
  const bits = Number(bitsRaw);
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (toInt(ip) & mask) === (toInt(base) & mask);
}

/** `::ffff:1.2.3.4` and `::1` → plain IPv4 where possible. */
function cleanIp(ip) {
  let v = String(ip || '').replace(/^::ffff:/, '');
  if (v === '::1') v = '127.0.0.1';
  return v;
}

/** True when the address may use the control plane. An empty allowlist allows everyone. */
function ipAllowed(policy, ip) {
  const list = policy.ipAllowlist || [];
  if (!list.length) return true;
  const v = cleanIp(ip);
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(v)) return false;
  return list.some((c) => ipInCidr(v, c));
}

async function setPolicy({ mfaRequired, ipAllowlist, sessionMaxHours }, actorId) {
  const upsert = (key, value, description) => pool.query(
    `INSERT INTO security_policies (tenant_id, policy_key, policy_value, description, updated_by)
     VALUES (NULL,?,?,?,?)
     ON DUPLICATE KEY UPDATE policy_value = VALUES(policy_value), updated_by = VALUES(updated_by)`,
    [key, JSON.stringify({ value }), description, actorId]
  );
  // MySQL treats NULL as distinct in a UNIQUE key, so ON DUPLICATE never fires for
  // tenant_id IS NULL. Delete-then-insert keeps exactly one row per platform key.
  const replace = async (key, value, description) => {
    await pool.query('DELETE FROM security_policies WHERE tenant_id IS NULL AND policy_key = ?', [key]);
    return upsert(key, value, description);
  };
  if (mfaRequired !== undefined) await replace(KEYS.mfa, !!mfaRequired, 'Platform staff must enrol MFA');
  if (ipAllowlist !== undefined) {
    const clean = [];
    for (const raw of ipAllowlist) {
      const n = normaliseCidr(raw);
      if (!n) throw new HttpError(400, `"${raw}" is not a valid IPv4 address or CIDR block`);
      clean.push(n);
    }
    await replace(KEYS.ips, clean, 'Addresses allowed to reach the platform console');
  }
  if (sessionMaxHours !== undefined) {
    const h = Number(sessionMaxHours);
    if (!Number.isFinite(h) || h < 0 || h > 24 * 90) throw new HttpError(400, 'sessionMaxHours must be between 0 and 2160');
    await replace(KEYS.sessionHours, h, 'Maximum age of a platform session (0 = default)');
  }
  cache = null;
  return getPolicy({ fresh: true });
}

/**
 * Evaluate the policy for one request by a platform operator.
 * `stage: 'login'` is checked before tokens are issued; `'request'` on every console call.
 */
async function assertAllowed(user, req, { stage = 'request' } = {}) {
  const policy = await getPolicy();
  if (!ipAllowed(policy, req.ip)) {
    throw new HttpError(403, 'The platform console is not available from this network address', { code: 'PLATFORM_IP_DENIED' });
  }
  if (stage === 'request' && policy.mfaRequired && !user.mfa_enabled) {
    throw new HttpError(403, 'Platform policy requires multi-factor authentication. Enrol MFA to continue.',
      { code: 'PLATFORM_MFA_ENROLLMENT_REQUIRED' });
  }
  if (stage === 'request' && policy.sessionMaxHours > 0 && user.last_login_at) {
    const ageH = (Date.now() - new Date(user.last_login_at).getTime()) / 3_600_000;
    if (ageH > policy.sessionMaxHours) {
      throw new HttpError(401, 'Platform session exceeded the maximum allowed age — sign in again', { code: 'PLATFORM_SESSION_EXPIRED' });
    }
  }
  return policy;
}

module.exports = { getPolicy, setPolicy, assertAllowed, normaliseCidr, ipInCidr, ipAllowed, cleanIp, KEYS };
