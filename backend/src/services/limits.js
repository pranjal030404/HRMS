/**
 * Limit enforcement (spec §14, §15).
 *
 * The single write-path gate. Controllers call `assertWithinLimit(...)` before
 * creating a record that consumes a metered resource; the frontend may warn
 * ahead of time but is never the control (spec §43).
 *
 * A soft/hard split matters commercially: hitting the employee cap should stop
 * employee #501, not lock the existing workforce out of their own payroll
 * history. `onExhausted` lets each caller say what "exhausted" means for that
 * resource, so a limit never has to be enforced by shutting something unrelated
 * down.
 */
const { HttpError } = require('../utils/helpers');
const entitlements = require('./entitlements');
const usage = require('./usage');

/**
 * @param {object} opts
 * @param {number} opts.tenantId
 * @param {string} opts.entitlementKey   e.g. 'employees.max'
 * @param {number} [opts.incoming]      how many the operation would add (default 1)
 * @param {string} [opts.onExhausted]   'block' (default) | 'warn'
 * @param {string} [opts.action]        used in the error message
 * @param {object} [opts.req]           stamped onto the platform/tenant audit trail
 */
async function assertWithinLimit({ tenantId, entitlementKey, incoming = 1, onExhausted = 'block', action, req }) {
  const snap = await entitlements.resolveTenant(tenantId);
  const entry = snap.entitlements[entitlementKey];

  if (!entry) {
    // No such entitlement: nothing is being charged for it. Not an error.
    return { ok: true, unlimited: true, entitlement: null };
  }
  if (snap.blocked) {
    throw new HttpError(403, `This company is ${snap.tenant.status.replace(/_/g, ' ')}`);
  }
  if (onExhausted === 'block' && snap.readOnly) {
    throw new HttpError(403,
      `Your subscription is ${snap.subscription?.status?.replace(/_/g, ' ') || snap.tenant.status.replace(/_/g, ' ')} — existing records remain readable but nothing new can be created.`);
  }

  if (entry.kind === 'boolean') {
    if (!entry.enabled) {
      throw new HttpError(402,
        `${entry.name} is not included in your plan`, { entitlementKey, plan: snap.plan?.key, tenantStatus: snap.tenant.status });
    }
    return { ok: true, entitlement: entry };
  }

  // No cap at all is unlimited; a cap of 0 is a deliberate "none included".
  if (entry.unlimited) return { ok: true, unlimited: true, entitlement: entry };

  const limit = entry.value;
  const current = await usage.currentUsage(tenantId, entitlementKey);
  const projected = current + Number(incoming || 0);

  if (projected > limit) {
    if (onExhausted === 'warn') {
      return { ok: true, warning: true, entitlement: entry, current, limit, projected };
    }
    throw new HttpError(402, buildLimitMessage({ entry, current, limit, incoming, snap }), {
      entitlementKey, current, limit, requested: Number(incoming || 0),
      limitSource: entry.source, plan: snap.plan?.key, subscription: snap.subscription?.status,
    });
  }

  const pct = limit > 0 ? (current / limit) * 100 : 0;
  return {
    ok: true,
    entitlement: entry,
    current,
    limit,
    projected,
    status: entitlements.usageStatus(entry, current, limit),
    warning: pct >= entry.warningPct,
  };
}

function buildLimitMessage({ entry, current, limit, incoming, snap }) {
  const unit = entry.unit || '';
  // `entry.name` is the commercial noun ("Payroll runs per month", "API keys") and
  // is far clearer than a de-pluralised unit — "Run limit reached" tells an
  // administrator nothing about which limit they hit.
  const source = entry.source === 'override'
    ? 'a custom override on your company'
    : entry.source === 'plan'
      ? `your ${snap.plan?.name || ''} plan`
      : 'your current limit';
  if (!limit) {
    const planSource = entry.source === 'plan' ? `your ${snap.plan?.name || ''} plan` : 'your current entitlements';
    return `${entry.name} ${entry.period === 'month' ? 'this month' : ''} are not included in ${planSource}. Upgrade your plan or ask ARTHVEX to enable them.`
      .replace('  ', ' ');
  }
  const period = entry.period === 'month' ? ' this month' : '';
  return `${entry.name} limit reached — ${current} of ${limit} ${unit}${period} used, from ${source}. Upgrade your plan or ask ARTHVEX to raise the limit.`;
}

/**
 * Soft-limit sweep: every counter that is at/over a threshold. Drives the
 * platform dashboard's "limit breaches" panel and the billing nudges.
 */
async function breaches(tenantIds) {
  let targets = tenantIds;
  if (!targets || !targets.length) {
    const { pool } = require('../config/db');
    const [rows] = await pool.query('SELECT id FROM tenants WHERE status <> \'deleted\'');
    targets = rows.map((r) => r.id);
  }
  const out = [];
  for (const tenantId of targets) {
    const snap = await entitlements.resolveTenant(tenantId);
    for (const entry of Object.values(snap.entitlements)) {
      if (entry.kind === 'boolean' || entry.unlimited) continue;
      const current = await usage.currentUsage(tenantId, entry.key);
      const status = entitlements.usageStatus(entry, current, entry.value);
      if (status === 'ok') continue;
      out.push({
        tenantId, tenantName: snap.tenant.name, plan: snap.plan?.key || null,
        entitlementKey: entry.key, entitlementName: entry.name,
        current, limit: entry.value, status,
        percentUsed: entry.value > 0 ? Math.round((current / entry.value) * 1000) / 10 : 0,
        subscriptionStatus: snap.subscription?.status || null,
      });
    }
  }
  return out.sort((a, b) => b.percentUsed - a.percentUsed);
}

/**
 * Serialise "check the cap, then consume it" per company and resource.
 *
 * `assertWithinLimit` reads a count and the caller inserts afterwards; two requests
 * arriving together both read 499 and both insert, ending at 501. A MySQL named lock
 * held across the whole check-and-insert makes the second request wait and then see
 * the first one's row. Locks are per (tenant, name), so unrelated companies never queue.
 */
async function withTenantLock(tenantId, name, fn, { timeoutSeconds = 15 } = {}) {
  const { pool } = require('../config/db');
  const lockName = `arthvex:${tenantId}:${name}`.slice(0, 64);
  const conn = await pool.getConnection();
  try {
    const [[row]] = await conn.query('SELECT GET_LOCK(?, ?) AS got', [lockName, timeoutSeconds]);
    if (Number(row.got) !== 1) throw new HttpError(503, 'The system is busy creating records for this company — please retry');
    try {
      return await fn();
    } finally {
      await conn.query('SELECT RELEASE_LOCK(?)', [lockName]).catch(() => {});
    }
  } finally {
    conn.release();
  }
}

/** Wrap an Express handler so it runs under the per-company lock named `name`. */
const locked = (name, handler) => (req, res, next) =>
  withTenantLock(req.user.tenant_id, name, () => handler(req, res, next));

module.exports = { assertWithinLimit, breaches, withTenantLock, locked };