/**
 * Entitlement resolution (spec §12).
 *
 *     Effective entitlement = platform availability
 *                           + plan entitlement
 *                           + tenant override (highest wins, time-boxed)
 *                           + subscription state
 *                           + module dependency rules
 *
 * This is the *only* place that layering happens. Controllers never compute a
 * limit themselves and never read `tenants.employee_limit`, because the moment
 * two of them do, the answer stops being explainable. Every denial and every
 * "why is this unavailable" screen is produced from `resolveTenant()` so the
 * diagnostic can never disagree with the enforcement.
 *
 * Resolution is cached per tenant for the RBAC TTL and invalidated by the
 * platform API on every plan/override/subscription change.
 */
const { pool } = require('../config/db');
const { HttpError } = require('../utils/helpers');
const {
  MODULE_CATALOG, moduleDependencies, LEGACY_PLAN_ALIASES, TENANT_READ_ONLY_STATUSES, TENANT_BLOCKED_STATUSES,
} = require('../utils/permissions');

const CACHE_TTL_MS = 30_000;
const cache = new Map();   // tenantId -> { at, snapshot }
const fresh = (e) => e && Date.now() - e.at < CACHE_TTL_MS;

function invalidateTenant(tenantId) {
  if (tenantId == null) return;
  cache.delete(String(tenantId));
}
function invalidateAll() { cache.clear(); }

const parse = (v, fallback = null) => {
  if (v === null || v === undefined) return fallback;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return fallback; }
};
const isTruthy = (v) => v === 1 || v === '1' || v === true || v === 'true' || v === 'yes';
const asNumber = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

/** '2026-10' style period key used by metered entitlements. */
function periodKey(period = 'month', at = new Date()) {
  const d = at instanceof Date ? at : new Date(at);
  if (period === 'day') return d.toISOString().slice(0, 10);
  if (period === 'year') return d.toISOString().slice(0, 4);
  if (period === 'none' || !period) return 'lifetime';
  return d.toISOString().slice(0, 7);
}

// ------------------------------------------------------------------ resolution

/**
 * Full entitlement snapshot for one tenant. Everything downstream — the module
 * gate, the limit gate, the "why is this unavailable" panel — reads this.
 */
