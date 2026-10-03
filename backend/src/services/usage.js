/**
 * Usage metering (spec §13).
 *
 * Two ways in:
 *
 *   recompute() — re-derives a counter from the authoritative tables. This is
 *     the truth. Employee and user counts are cheap and exact, so they are always
 *     recomputed rather than nudged.
 *   increment() — appends to a metered counter (API requests, workflow runs,
 *     payroll runs). These are events, not derivable state, so they accumulate
 *     and every delta is written to `usage_events` for dispute resolution.
 *
 * Counters live in `tenant_usage` keyed by (tenant, entitlement, period) so a
 * monthly entitlement resets by rolling the period key, not by a cron job.
 */
const { pool } = require('../config/db');
const { periodKey } = require('./entitlements');

/**
 * Counters that can be re-derived from source tables. Keyed by entitlement key
 * because that is what the plan grants and what the limit gate reads.
 */
const SOURCE_COUNTERS = {
  'employees.max': `
    SELECT COUNT(*) AS n FROM employees WHERE tenant_id = ? AND deleted_at IS NULL`,
  'active_users.max': `
    SELECT COUNT(*) AS n FROM users WHERE tenant_id = ? AND status = 'active'`,
  'admins.max': `
    SELECT COUNT(*) AS n FROM users u
     WHERE u.tenant_id = ? AND u.status = 'active'
       AND (u.role IN ('company_owner','hr_admin','payroll_admin','finance_admin')
            OR u.id IN (SELECT user_id FROM user_roles ur JOIN roles r ON r.id = ur.role_id
                         WHERE r.name IN ('company_owner','hr_admin','payroll_admin','finance_admin')))`,
  'locations.max': `SELECT COUNT(*) AS n FROM locations WHERE tenant_id = ?`,
  'legal_entities.max': `SELECT COUNT(*) AS n FROM legal_entities WHERE tenant_id = ? AND COALESCE(status,'active') <> 'inactive'`,
  'recruitment.jobs.max': `
    SELECT COUNT(*) AS n FROM requisitions WHERE tenant_id = ? AND status IN ('open','approved','in_progress')`,
  'api_keys.max': `SELECT COUNT(*) AS n FROM api_keys WHERE tenant_id = ? AND COALESCE(revoked_at, NULL) IS NULL`,
  'webhooks.max': `SELECT COUNT(*) AS n FROM webhook_subscriptions WHERE tenant_id = ? AND active = 1`,
  'documents.stored': `SELECT COUNT(*) AS n FROM company_documents WHERE tenant_id = ?`,
};

/**
 * Storage is measured from the filesystem rather than the row count, because the
 * vault is what actually costs money to hold. Returns GB, 2dp.
 */
const STORAGE_ENTITLEMENT = 'storage.max_gb';

async function currentUsage(tenantId, entitlementKey) {
  if (entitlementKey === STORAGE_ENTITLEMENT) {
    return storageBytes(tenantId).then((b) => Math.round((b / (1024 ** 3)) * 100) / 100);
  }
  if (SOURCE_COUNTERS[entitlementKey]) {
    const [[{ n }]] = await pool.query(SOURCE_COUNTERS[entitlementKey], [tenantId]);
    return Number(n || 0);
  }
  // Metered counters: read the current period row.
  const key = await periodKeyFor(entitlementKey);
  const [rows] = await pool.query(
    `SELECT current_value FROM tenant_usage
     WHERE tenant_id = ? AND entitlement_id = (SELECT id FROM entitlements WHERE entitlement_key = ?)
       AND period_key = ?`,
    [tenantId, entitlementKey, key]
  );
  return Number(rows[0]?.current_value || 0);
}

/** The counter row's period key, taken from the entitlement's own period. */
async function periodKeyFor(entitlementKey) {
  const [rows] = await pool.query('SELECT period FROM entitlements WHERE entitlement_key = ? LIMIT 1', [entitlementKey]);
  const period = rows[0]?.period || 'none';
  return period === 'none' ? 'lifetime' : periodKey(period);
}

/**
 * Refresh every derivable counter for a tenant.
 * Cheap enough to call on every dashboard load, and it means a counter can never
 * drift from the rows it summarises.
 */
async function recompute(tenantId, { source = 'recompute', actorUserId = null, requestId = null } = {}) {
  const results = {};
  for (const key of Object.keys(SOURCE_COUNTERS)) {
    const value = await currentUsage(tenantId, key);
    results[key] = await writeCounter(tenantId, key, value, { source, actorUserId, requestId });
  }
  if (SOURCE_COUNTERS[STORAGE_ENTITLEMENT]) {
    results[STORAGE_ENTITLEMENT] = await writeCounter(tenantId, STORAGE_ENTITLEMENT, await currentUsage(tenantId, STORAGE_ENTITLEMENT), { source, actorUserId, requestId });
  }
  return results;
}

/**
 * Add to a metered counter. `delta` may be negative (a refund of a voided run).
 * Every call writes a usage_events row so the running total is auditable.
 */
