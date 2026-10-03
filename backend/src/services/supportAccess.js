/**
 * Support Access (spec §21).
 *
 * The mechanism that replaces "the super admin can read every customer's HR
 * data because they are a super admin". A platform operator takes access to a
 * specific tenant by stating a reason, choosing an access type and a duration.
 * The grant expires on its own, is revocable before then, and every action taken
 * under it is written to `support_access_logs`.
 *
 * Design rules:
 *   • `expires_at` is NOT NULL. There is no permanent row and no "trusted
 *     operator" escape hatch — a session is a session.
 *   • Granting requires `platform.support.grant`; a Support Admin can therefore
 *     be created without ever holding tenant HRMS permissions.
 *   • Reads are logged, not just writes: an operator browsing payroll is exactly
 *     the thing an audit has to be able to reconstruct.
 *   • `requires_approval` is enforced, not decorative. A session created that way
 *     starts in `pending` and grants nothing until a *different* operator
 *     approves it (spec §21, "Optional Approval") — which is what stops a single
 *     compromised admin account from both taking and approving access.
 */
const { pool } = require('../config/db');
const { HttpError } = require('../utils/helpers');
const { logPlatformAudit } = require('./platformAudit');

const ACCESS_TYPES = ['read_only', 'tenant_administration', 'configuration'];
const MAX_DURATION_MINUTES = 8 * 60;   // a hard ceiling, independent of who asks

/**
 * Grant a time-limited session. `actor` must already have been checked for
 * `platform.support.grant` by the route; this function enforces the rest of the
 * shape so a second caller cannot skip it.
 */
async function grant({ tenantId, reason, accessType = 'read_only', durationMinutes = 30, scope, ticketRef, requiresApproval = false, actor, req }) {
  if (!reason || String(reason).trim().length < 10) {
    throw new HttpError(400, 'A reason of at least 10 characters is required — this is what the customer audit shows');
  }
  if (!ACCESS_TYPES.includes(accessType)) {
    throw new HttpError(400, `Unknown access type "${accessType}". Expected one of: ${ACCESS_TYPES.join(', ')}`);
  }
  const minutes = Number(durationMinutes);
  if (!Number.isInteger(minutes) || minutes < 5 || minutes > MAX_DURATION_MINUTES) {
    throw new HttpError(400, `Duration must be between 5 and ${MAX_DURATION_MINUTES} minutes`);
  }
  const [[tenant]] = await pool.query('SELECT id, name FROM tenants WHERE id = ?', [tenantId]);
  if (!tenant) throw new HttpError(404, 'Tenant not found');

  const expiresAt = new Date(Date.now() + minutes * 60000);
  const [ins] = await pool.query(
    `INSERT INTO support_access_sessions
       (tenant_id, granted_by, granted_by_name, reason, ticket_ref, access_type, scope_json, requires_approval, status, expires_at, ip, user_agent)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [tenantId, actor?.id ?? null, actor?.name || null, String(reason).trim(), ticketRef || null,
      accessType, scope ? JSON.stringify(scope) : null, requiresApproval ? 1 : 0,
      requiresApproval ? 'pending' : 'active', expiresAt,
      req?.ip || null, (req?.headers?.['user-agent'] || '').slice(0, 250) || null]
  );

  await logPlatformAudit({
    tenantId, actor, action: 'support.access_granted', category: 'support',
    entityType: 'support_access_session', entityId: ins.insertId,
    after: {
      accessType, durationMinutes: minutes, expiresAt, ticketRef: ticketRef || null,
      // A session that needs approval is granted but inert; `status` carries the
      // distinction, and the follow-up `support.access_approved` action records
      // when it became usable.
      status: requiresApproval ? 'pending' : 'active',
      requiresApproval: !!requiresApproval,
    },
    reason: String(reason).trim(), req,
  });
  const session = await byId(ins.insertId);
  return session;
}

/**
 * Second-operator approval for a session created with `requires_approval`.
 * The approver must be a different person from the requester — self-approval
 * would make the flag decorative.
 */
async function approve(sessionId, { actor, req, reason } = {}) {
  const [rows] = await pool.query('SELECT * FROM support_access_sessions WHERE id = ?', [sessionId]);
  const session = rows[0];
  if (!session) throw new HttpError(404, 'Support access session not found');
  if (session.status !== 'pending') throw new HttpError(409, `That session is ${session.status}, not awaiting approval`);
  if (Number(session.granted_by) === Number(actor?.id)) {
    throw new HttpError(409, 'A support access request must be approved by a different operator');
  }
  await pool.query(
    `UPDATE support_access_sessions SET status = 'active', approved_by = ?, approved_at = NOW() WHERE id = ? AND status = 'pending'`,
    [actor?.id ?? null, sessionId]
  );
  await logPlatformAudit({
    tenantId: session.tenant_id, actor, action: 'support.access_approved', category: 'support',
    entityType: 'support_access_session', entityId: sessionId,
    before: { status: 'pending' }, after: { status: 'active' }, reason, req,
  });
  return byId(sessionId);
}

async function byId(id) {
  const [rows] = await pool.query(
    `SELECT s.*, t.name AS tenant_name, t.slug AS tenant_slug
     FROM support_access_sessions s JOIN tenants t ON t.id = s.tenant_id WHERE s.id = ?`, [id]
  );
  return decode(rows[0]);
}

const decode = (row) => (row ? { ...row, scope: parse(row.scope_json) } : null);
const parse = (v) => {
  if (v == null) return null;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return v; }
};

/**
 * The caller's active session for a tenant, or null. Expiry is evaluated here
 * rather than by a background job, so a session is dead the instant its clock
 * runs out — there is no window in which an expired grant is still honoured.
 */
async function activeSessionFor(userId, tenantId) {
  if (!userId || tenantId == null) return null;
  const [rows] = await pool.query(
    `SELECT * FROM support_access_sessions
     WHERE granted_by = ? AND tenant_id = ? AND status = 'active' AND expires_at > NOW()
     ORDER BY expires_at DESC LIMIT 1`,
    [userId, tenantId]
  );
  if (!rows[0]) return null;
  return decode(rows[0]);
}

/** Any active session for a caller, for the "you are currently in…" banner. */
async function currentSession(userId) {
  if (!userId) return null;
  const [rows] = await pool.query(
    `SELECT s.*, t.name AS tenant_name FROM support_access_sessions s
     JOIN tenants t ON t.id = s.tenant_id
     WHERE s.granted_by = ? AND s.status = 'active' AND s.expires_at > NOW()
     ORDER BY s.expires_at DESC LIMIT 1`,
    [userId]
  );
  return decode(rows[0]);
}

/**
 * Can `user` address `tenantId` as a platform operator?
 *
 * Bound-tenant administrators may always address their own company. Reaching a
 * *different* company requires a live support session — there is no third option.
 */
async function assertTenantReach(user, tenantId) {
  if (!user) throw new HttpError(401, 'Authentication required');
  const target = Number(tenantId);
  if (user.tenant_id != null && Number(user.tenant_id) === target) return { via: 'own_tenant' };
  if (!user.isPlatformAdmin) {
    // A tenant user addressing somebody else's company: refuse without leaking
    // whether that company exists.
    throw new HttpError(404, 'Not found');
  }
  const session = await activeSessionFor(user.id, target);
  if (!session) {
    throw new HttpError(403,
      'Access to another company requires an active support access session. Request one with a reason and a duration.',
      { requiresSupportAccess: true, tenantId: target });
  }
  return { via: 'support_access', session };
}

/** Record an action taken under a session. Cheap enough to do on every request. */
async function logAction(session, { userId, action, method, path, entityType, entityId, req }) {
  if (!session) return;
  try {
    await pool.query(
      `INSERT INTO support_access_logs (session_id, tenant_id, actor_user_id, action, method, path, entity_type, entity_id, request_id, ip)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [session.id, session.tenant_id, userId, action, method || null, (path || '').slice(0, 255) || null,
        entityType || null, entityId ? String(entityId) : null, req?.requestId || null, req?.ip || null]
    );
  } catch (e) {
    console.error('[support-access] failed to log action:', e.message);
  }
}

