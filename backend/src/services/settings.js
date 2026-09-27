const { pool } = require('../config/db');
const { logAudit } = require('./audit');

/** Settings are stored as one JSON blob per key per tenant. */
async function getSetting(tenantId, key, defaults = {}) {
  const [rows] = await pool.query('SELECT svalue FROM settings WHERE tenant_id = ? AND skey = ?', [tenantId, key]);
  let value = {};
  if (rows[0]) {
    try { value = typeof rows[0].svalue === 'string' ? JSON.parse(rows[0].svalue) : rows[0].svalue; } catch (_) { value = {}; }
  }
  return { ...defaults, ...value };
}

async function setSetting(tenantId, key, value) {
  await pool.query(
    `INSERT INTO settings (tenant_id, skey, svalue) VALUES (?,?,?)
     ON DUPLICATE KEY UPDATE svalue = VALUES(svalue)`,
    [tenantId, key, JSON.stringify(value)]
  );
}

module.exports = { getSetting, setSetting };
