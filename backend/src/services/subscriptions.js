/**
 * Subscription lifecycle (spec §26).
 *
 * State changes only ever happen through `transition()`, which validates the move
 * against the lifecycle graph, writes an immutable `subscription_events` row and
 * mirrors the tenant lifecycle state where the two are meant to track each other.
 * Nothing else is allowed to `UPDATE subscriptions SET status`, because that is
 * how billing and entitlement state drift apart.
 */
const { pool } = require('../config/db');
const { HttpError } = require('../utils/helpers');
const { logPlatformAudit } = require('./platformAudit');
const entitlements = require('./entitlements');
const { SUBSCRIPTION_STATUSES, TENANT_STATUSES, LEGACY_PLAN_ALIASES } = require('../utils/permissions');

/**
 * Allowed lifecycle moves. An unlisted transition is refused rather than applied,
 * so a stray API call cannot put a cancelled subscription back into `active`.
 */
const TRANSITIONS = {
  trialing: ['active', 'cancelled', 'expired', 'suspended'],
  active: ['past_due', 'grace_period', 'suspended', 'cancelled', 'expired'],
  past_due: ['grace_period', 'active', 'suspended', 'cancelled', 'expired'],
  grace_period: ['active', 'past_due', 'suspended', 'cancelled', 'expired'],
  suspended: ['active', 'cancelled', 'expired', 'past_due'],
  cancelled: ['active'],
  expired: ['active', 'cancelled'],
};

/** Subscription states that mirror onto `tenants.status`. */
const MIRRORED_TENANT_STATE = {
  trialing: 'trial', active: 'active', past_due: 'past_due', grace_period: 'grace_period',
  suspended: 'suspended', cancelled: 'cancelled', expired: 'cancelled',
};

function assertTransition(from, to) {
  if (!SUBSCRIPTION_STATUSES.includes(to)) {
    throw new HttpError(400, `Unknown subscription status "${to}". Expected one of: ${SUBSCRIPTION_STATUSES.join(', ')}`);
  }
  if (from === to) return; // idempotent, still recorded as an event
  const allowed = TRANSITIONS[from] || [];
  if (!allowed.includes(to)) {
    throw new HttpError(409, `A subscription cannot move from "${from}" to "${to}"`, { from, to, allowed });
  }
}

/**
 * Move a subscription to a new state. Optionally resolves the plan entitlement
 * cache, recomputes usage, and mirrors the tenant lifecycle state.
 */
async function transition(subscriptionId, toStatus, { actor, reason, req, patch = {} } = {}) {
  const [rows] = await pool.query('SELECT * FROM subscriptions WHERE id = ?', [subscriptionId]);
  const sub = rows[0];
  if (!sub) throw new HttpError(404, 'Subscription not found');
  assertTransition(sub.status, toStatus);

  const sets = ['status = ?', 'updated_at = NOW()'];
  const params = [toStatus];
  if (toStatus === 'active') {
    sets.push('suspended_at = NULL', 'grace_ends_at = NULL');
    sets.push('current_period_start = COALESCE(current_period_start, NOW())');
  }
  if (toStatus === 'suspended') { sets.push('suspended_at = NOW()'); }
  if (toStatus === 'past_due') { sets.push('grace_ends_at = DATE_ADD(NOW(), INTERVAL 7 DAY)'); }
  if (toStatus === 'grace_period') { sets.push('grace_ends_at = DATE_ADD(NOW(), INTERVAL 7 DAY)'); }
  if (toStatus === 'cancelled') { sets.push('cancelled_at = NOW()'); }
  for (const [k, v] of Object.entries(patch)) {
    if (!['price_per_period', 'quantity', 'billing_cycle', 'auto_renew', 'external_ref', 'notes', 'trial_ends_at', 'cancel_at_period_end'].includes(k)) continue;
    sets.push(`${k} = ?`);
    params.push(v);
  }
  params.push(subscriptionId);
  await pool.query(`UPDATE subscriptions SET ${sets.join(', ')} WHERE id = ?`, params);

  const [after] = await pool.query('SELECT * FROM subscriptions WHERE id = ?', [subscriptionId]);
  await recordEvent(sub, toStatus, { actor, reason, req, metadata: patch });

  // Keep the tenant lifecycle row in step so the Companies list can filter on one field.
  const mirror = MIRRORED_TENANT_STATE[toStatus];
  if (mirror && TENANT_STATUSES.includes(mirror) && sub.status !== toStatus) {
    await setTenantStatus(sub.tenant_id, mirror, { actor, reason, req });
  }

  entitlements.invalidateTenant(sub.tenant_id);
  await logPlatformAudit({
    tenantId: sub.tenant_id, actor, action: 'subscription.transition', category: 'subscription',
    entityType: 'subscription', entityId: sub.id,
    before: { status: sub.status, plan: sub.plan_key },
    after: { status: after[0].status, plan: after[0].plan_key, ...patch },
    reason, req,
  });
  return after[0];
}

