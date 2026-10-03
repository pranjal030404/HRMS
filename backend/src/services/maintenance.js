/**
 * Maintenance windows. While a window is active, tenant (non-platform) API traffic gets a 503 with
 * the customer-facing message and the end time; platform operators and the health check are
 * never blocked, so an operator can still finish the work. The active set is cached for 10s.
 */
const { pool } = require('../config/db');

let cache = { at: 0, rows: [] };
const TTL_MS = 10_000;
const invalidate = () => { cache = { at: 0, rows: [] }; };

async function active() {
  if (Date.now() - cache.at < TTL_MS) return cache.rows;
  const [rows] = await pool.query(
    `SELECT id, tenant_id, message, ends_at FROM maintenance_windows
      WHERE status = 'scheduled' AND starts_at <= NOW() AND ends_at > NOW()`);
  cache = { at: Date.now(), rows };
  return rows;
}

/** The window (if any) that blocks this tenant right now. */
async function blockingFor(tenantId) {
  const rows = await active();
  return rows.find((w) => w.tenant_id === null || Number(w.tenant_id) === Number(tenantId)) || null;
}

module.exports = { blockingFor, invalidate, active };
