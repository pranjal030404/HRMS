/**
 * In-app notifications for ARTHVEX operators (trial ending, payment failed, limit near, …).
 *
 * `dedupe` is the guard against noise: the same condition inside the same key is stored once,
 * so a tenant sitting at 85% of a limit produces one notification, not one per request.
 * Email delivery is the existing notify service's job; this table is the in-app inbox.
 */
const { pool } = require('../config/db');

const EVENTS = [
  'trial_ending', 'payment_failed', 'subscription_renewed', 'plan_changed', 'limit_reached', 'limit_near',
  'tenant_suspended', 'tenant_reactivated', 'support_access_started', 'support_access_expired',
  'security_alert', 'integration_failed', 'cancellation_requested', 'incident_opened',
];

async function notify({ event, severity = 'info', tenantId = null, title, body = null, dedupe = null }) {
  if (!EVENTS.includes(event)) throw new Error(`Unknown platform notification event "${event}"`);
  try {
    const [ins] = await pool.query(
      `INSERT INTO platform_notifications (event_key, severity, tenant_id, title, body, dedupe_key) VALUES (?,?,?,?,?,?)`,
      [event, severity, tenantId, String(title).slice(0, 200), body ? String(body).slice(0, 1000) : null, dedupe ? String(dedupe).slice(0, 160) : null]);
    return { created: true, id: ins.insertId };
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return { created: false };
    throw e;
  }
}

async function list({ unreadOnly = false, limit = 50 } = {}) {
  const [rows] = await pool.query(
    `SELECT n.*, t.name AS tenant_name FROM platform_notifications n LEFT JOIN tenants t ON t.id = n.tenant_id
     ${unreadOnly ? 'WHERE n.read_at IS NULL' : ''} ORDER BY n.created_at DESC, n.id DESC LIMIT ?`, [limit]);
  return rows;
}

async function markRead(ids) {
  if (!ids?.length) return 0;
  const [r] = await pool.query('UPDATE platform_notifications SET read_at = NOW() WHERE read_at IS NULL AND id IN (?)', [ids]);
  return r.affectedRows;
}

module.exports = { notify, list, markRead, EVENTS };