/** Create (or re-attach) a subscription for a tenant on a plan. */
async function create(args) {
  // Two simultaneous provisioning calls must not both pass the "no live subscription" check;
  // the database also refuses a second live row (uq_live_sub), this just gives a clean answer.
  const limits = require('./limits');
  return limits.withTenantLock(args.tenantId, 'subscription', () => createLocked(args));
}

async function createLocked({ tenantId, planKey, billingCycle = 'monthly', quantity = 0, trialDays = 0, pricePerPeriod = 0, actor, req, reason }) {
  const [existing] = await pool.query(
    `SELECT * FROM subscriptions WHERE tenant_id = ? AND status NOT IN ('cancelled','expired') LIMIT 1`, [tenantId]
  );
  if (existing[0]) {
    // One live subscription per tenant. Changing the commercial terms is a plan
    // change, not a second subscription, so the caller is told to use that path.
    throw new HttpError(409, 'This company already has an active subscription — change its plan instead', { subscriptionId: existing[0].id });
  }
  const key = LEGACY_PLAN_ALIASES[planKey] || planKey;
  const [[plan]] = await pool.query('SELECT * FROM platform_plans WHERE plan_key = ?', [key]);
  if (!plan) throw new HttpError(404, `Unknown plan "${planKey}"`);

  const status = trialDays > 0 ? 'trialing' : 'active';
  const [ins] = await pool.query(
    `INSERT INTO subscriptions (tenant_id, plan_id, plan_key, status, billing_cycle, quantity, price_per_period,
        trial_ends_at, current_period_start, current_period_end, created_by)
     VALUES (?,?,?,?,?,?,?,?,NOW(), DATE_ADD(NOW(), INTERVAL 1 MONTH), ?)`,
    [tenantId, plan.id, key, status, billingCycle, quantity, pricePerPeriod || plan.price_monthly,
      trialDays > 0 ? new Date(Date.now() + trialDays * 86400000) : null, actor?.id ?? null]
  );
  const [created] = await pool.query('SELECT * FROM subscriptions WHERE id = ?', [ins.insertId]);
  await recordEvent({ ...created[0], status: null }, status, { actor, reason, req });
  await setTenantStatus(tenantId, MIRRORED_TENANT_STATE[status], { actor, reason, req });
  await logPlatformAudit({
    tenantId, actor, action: 'subscription.create', category: 'subscription',
    entityType: 'subscription', entityId: ins.insertId,
    after: { planKey: key, status, billingCycle }, reason, req,
  });
  entitlements.invalidateTenant(tenantId);
  return created[0];
}

/**
 * What would moving to `planKey` do? Lists every cap the tenant already exceeds (retained, but no
 * new additions) and every module it would lose (data retained, new use blocked). Nothing is changed.
 */
async function previewPlanChange({ subscriptionId, planKey }) {
  const usage = require('./usage');
  const [[sub]] = await pool.query('SELECT * FROM subscriptions WHERE id = ?', [subscriptionId]);
  if (!sub) throw new HttpError(404, 'Subscription not found');
  const key = LEGACY_PLAN_ALIASES[planKey] || planKey;
  const [[plan]] = await pool.query('SELECT * FROM platform_plans WHERE plan_key = ?', [key]);
  if (!plan) throw new HttpError(404, `Unknown plan "${planKey}"`);
  const [[cur]] = await pool.query('SELECT id, price_monthly FROM platform_plans WHERE plan_key = ?', [sub.plan_key]);
  const [rows] = await pool.query(
    `SELECT e.entitlement_key, e.name, e.kind, e.unit, e.module_key,
            (SELECT pe.value FROM plan_entitlements pe WHERE pe.plan_id = ? AND pe.entitlement_id = e.id
               AND (pe.effective_until IS NULL OR pe.effective_until > NOW()) LIMIT 1) AS new_value,
            (SELECT pe.value FROM plan_entitlements pe WHERE pe.plan_id = ? AND pe.entitlement_id = e.id
               AND (pe.effective_until IS NULL OR pe.effective_until > NOW()) LIMIT 1) AS old_value
       FROM entitlements e`, [plan.id, cur ? cur.id : 0]);
  const overages = []; const modulesLost = [];
  for (const r of rows) {
    if (r.kind === 'boolean') {
      const was = ['1', 'true', 'yes'].includes(String(r.old_value)); const will = ['1', 'true', 'yes'].includes(String(r.new_value));
      if (was && !will && r.module_key) modulesLost.push({ key: r.entitlement_key, name: r.name });
      continue;
    }
    if (r.new_value === null || r.new_value === undefined) continue; // no cap on the new plan
    const limit = Number(r.new_value);
    const current = await usage.currentUsage(sub.tenant_id, r.entitlement_key).catch(() => 0);
    if (current > limit) overages.push({ key: r.entitlement_key, name: r.name, unit: r.unit, current, newLimit: limit, over: current - limit });
  }
  return {
    from: sub.plan_key, to: plan.plan_key, direction: Number(plan.price_monthly) >= Number(cur?.price_monthly || 0) ? 'upgrade' : 'downgrade',
    overages, modulesLost,
    policy: 'Existing records are kept. Anything over a new cap stays, but nothing further can be added until usage is back under it or the plan is upgraded.',
  };
}