async function resolveTenant(tenantId, { bypassCache = false } = {}) {
  if (tenantId == null) throw new HttpError(400, 'A tenant is required to resolve entitlements');
  const key = String(tenantId);
  if (!bypassCache && fresh(cache.get(key))) return cache.get(key).snapshot;

  const [tenantRows] = await pool.query(
    `SELECT id, name, slug, plan, status, display_name, employee_limit, limits FROM tenants WHERE id = ?`, [tenantId]
  );
  const tenant = tenantRows[0];
  if (!tenant) throw new HttpError(404, 'Tenant not found');

  const planKey = LEGACY_PLAN_ALIASES[tenant.plan] || tenant.plan;
  const [planRows] = await pool.query(
    'SELECT * FROM platform_plans WHERE plan_key = ? LIMIT 1', [planKey]
  );
  const plan = planRows[0] || null;

  const subscription = await currentSubscription(tenantId);
  const [entitlementRows] = await pool.query(
    `SELECT id, entitlement_key, name, description, kind, module_key, scope, period,
            default_value, unit, unit_label, warning_pct, critical_pct, is_platform_available
     FROM entitlements ORDER BY sort_order, entitlement_key`
  );
  const [overrideRows] = await pool.query(
    `SELECT o.id, o.entitlement_id, o.value, o.reason, o.status, o.effective_from, o.effective_until,
            o.approved_by, o.created_by, o.created_at, o.revoked_at
     FROM tenant_entitlement_overrides o
     WHERE o.tenant_id = ? AND o.status = 'active'
       AND (o.effective_from IS NULL OR o.effective_from <= NOW())
       AND (o.effective_until IS NULL OR o.effective_until > NOW())`,
    [tenantId]
  );
  const overrideByEntitlement = new Map(overrideRows.map((o) => [o.entitlement_id, o]));

  // Add-ons: purchasable extras layered on the plan. Booleans OR together; numeric caps add up
  // (increment × quantity). An add-on never lifts an override — the override is the last word.
  const [addonRows] = await pool.query(
    `SELECT a.addon_key, a.name, a.grants, ta.quantity
       FROM tenant_addons ta JOIN addons a ON a.id = ta.addon_id
      WHERE ta.tenant_id = ? AND ta.status = 'active' AND a.active = 1
        AND (ta.starts_at IS NULL OR ta.starts_at <= NOW()) AND (ta.ends_at IS NULL OR ta.ends_at > NOW())`, [tenantId]);
  const addonByKey = new Map();
  for (const a of addonRows) {
    for (const g of parse(a.grants, []) || []) {
      const cur = addonByKey.get(g.key) || { enable: false, increment: 0, from: [] };
      if (g.value !== undefined && isTruthy(g.value)) cur.enable = true;
      if (g.increment !== undefined) cur.increment += Number(g.increment) * Number(a.quantity || 1);
      cur.from.push(a.addon_key);
      addonByKey.set(g.key, cur);
    }
  }

  const [planEntitlementRows] = plan
    ? await pool.query(
      `SELECT pe.entitlement_id, pe.value FROM plan_entitlements pe
       JOIN entitlements e ON e.id = pe.entitlement_id
       WHERE pe.plan_id = ?
         AND (pe.effective_from IS NULL OR pe.effective_from <= NOW())
         AND (pe.effective_until IS NULL OR pe.effective_until > NOW())`,
      [plan.id]
    )
    : [[]];
  const planValueByEntitlement = new Map(planEntitlementRows.map((r) => [r.entitlement_id, r.value]));

  const subscriptionState = subscription?.status || 'active';
  // A cancelled or expired subscription keeps the tenant's data readable but takes
  // away the ability to *create* anything. Suspension for non-payment behaves the
  // same way — never a hard lock on a company's own payroll history (spec §15).
  const readOnly = TENANT_READ_ONLY_STATUSES.has(tenant.status) || ['suspended', 'cancelled', 'expired'].includes(subscriptionState);
  const blocked = TENANT_BLOCKED_STATUSES.has(tenant.status);

  const entitlements = {};
  for (const e of entitlementRows) {
    // Both maps are keyed by the entitlement row id (plan_entitlements.entitlement_id
    // and tenant_entitlement_overrides.entitlement_id both reference entitlements.id).
    const hasPlanValue = planValueByEntitlement.has(e.id);
    const planValue = hasPlanValue ? planValueByEntitlement.get(e.id) : e.default_value;
    const override = overrideByEntitlement.get(e.id);
    const overrideValue = override ? override.value : null;

    let source = override ? 'override' : (hasPlanValue ? 'plan' : 'default');
    // Override wins, then plan + add-ons, then the platform default. Order matters and is
    // the whole of the "plan → override" rule from spec §12.
    let raw = overrideValue ?? planValue ?? null;
    const addon = addonByKey.get(e.entitlement_key);
    if (!override && addon) {
      if (e.kind === 'boolean' && addon.enable) { raw = '1'; source = 'addon'; }
      else if (e.kind !== 'boolean' && addon.increment && asNumber(raw) !== null) { raw = asNumber(raw) + addon.increment; source = 'addon'; }
    }

    const entry = {
      id: e.id,
      key: e.entitlement_key,
      name: e.name,
      kind: e.kind,
      moduleKey: e.module_key,
      unit: e.unit,
      unitLabel: e.unit_label,
      period: e.period,
      warningPct: Number(e.warning_pct ?? 80),
      criticalPct: Number(e.critical_pct ?? 90),
      source,
      addons: addon ? addon.from : [],
      planValue: hasPlanValue ? planValue : null,
      overrideValue,
      overrideId: override ? override.id : null,
      platformAvailable: e.is_platform_available !== 0 && e.is_platform_available !== false,
      periodKey: periodKey(e.period),
    };

    if (e.kind === 'boolean') {
      entry.value = isTruthy(raw);
      // Billing state deliberately does NOT switch a module off. A company that is
      // suspended for non-payment must still reach its own payroll, payslips and
      // history (spec §15) — only *writes* are held back, by `requireTenantWritable`.
      entry.enabled = entry.value && entry.platformAvailable && !blocked;
    } else {
      const n = asNumber(raw);
      // A cap that is genuinely absent (no plan value, no default) is *unlimited*.
      // A cap of 0 is a real commercial answer — "this plan includes none of these"
      // — so the two must never collapse into the same value.
      entry.unlimited = n === null;
      entry.value = n === null ? null : n;
    }
    entitlements[e.entitlement_key] = entry;
  }

  // Backwards compatibility: the legacy tenants.employee_limit column is mirrored
  // into employees.max when the tenant has no plan value for it, so an existing
  // installation keeps the limit it always had rather than becoming unlimited.
  const employees = entitlements['employees.max'];
  if (employees && employees.unlimited && tenant.employee_limit) {
    employees.value = Number(tenant.employee_limit);
    employees.unlimited = false;
    employees.source = 'legacy_tenant_limit';
  }
  const legacyLimits = parse(tenant.limits, {}) || {};
  for (const [k, v] of Object.entries(legacyLimits)) {
    if (entitlements[k] && entitlements[k].unlimited && v !== null && v !== undefined) {
      entitlements[k].value = Number(v);
      entitlements[k].unlimited = false;
      entitlements[k].source = 'legacy_tenant_limit';
    }
  }

  const snapshot = {
    tenant: {
      id: tenant.id, name: tenant.name, slug: tenant.slug,
      plan: tenant.plan, effectivePlanKey: planKey, status: tenant.status,
      displayName: tenant.display_name,
    },
    plan: plan ? { id: plan.id, key: plan.plan_key, name: plan.name, priceMonthly: Number(plan.price_monthly || 0) } : null,
    subscription: subscription
      ? {
        id: subscription.id, status: subscription.status, billingCycle: subscription.billing_cycle,
        trialEndsAt: subscription.trial_ends_at, currentPeriodEnd: subscription.current_period_end,
        graceEndsAt: subscription.grace_ends_at, quantity: subscription.quantity,
      }
      : null,
    readOnly,
    blocked,
    entitlements,
    overrides: overrideRows,
    resolvedAt: new Date().toISOString(),
  };
  cache.set(key, { at: Date.now(), snapshot });
  return snapshot;
}

