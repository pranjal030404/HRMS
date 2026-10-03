/**
 * Platform audit trail (spec §30).
 *
 * Separate from `services/audit.js` on purpose. The tenant trail answers "what
 * did this person do inside their own company"; this one answers "what did
 * ARTHVEX do to a customer" — plan changes, entitlement overrides, suspensions,
 * support grants, deletion requests. It keeps a `reason`, a target tenant and the
 * before/after pair, and it is append-only (there is no update or delete path).
 *
 * Like the tenant trail it never throws into the caller's flow: a failed audit
 * write must not roll back a legitimate suspension, but it must be loud.
 */
const { pool } = require('../config/db');

/**
 * @param {object} entry
 * @param {number|null} entry.tenantId   target tenant, or null for a platform-wide action
 * @param {object} [entry.actor]        req.user (or a {id,name,email,role} shape)
 * @param {string} entry.action         dotted action, e.g. 'plan.change'
 * @param {string} [entry.category]     tenant|subscription|plan|entitlement|usage|support|security|data|integration
 */
async function logPlatformAudit({
  tenantId, actor, action, category, entityType, entityId, before, after, reason, outcome, req,
}) {
  try {
    await pool.query(
      `INSERT INTO platform_audit_logs
         (tenant_id, actor_user_id, actor_name, actor_email, actor_role, action, category,
          entity_type, entity_id, before_json, after_json, reason, outcome, ip, user_agent, request_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        tenantId ?? null,
        actor?.id ?? null,
        actor?.name || null,
        actor?.email || null,
        actor?.role || null,
        action,
        category || inferCategory(action),
        entityType || null,
        entityId !== undefined && entityId !== null ? String(entityId) : null,
        before ? JSON.stringify(before) : null,
        after ? JSON.stringify(after) : null,
        reason || null,
        outcome || 'success',
        req?.ip || null,
        (req?.headers?.['user-agent'] || '').slice(0, 250) || null,
        req?.requestId || null,
      ]
    );
  } catch (e) {
    console.error('[platform-audit] failed to write platform audit log:', e.message);
  }
}

/** Best-effort grouping so the console can filter without hard-coding action lists. */
function inferCategory(action) {
  const head = String(action || '').split('.')[0];
  const map = {
    tenant: 'tenant', subscription: 'subscription', plan: 'plan',
    entitlement: 'entitlement', override: 'entitlement', usage: 'usage',
    support: 'support', security: 'security', data: 'data', export: 'data',
    deletion: 'data', integration: 'integration', api_key: 'integration',
    module: 'tenant', domain: 'tenant', branding: 'tenant',
  };
  return map[head] || 'platform';
}

/** Read side — paged, filterable. Platform scope only; callers gate the route. */
async function list({ limit = 50, offset = 0, tenantId, category, action, actorUserId, since, q } = {}) {
  const where = [];
  const params = [];
  if (tenantId) { where.push('tenant_id = ?'); params.push(tenantId); }
  if (category) { where.push('category = ?'); params.push(category); }
  if (action) { where.push('action LIKE ?'); params.push(`${action}%`); }
  if (actorUserId) { where.push('actor_user_id = ?'); params.push(actorUserId); }
  if (since) { where.push('created_at >= ?'); params.push(since); }
  if (q) { where.push('(action LIKE ? OR reason LIKE ? OR entity_type LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM platform_audit_logs ${clause}`, params);
  const [rows] = await pool.query(
    `SELECT * FROM platform_audit_logs ${clause} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  return { rows: rows.map(decodeRow), total: Number(total) };
}

const decodeRow = (r) => ({
  ...r,
  before_json: parse(r.before_json),
  after_json: parse(r.after_json),
});

const parse = (v) => {
  if (v == null) return null;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return v; }
};

module.exports = { logPlatformAudit, list, PLATFORM_AUDIT_CATEGORIES: ['tenant', 'subscription', 'plan', 'entitlement', 'usage', 'support', 'security', 'data', 'integration', 'platform'] };