/** End a session before its natural expiry. */
async function revoke(sessionId, { reason, actor, req }) {
  const [rows] = await pool.query('SELECT * FROM support_access_sessions WHERE id = ?', [sessionId]);
  const session = rows[0];
  if (!session) throw new HttpError(404, 'Support access session not found');
  if (session.status !== 'active') return decode(session);
  await pool.query(
    `UPDATE support_access_sessions SET status = 'revoked', revoked_at = NOW(), revoked_reason = ? WHERE id = ?`,
    [reason || null, sessionId]
  );
  await logPlatformAudit({
    tenantId: session.tenant_id, actor, action: 'support.access_revoked', category: 'support',
    entityType: 'support_access_session', entityId: sessionId,
    before: { status: 'active', expiresAt: session.expires_at },
    after: { status: 'revoked' }, reason, req,
  });
  return byId(sessionId);
}

/**
 * Expire sessions whose clock has run out. Called opportunistically on list/summary
 * reads; correctness does not depend on it because every read re-checks expiry.
 */
async function sweepExpired() {
  const [res] = await pool.query(
    `UPDATE support_access_sessions SET status = 'expired'
     WHERE status = 'active' AND expires_at <= NOW()`
  );
  return res.affectedRows;
}

/** Platform-wide list with the caller/tenant joined for the console. */
async function list({ tenantId, status, limit = 50, offset = 0 } = {}) {
  const where = [];
  const params = [];
  if (tenantId) { where.push('s.tenant_id = ?'); params.push(tenantId); }
  if (status) { where.push('s.status = ?'); params.push(status); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM support_access_sessions s ${clause}`, params);
  const [rows] = await pool.query(
    `SELECT s.*, t.name AS tenant_name, t.slug AS tenant_slug
     FROM support_access_sessions s JOIN tenants t ON t.id = s.tenant_id
     ${clause} ORDER BY s.created_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  return { rows: rows.map(decode), total: Number(total) };
}

async function logsForSession(sessionId, limit = 200) {
  const [rows] = await pool.query(
    'SELECT * FROM support_access_logs WHERE session_id = ? ORDER BY created_at DESC LIMIT ?', [sessionId, limit]
  );
  return rows;
}

module.exports = {
  grant, approve, revoke, byId, list, logsForSession, activeSessionFor, currentSession,
  assertTenantReach, logAction, sweepExpired, ACCESS_TYPES, MAX_DURATION_MINUTES,
};