async function currentSubscription(tenantId) {
  const [rows] = await pool.query(
    `SELECT * FROM subscriptions WHERE tenant_id = ?
     ORDER BY FIELD(status,'active','trialing','grace_period','past_due','suspended','cancelled','expired'), id DESC
     LIMIT 1`,
    [tenantId]
  );
  return rows[0] || null;
}

// ------------------------------------------------------------------ queries

/** True when the entitlement is granted. */
async function isEnabled(tenantId, entitlementKey) {
  const snap = await resolveTenant(tenantId);
  const e = snap.entitlements[entitlementKey];
  return !!(e && e.enabled);
}

/** Numeric cap, or null when the entitlement is unlimited/absent. */
async function limitFor(tenantId, entitlementKey) {
  const snap = await resolveTenant(tenantId);
  const e = snap.entitlements[entitlementKey];
  if (!e || e.kind === 'boolean') return null;
  return e.unlimited ? null : e.value;
}

/**
 * Is this module available to the tenant, and if not, why?
 * `dependencies` reports anything the module needs that is not itself available,
 * which is what the Super Admin UI shows when a switch refuses to flip.
 */
async function moduleAvailability(tenantId, moduleKey) {
  const snap = await resolveTenant(tenantId);
  const entitlementKey = `${moduleKey}.enabled`;
  const entry = snap.entitlements[entitlementKey];
  const [moduleRows] = await pool.query(
    'SELECT enabled FROM module_configurations WHERE tenant_id = ? AND module_key = ?', [tenantId, moduleKey]
  );
  const configured = moduleRows[0] ? !!moduleRows[0].enabled : null;

  const reasons = [];
  let entitled = !!entry?.enabled;
  if (!entry) reasons.push(`No entitlement named "${entitlementKey}" exists`);
  else if (!entry.platformAvailable) reasons.push('ARTHVEX has withdrawn this capability platform-wide');
  else if (!entry.value) reasons.push(`The ${snap.plan ? snap.plan.name : 'current'} plan does not include ${entry.name}`);
  if (snap.blocked) reasons.push(`The company is ${snap.tenant.status.replace(/_/g, ' ')}`);

  // Dependencies are resolved recursively so a missing ancestor is reported with
  // the chain that led to it, not just the direct parent.
  const missing = [];
  for (const dep of moduleDependencies(moduleKey)) {
    const depResult = await moduleAvailability(tenantId, dep);
    if (!depResult.available) {
      missing.push({
        module: dep, name: depAvName(dep),
        reason: depResult.reason || `${moduleName(dep)} is not available`,
        chain: depResult.missingDependencies,
      });
    }
  }

  const enabled = entitled && configured !== false && missing.length === 0;
  return {
    module: moduleKey,
    name: moduleName(moduleKey),
    entitlement: entitlementKey,
    entitled,
    configured,
    enabled,
    // `available` is the shape callers gate on (the module middleware, the plan
    // editor, the Super Admin screen). `enabled` is the same answer kept for the
    // usage dashboard's wording.
    available: enabled,
    readOnly: snap.readOnly,
    missingDependencies: missing,
    reason: entitled
      ? (missing.length ? `Requires ${missing.map((m) => m.name).join(', ')}` : (configured === false ? 'Switched off for this company' : null))
      : reasons[0],
  };
}

const depAvName = (key) => (MODULE_CATALOG.find((m) => m.key === key) || { name: key }).name;

const entryKeyLabel = (key) => key.replace('.enabled', '').replace(/_/g, ' ');
const moduleName = (key) => (MODULE_CATALOG.find((m) => m.key === key) || { name: key }).name;

/**
 * "Why can't I do this?" (spec §35).
 *
 * Returns the full chain — plan value, override, subscription state, usage —
 * so the UI can show the reason rather than a bare 403.
 */