/** Move a tenant onto a different plan, optionally with bespoke entitlements. */
async function changePlan({ subscriptionId, planKey, actor, req, reason }) {
  const [rows] = await pool.query('SELECT * FROM subscriptions WHERE id = ?', [subscriptionId]);
  const sub = rows[0];
  if (!sub) throw new HttpError(404, 'Subscription not found');
  const key = LEGACY_PLAN_ALIASES[planKey] || planKey;
  const [[plan]] = await pool.query('SELECT * FROM platform_plans WHERE plan_key = ?', [key]);
  if (!plan) throw new HttpError(404, `Unknown plan "${planKey}"`);
  if (plan.plan_key === sub.plan_key) return sub;
  const preview = await previewPlanChange({ subscriptionId, planKey: key });

  await pool.query(
    'UPDATE subscriptions SET plan_id = ?, plan_key = ?, price_per_period = ? WHERE id = ?',
    [plan.id, plan.plan_key, plan.price_monthly, subscriptionId]
  );
  // tenants.plan is the denormalised mirror the tenant app still reads.
  await pool.query('UPDATE tenants SET plan = ? WHERE id = ?', [plan.plan_key, sub.tenant_id]);
  await logPlatformAudit({
    tenantId: sub.tenant_id, actor, action: 'subscription.plan_change', category: 'plan',
    entityType: 'subscription', entityId: subscriptionId,
    before: { plan: sub.plan_key }, after: { plan: plan.plan_key }, reason, req,
  });
  await recordEvent(sub, sub.status, { actor, reason, req, metadata: { planChangedTo: plan.plan_key, direction: preview.direction, overages: preview.overages, modulesLost: preview.modulesLost } });
  entitlements.invalidateTenant(sub.tenant_id);
  await require('./platformNotifications').notify({
    event: 'plan_changed', severity: preview.overages.length ? 'warning' : 'info', tenantId: sub.tenant_id,
    title: `Plan ${preview.direction}: ${sub.plan_key} → ${plan.plan_key}`,
    body: preview.overages.length ? `Over the new limits: ${preview.overages.map((o) => `${o.name} ${o.current}/${o.newLimit}`).join(', ')}` : null,
    dedupe: `plan-change:${subscriptionId}:${Date.now()}`,
  });
  const [after] = await pool.query('SELECT * FROM subscriptions WHERE id = ?', [subscriptionId]);
  return { ...after[0], planChange: preview };
}

// ------------------------------------------------------------------ trials

const MAX_TRIAL_EXTENSIONS = 2;
const MAX_EXTENSION_DAYS = 30;

