const { pool } = require('../config/db');

/**
 * Append-only audit trail — the single source of truth for "who changed what".
 *
 * Never throws to the caller: a failed audit write must not break a business
 * flow, but it must be loud in the logs. before/after are plain objects — callers
 * are responsible for masking anything sensitive before they get here.
 *
 * The Administration Center reads this same table through the `admin_audit_logs`
 * view; there is no second audit store to drift out of sync.
 */
async function logAudit({ tenantId, actor, action, entityType, entityId, before, after, req, module, outcome }) {
  try {
    await pool.query(
      `INSERT INTO audit_logs
         (tenant_id, actor_user_id, actor_name, actor_role, actor_email, action, module, entity_type, entity_id,
          before_json, after_json, ip, user_agent, request_id, outcome)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        tenantId ?? null,
        actor?.id ?? null,
        actor?.name || null,
        actor?.role || null,
        actor?.email || null,
        action,
        module || 'general',
        entityType || null,
        entityId !== undefined && entityId !== null ? String(entityId) : null,
        before ? JSON.stringify(before) : null,
        after ? JSON.stringify(after) : null,
        req?.ip || null,
        (req?.headers?.['user-agent'] || '').slice(0, 250) || null,
        req?.requestId || null,
        outcome || 'success',
      ]
    );
  } catch (e) {
    console.error('[audit] failed to write audit log:', e.message);
  }
}

module.exports = { logAudit };