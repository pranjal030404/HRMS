const { pool } = require('../config/db');

/**
 * Append-only audit trail. Never throws to the caller (audit must not break business flow).
 * before/after: plain objects (sensitive fields should already be masked by the caller).
 */
async function logAudit({ tenantId, actor, action, entityType, entityId, before, after, req }) {
  try {
    await pool.query(
      `INSERT INTO audit_logs (tenant_id, actor_user_id, actor_name, actor_role, action, entity_type, entity_id, before_json, after_json, ip, user_agent)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [
        tenantId ?? null,
        actor?.id ?? null,
        actor?.name || null,
        actor?.role || null,
        action,
        entityType || null,
        entityId !== undefined && entityId !== null ? String(entityId) : null,
        before ? JSON.stringify(before) : null,
        after ? JSON.stringify(after) : null,
        req?.ip || null,
        (req?.headers?.['user-agent'] || '').slice(0, 250) || null,
      ]
    );
  } catch (e) {
    console.error('[audit] failed to write audit log:', e.message);
  }
}

module.exports = { logAudit };