/** Extend a running trial. Bounded: at most 2 extensions of at most 30 days, always with a reason. */
async function extendTrial({ subscriptionId, days, actor, req, reason }) {
  const why = String(reason || '').trim();
  if (why.length < 5) throw new HttpError(400, 'A reason is required to extend a trial');
  const d = Number(days);
  if (!Number.isInteger(d) || d < 1 || d > MAX_EXTENSION_DAYS) throw new HttpError(400, `days must be between 1 and ${MAX_EXTENSION_DAYS}`);
  const [[sub]] = await pool.query('SELECT * FROM subscriptions WHERE id = ?', [subscriptionId]);
  if (!sub) throw new HttpError(404, 'Subscription not found');
  if (sub.status !== 'trialing') throw new HttpError(409, 'Only a trialing subscription can be extended');
  if (Number(sub.trial_extensions) >= MAX_TRIAL_EXTENSIONS) throw new HttpError(409, `A trial can be extended at most ${MAX_TRIAL_EXTENSIONS} times`);
  // Atomic: the guard is in the WHERE so two concurrent extensions cannot both pass the count check.
  const [r] = await pool.query(
    `UPDATE subscriptions SET trial_ends_at = DATE_ADD(GREATEST(COALESCE(trial_ends_at, NOW()), NOW()), INTERVAL ? DAY),
            trial_extensions = trial_extensions + 1, trial_extended_at = NOW(), trial_extension_reason = ?
      WHERE id = ? AND status = 'trialing' AND trial_extensions < ?`, [d, why, subscriptionId, MAX_TRIAL_EXTENSIONS]);
  if (!r.affectedRows) throw new HttpError(409, 'The trial could not be extended');
  await recordEvent(sub, 'trialing', { actor, reason: why, req, metadata: { extendedByDays: d } });
  await logPlatformAudit({ tenantId: sub.tenant_id, actor, action: 'subscription.trial_extended', category: 'subscription',
    entityType: 'subscription', entityId: subscriptionId, after: { days: d }, reason: why, req });
  entitlements.invalidateTenant(sub.tenant_id);
  const [[after]] = await pool.query('SELECT * FROM subscriptions WHERE id = ?', [subscriptionId]);
  return after;
}

/** Convert a trial to a paid, active subscription (optionally onto another plan). Idempotent. */
async function convertTrial({ subscriptionId, planKey, actor, req, reason }) {
  const [[sub]] = await pool.query('SELECT * FROM subscriptions WHERE id = ?', [subscriptionId]);
  if (!sub) throw new HttpError(404, 'Subscription not found');
  if (sub.status === 'active' && sub.converted_at) return sub;
  if (!['trialing', 'expired'].includes(sub.status)) throw new HttpError(409, 'Only a trial can be converted');
  if (planKey && planKey !== sub.plan_key) await changePlan({ subscriptionId, planKey, actor, req, reason: reason || 'Trial conversion' });
  await transition(subscriptionId, 'active', { actor, req, reason: reason || 'Trial converted to a paid subscription' });
  await pool.query('UPDATE subscriptions SET converted_at = NOW(), trial_ends_at = NULL WHERE id = ?', [subscriptionId]);
  const [[after]] = await pool.query('SELECT * FROM subscriptions WHERE id = ?', [subscriptionId]);
  return after;
}

// ------------------------------------------------------------- cancellation

/**
 * Cancel now, or at the end of the paid period. Never deletes anything: a cancelled company is
 * read-only and enters the normal retention / export / deletion lifecycle.
 */
async function requestCancellation({ subscriptionId, mode = 'period_end', reason, actor, req }) {
  const why = String(reason || '').trim();
  if (why.length < 5) throw new HttpError(400, 'A reason is required');
  if (!['immediate', 'period_end'].includes(mode)) throw new HttpError(400, 'mode must be immediate or period_end');
  const [[sub]] = await pool.query('SELECT * FROM subscriptions WHERE id = ?', [subscriptionId]);
  if (!sub) throw new HttpError(404, 'Subscription not found');
  if (['cancelled', 'expired'].includes(sub.status)) throw new HttpError(409, `The subscription is already ${sub.status}`);

  if (mode === 'immediate') {
    await pool.query('UPDATE subscriptions SET cancel_reason = ?, cancel_requested_by = ?, cancel_requested_at = NOW(), cancel_effective_at = NOW(), cancel_at_period_end = 0 WHERE id = ?',
      [why, actor?.id ?? null, subscriptionId]);
    return transition(subscriptionId, 'cancelled', { actor, req, reason: why });
  }
  await pool.query(
    `UPDATE subscriptions SET cancel_at_period_end = 1, auto_renew = 0, cancel_reason = ?, cancel_requested_by = ?,
            cancel_requested_at = NOW(), cancel_effective_at = COALESCE(current_period_end, NOW()) WHERE id = ?`,
    [why, actor?.id ?? null, subscriptionId]);
  await recordEvent(sub, sub.status, { actor, reason: why, req, metadata: { cancellationScheduled: true } });
  await logPlatformAudit({ tenantId: sub.tenant_id, actor, action: 'subscription.cancellation_requested', category: 'subscription',
    entityType: 'subscription', entityId: subscriptionId, after: { mode }, reason: why, req });
  await require('./platformNotifications').notify({
    event: 'cancellation_requested', severity: 'warning', tenantId: sub.tenant_id,
    title: 'Cancellation requested', body: why, dedupe: `cancel:${subscriptionId}:${sub.current_period_end}`,
  });
  const [[after]] = await pool.query('SELECT * FROM subscriptions WHERE id = ?', [subscriptionId]);
  return after;
}