async function increment(tenantId, entitlementKey, delta, { source = 'request', referenceType, referenceId, actorUserId, requestId, metadata } = {}) {
  const [rows] = await pool.query(
    `SELECT id, period FROM entitlements WHERE entitlement_key = ? LIMIT 1`, [entitlementKey]
  );
  const entitlement = rows[0];
  if (!entitlement) return null;
  const key = entitlement.period === 'none' ? 'lifetime' : periodKey(entitlement.period);
  const amount = Number(delta || 0);

  await pool.query(
    `INSERT INTO usage_events (tenant_id, entitlement_id, delta, period_key, source, reference_type, reference_id, actor_user_id, request_id, metadata)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [tenantId, entitlement.id, amount, key, source, referenceType || null, referenceId ? String(referenceId) : null,
      actorUserId ?? null, requestId ?? null, metadata ? JSON.stringify(metadata) : null]
  );
  return writeCounter(tenantId, entitlementKey, amount, { source, actorUserId, requestId }, true);
}

/** Absolute write, used by recompute() and increment() alike. */
async function writeCounter(tenantId, entitlementKey, value, { source, actorUserId, requestId }, relative = false) {
  const [rows] = await pool.query('SELECT id, period FROM entitlements WHERE entitlement_key = ? LIMIT 1', [entitlementKey]);
  const entitlement = rows[0];
  if (!entitlement) return 0;
  const key = entitlement.period === 'none' ? 'lifetime' : periodKey(entitlement.period);

  await pool.query(
    `INSERT INTO tenant_usage (tenant_id, entitlement_id, period_key, current_value, peak_value, last_computed_at)
     VALUES (?,?,?,?,?,NOW())
     ON DUPLICATE KEY UPDATE current_value = ${relative ? 'GREATEST(0, current_value + VALUES(current_value))' : 'VALUES(current_value)'},
                             peak_value = GREATEST(peak_value, ${relative ? 'GREATEST(0, current_value + VALUES(current_value))' : 'VALUES(current_value)'}),
                             last_computed_at = NOW()`,
    [tenantId, entitlement.id, key, value, value]
  );
  const [after] = await pool.query(
    'SELECT current_value FROM tenant_usage WHERE tenant_id = ? AND entitlement_id = ? AND period_key = ?',
    [tenantId, entitlement.id, key]
  );
  void actorUserId; void requestId; void source;
  return Number(after[0]?.current_value || 0);
}

/**
 * Total bytes held by a tenant's documents, from the file sizes the vault
 * actually recorded. Both upload paths are summed — the company library
 * (`company_documents.file_size`) and the employee vault
 * (`employee_documents.size_bytes`) — because a tenant's storage bill covers
 * every file it holds, not only the published policy documents.
 *
 * A missing row directory counts as zero rather than failing the whole recompute:
 * a usage number must never be the reason a page 500s.
 */
async function storageBytes(tenantId) {
  try {
    const [[row]] = await pool.query(
      `SELECT COALESCE(SUM(bytes), 0) AS bytes FROM (
         SELECT COALESCE(file_size, 0) AS bytes FROM company_documents WHERE tenant_id = ?
         UNION ALL
         SELECT COALESCE(size_bytes, 0) AS bytes FROM employee_documents WHERE tenant_id = ?
       ) f`,
      [tenantId, tenantId]
    );
    return Number(row?.bytes || 0);
  } catch (_) {
    return 0;
  }
}

/** All counters for a tenant, for the platform console. */
async function usageFor(tenantId) {
  const [rows] = await pool.query(
    `SELECT e.entitlement_key, e.name, e.kind, e.unit, e.period, u.period_key, u.current_value, u.peak_value, u.updated_at
     FROM tenant_usage u JOIN entitlements e ON e.id = u.entitlement_id
     WHERE u.tenant_id = ? ORDER BY e.sort_order`,
    [tenantId]
  );
  return rows.map((r) => ({
    key: r.entitlement_key, name: r.name, kind: r.kind, unit: r.unit, period: r.period,
    periodKey: r.period_key, current: Number(r.current_value || 0), peak: Number(r.peak_value || 0),
    updatedAt: r.updated_at,
  }));
}

/** Platform-wide rollup for the dashboard cards. */
async function platformTotals() {
  const [rows] = await pool.query(
    `SELECT e.entitlement_key,
            COALESCE(SUM(u.current_value), 0) AS total
     FROM entitlements e
     LEFT JOIN tenant_usage u ON u.entitlement_id = e.id
          AND u.period_key = CASE WHEN e.period = 'none' THEN 'lifetime' ELSE DATE_FORMAT(NOW(), '%Y-%m') END
     WHERE e.kind <> 'boolean'
     GROUP BY e.entitlement_key`
  );
  return Object.fromEntries(rows.map((r) => [r.entitlement_key, Number(r.total || 0)]));
}

module.exports = {
  currentUsage, recompute, increment, usageFor, platformTotals, periodKeyFor,
  storageBytes, SOURCE_COUNTERS, STORAGE_ENTITLEMENT,
};