async function explain(tenantId, subject) {
  const snap = await resolveTenant(tenantId, { bypassCache: true });

  if (typeof subject === 'string' && subject.endsWith('.enabled')) {
    const mod = await moduleAvailability(tenantId, subject.replace('.enabled', ''));
    return {
      tenant: snap.tenant,
      plan: snap.plan,
      subscription: snap.subscription,
      available: mod.enabled,
      entitlementKey: subject,
      entitlementValue: snap.entitlements[subject]?.value ?? null,
      planAllows: snap.entitlements[subject]?.planValue ?? null,
      override: snap.entitlements[subject]?.overrideValue ?? null,
      missingDependencies: mod.missingDependencies,
      reason: mod.reason || (mod.enabled ? null : 'Not available'),
      resolution: mod.enabled ? null : resolutionFor(mod, snap),
    };
  }

  const entry = snap.entitlements[subject];
  if (!entry) {
    return {
      tenant: snap.tenant, plan: snap.plan, subscription: snap.subscription,
      available: false, entitlementKey: subject,
      reason: `No entitlement named "${subject}" is defined on this platform`,
      resolution: 'Define the entitlement on a plan or as a tenant override',
    };
  }
  const current = (await require('./usage').currentUsage(tenantId, subject)) || 0;
  const limit = entry.unlimited ? null : entry.value;
  const pct = limit > 0 ? Math.round((current / limit) * 1000) / 10 : 0;
  const atHard = limit !== null && current >= limit;
  const excluded = limit === 0;
  return {
    tenant: snap.tenant,
    plan: snap.plan,
    subscription: snap.subscription,
    available: !atHard && !snap.readOnly,
    entitlementKey: subject,
    entitlementValue: limit,
    planValue: entry.planValue,
    override: entry.overrideValue,
    overrideId: entry.overrideId,
    limitSource: entry.source,
    current,
    limit,
    unlimited: entry.unlimited,
    percentUsed: pct,
    status: excluded ? 'excluded' : usageStatus(entry, current, limit),
    readOnly: snap.readOnly,
    reason: excluded
      ? `${entry.name} is not included in this plan`
      : atHard
        ? `Limit reached (${current} / ${limit} ${entry.unit || ''})`
        : (snap.readOnly ? `The company is ${snap.tenant.status.replace(/_/g, ' ')}` : null),
    resolution: excluded
      ? 'Upgrade the plan or ask ARTHVEX to enable this capability'
      : atHard
        ? `Raise the limit via a plan change or a tenant override`
        : (snap.readOnly ? 'Reactivate the company or subscription' : null),
  };
}

function resolutionFor(mod, snap) {
  if (mod.missingDependencies?.length) return `Enable ${mod.missingDependencies.map((m) => m.name).join(', ')} first`;
  if (snap.blocked) return 'Reactivate the company';
  return 'Upgrade the plan or enable an appropriate add-on';
}

/** warning (80%) / critical (90%) / hard (100%) thresholds (spec §15). */
function usageStatus(entry, current, limit) {
  if (!limit || limit <= 0) return 'ok';
  const pct = (current / limit) * 100;
  if (current >= limit) return 'hard_limit';
  if (pct >= entry.criticalPct) return 'critical';
  if (pct >= entry.warningPct) return 'warning';
  return 'ok';
}

/** Every numeric entitlement with its current usage — the tenant usage dashboard. */
async function usageDashboard(tenantId) {
  const snap = await resolveTenant(tenantId);
  const usage = require('./usage');
  const out = [];
  for (const entry of Object.values(snap.entitlements)) {
    if (entry.kind === 'boolean' || entry.unlimited) continue;
    const current = (await usage.currentUsage(tenantId, entry.key)) || 0;
    out.push({
      key: entry.key,
      name: entry.name,
      unit: entry.unit,
      limit: entry.value,
      current,
      percentUsed: entry.value > 0 ? Math.round((current / entry.value) * 1000) / 10 : 0,
      status: entry.value === 0 ? 'excluded' : usageStatus(entry, current, entry.value),
      source: entry.source,
      period: entry.period,
      periodKey: entry.periodKey,
    });
  }
  const modules = [];
  for (const m of MODULE_CATALOG) {
    const av = await moduleAvailability(tenantId, m.key);
    modules.push({
      key: m.key, name: m.name, enabled: av.enabled, entitled: av.entitled,
      configured: av.configured, reason: av.reason, missingDependencies: av.missingDependencies,
    });
  }
  return { ...snap, usage: out.sort((a, b) => b.percentUsed - a.percentUsed), modules };
}

module.exports = {
  resolveTenant, invalidateTenant, invalidateAll, isEnabled, limitFor,
  moduleAvailability, explain, usageDashboard, usageStatus, periodKey, currentSubscription,
};