async function withdrawCancellation({ subscriptionId, actor, req, reason }) {
  const [[sub]] = await pool.query('SELECT * FROM subscriptions WHERE id = ?', [subscriptionId]);
  if (!sub) throw new HttpError(404, 'Subscription not found');
  if (!sub.cancel_at_period_end) throw new HttpError(409, 'No cancellation is scheduled');
  await pool.query(
    `UPDATE subscriptions SET cancel_at_period_end = 0, auto_renew = 1, cancel_effective_at = NULL, cancel_reason = NULL WHERE id = ?`, [subscriptionId]);
  await recordEvent(sub, sub.status, { actor, reason, req, metadata: { cancellationWithdrawn: true } });
  const [[after]] = await pool.query('SELECT * FROM subscriptions WHERE id = ?', [subscriptionId]);
  return after;
}

/** Tenant lifecycle transition (spec §27) with its own history trail. */
async function setTenantStatus(tenantId, toStatus, { actor, reason, req } = {}) {
  const [rows] = await pool.query('SELECT status FROM tenants WHERE id = ?', [tenantId]);
  if (!rows[0]) throw new HttpError(404, 'Tenant not found');
  const from = rows[0].status;
  if (!TENANT_STATUSES.includes(toStatus)) {
    throw new HttpError(400, `Unknown tenant status "${toStatus}"`);
  }
  const stamps = {
    suspended: 'suspended_at = NOW()',
    archived: 'archived_at = NOW()',
    deletion_pending: 'deletion_scheduled_at = NOW()',
  };
  await pool.query(
    `UPDATE tenants SET status = ?${stamps[toStatus] ? `, ${stamps[toStatus]}` : ''} WHERE id = ?`,
    [toStatus, tenantId]
  );
  if (from !== toStatus) {
    await pool.query(
      `INSERT INTO tenant_status_history (tenant_id, from_status, to_status, reason, actor_user_id, actor_name)
       VALUES (?,?,?,?,?,?)`,
      [tenantId, from, toStatus, reason || null, actor?.id ?? null, actor?.name || null]
    );
    await logPlatformAudit({
      tenantId, actor, action: 'tenant.status_change', category: 'tenant',
      entityType: 'tenant', entityId: tenantId,
      before: { status: from }, after: { status: toStatus }, reason, req,
    });
    // The tenant's own cache must not keep serving entitlements computed under the
    // previous lifecycle state.
    entitlements.invalidateTenant(tenantId);
    const { invalidateTenant } = require('../services/rbac');
    invalidateTenant(tenantId);
  }
  return { from, to: toStatus };
}

async function recordEvent(sub, toStatus, { actor, reason, req, metadata } = {}) {
  await pool.query(
    `INSERT INTO subscription_events (subscription_id, tenant_id, event_type, from_status, to_status, reason, actor_user_id, actor_name, metadata, request_id, ip)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [sub.id, sub.tenant_id, eventTypeFor(toStatus), sub.status, toStatus, reason || null,
      actor?.id ?? null, actor?.name || null, metadata ? JSON.stringify(metadata) : null,
      req?.requestId || null, req?.ip || null]
  );
}

const EVENT_NAMES = {
  trialing: 'trial_started', active: 'activated', past_due: 'payment_failed',
  grace_period: 'grace_period_started', suspended: 'suspended', cancelled: 'cancelled', expired: 'expired',
};
const eventTypeFor = (status) => EVENT_NAMES[status] || 'updated';

async function forTenant(tenantId) {
  const [rows] = await pool.query('SELECT * FROM subscriptions WHERE tenant_id = ? ORDER BY id DESC', [tenantId]);
  return rows;
}

async function events(subscriptionId, limit = 50) {
  const [rows] = await pool.query(
    'SELECT * FROM subscription_events WHERE subscription_id = ? ORDER BY created_at DESC, id DESC LIMIT ?',
    [subscriptionId, limit]
  );
  return rows;
}

module.exports = {
  create, transition, changePlan, previewPlanChange, extendTrial, convertTrial, requestCancellation, withdrawCancellation, setTenantStatus, forTenant, events,
  assertTransition, TRANSITIONS, MIRRORED_TENANT_STATE,
};