/**
 * ARTHVEX Platform Control Plane.
 *
 * Mounted at `/api/platform`. Every route below is *cross-tenant by nature*, so
 * the router is gated on the platform layer itself (`requirePlatformRole`) and
 * then on a specific control-plane capability. A company administrator cannot
 * reach any of it, whatever they put in `tenant_id`.
 *
 * The rules the whole surface obeys:
 *   • Naming a company is not access. Reading or changing a company's
 *     configuration requires a live support-access session, granted with a
 *     reason and a duration, expiring on its own (spec §21).
 *   • Every state change is written to `platform_audit_logs` with a reason
 *     (spec §30). Reads of customer data are not logged as state changes but are
 *     recorded in `support_access_logs` under the active session.
 *   • Nothing here hard-codes a plan name, a limit or a module list. Plans and
 *     entitlements are read from the catalogue (spec §34, §43).
 */
const express = require('express');
const { pool } = require('../../config/db');
const { asyncH, HttpError } = require('../../utils/helpers');
const { authenticate, requirePermission, requirePlatformRole } = require('../../middleware/auth');
const entitlements = require('../../services/entitlements');
const usage = require('../../services/usage');
const limits = require('../../services/limits');
const subscriptions = require('../../services/subscriptions');
const supportAccess = require('../../services/supportAccess');
const tenantService = require('../../services/tenant');
const platformAudit = require('../../services/platformAudit');
const exportService = require('../../services/exports');
const billing = require('../../services/billing');
const rbac = require('../../services/rbac');
const {
  MODULE_CATALOG, ENTITLEMENT_CATALOG, PLATFORM_PLANS, SUBSCRIPTION_STATUSES, TENANT_STATUSES, moduleDependencies,
} = require('../../utils/permissions');

const r = express.Router();
r.use(authenticate);
r.use(requirePlatformRole());

const int = (v, d = null) => (v === undefined || v === null || v === '' || Number.isNaN(Number(v)) ? d : parseInt(v, 10));
const paging = (q, def = 25) => {
  const limit = Math.min(200, Math.max(1, int(q.limit, def)));
  const page = Math.max(1, int(q.page, 1));
  return { limit, offset: (page - 1) * limit, page };
};
const unj = (v, d) => {
  if (v === null || v === undefined) return d;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return d; }
};

/** Only the Platform Super Admin may provision or destroy a tenant. */
const SUPER = requirePermission('platform.tenants.manage');

/**
 * Support Access gate for tenant-scoped *reads* (spec §21).
 *
 * Naming a company is not access. The roster — names, plans, lifecycle states,
 * headcounts — is metadata the control plane needs in order to do its job and is
 * readable with `platform.tenants.view`. Anything that reaches into a customer's
 * configuration or usage requires a live, reasoned, expiring session.
 *
 * Deliberately NOT applied to the control-plane *actions* below (status changes,
 * overrides, plan changes, exports, deletion requests): those are ARTHVEX acting
 * *on* the customer, are permission-gated and fully audited, and demanding a
 * support session for them would mean an operator cannot suspend a company that is
 * refusing to pay.
 */
const tenantReach = asyncH(async (req, res, next) => {
  const id = req.params.id ?? req.params.tenantId ?? req.query.tenantId;
  if (id === undefined || id === null || id === '') return next();
  const reach = await supportAccess.assertTenantReach(req.user, Number(id));
  req.supportSession = reach.session || null;
  // Reads count. An operator browsing a customer's configuration is exactly what a
  // later audit has to be able to reconstruct, so it is written under the session
  // that authorised it rather than being assumed from the fact that they could.
  supportAccess.logAction(reach.session, {
    userId: req.user.id,
    action: `${req.method} ${req.baseUrl}${req.route ? req.route.path : req.path}`,
    method: req.method,
    path: req.originalUrl,
    req,
  });
  next();
});

// Operators, platform security, audit export and the per-company tabs.
r.use(require('./operations')({ tenantReach }));
r.use(require('./commercial')());

// ============================================================ dashboard (spec §32)
r.get('/dashboard', requirePermission('platform.dashboard.view'), asyncH(async (req, res) => {
  const one = async (sql, params = []) => Number((await pool.query(sql, params))[0][0].c);

  const [tenants] = await pool.query(
    `SELECT status, COUNT(*) AS n FROM tenants GROUP BY status`
  );
  const byStatus = Object.fromEntries(tenants.map((t) => [t.status, Number(t.n)]));

  const [[headcount]] = await pool.query(
    'SELECT COUNT(*) AS employees FROM employees WHERE deleted_at IS NULL'
  );
  const [[subs]] = await pool.query(
    `SELECT COUNT(*) AS n, COALESCE(SUM(price_per_period * (1 - discount_pct / 100)), 0) AS mrr
     FROM subscriptions WHERE status IN ('trialing','active','past_due','grace_period')`
  );
  const [recentTenants] = await pool.query(
    `SELECT id, name, slug, plan, status, created_at FROM tenants ORDER BY id DESC LIMIT 8`
  );
  const [recentEvents] = await pool.query(
    `SELECT id, tenant_id, event_type, from_status, to_status, reason, created_at
     FROM subscription_events ORDER BY id DESC LIMIT 8`
  );
  const [securityAlerts] = await pool.query(
    `SELECT le.email, COUNT(*) AS failures, MAX(le.created_at) AS last_seen
     FROM login_events le WHERE le.event IN ('login_failed','mfa_failed')
       AND le.created_at > DATE_SUB(NOW(), INTERVAL 24 HOUR)
     GROUP BY le.email HAVING failures >= 5 ORDER BY failures DESC LIMIT 8`
  );
  const [integrationFailures] = await pool.query(
    `SELECT ic.tenant_id, ic.name, ic.itype, ic.last_error, ic.last_sync_at
     FROM integration_connections ic WHERE ic.status = 'error' ORDER BY ic.id DESC LIMIT 8`
  ).catch(() => [[]]);

  await supportAccess.sweepExpired();

  res.json({
    data: {
      tenants: {
        total: Object.values(byStatus).reduce((a, b) => a + b, 0),
        active: byStatus.active || 0,
        trial: (byStatus.trial || 0) + (byStatus.trialing || 0) + (byStatus.provisioning || 0),
        pastDue: (byStatus.past_due || 0) + (byStatus.grace_period || 0),
        suspended: byStatus.suspended || 0,
        cancelled: (byStatus.cancelled || 0) + (byStatus.archived || 0),
        deleted: byStatus.deleted || 0,
        byStatus,
      },
      employees: { total: Number(headcount.employees || 0) },
      subscriptions: { active: Number(subs.n || 0), mrr: Number(subs.mrr || 0) },
      usage: await usage.platformTotals(),
      recentTenants,
      recentSubscriptionEvents: recentEvents,
      securityAlerts,
      integrationFailures,
      limitBreaches: (await limits.breaches()).slice(0, 12),
      activeSupportSessions: (await supportAccess.list({ status: 'active', limit: 10 })).total,
    },
  });
}));

// ============================================================ tenants (spec §19)
r.get('/tenants', requirePermission('platform.tenants.view'), asyncH(async (req, res) => {
  const { limit, offset, page } = paging(req.query);
  const where = [];
  const params = [];
  if (req.query.q) {
    // Company-level identifiers only: name, slug, id, owner login email, custom domain. Never HR data.
    const like = `%${req.query.q}%`;
    where.push(`(t.name LIKE ? OR t.slug LIKE ? OR t.id = ? OR EXISTS (SELECT 1 FROM users u WHERE u.tenant_id = t.id AND u.role = 'company_owner' AND u.email LIKE ?)
                 OR EXISTS (SELECT 1 FROM tenant_domains d WHERE d.tenant_id = t.id AND d.hostname LIKE ?))`);
    params.push(like, like, Number(req.query.q) || 0, like, like);
  }
  if (req.query.industry) { where.push('t.industry = ?'); params.push(req.query.industry); }
  if (req.query.subscriptionStatus) {
    where.push('(SELECT s.status FROM subscriptions s WHERE s.tenant_id = t.id ORDER BY s.id DESC LIMIT 1) = ?'); params.push(req.query.subscriptionStatus);
  }
  if (req.query.createdFrom) { where.push('t.created_at >= ?'); params.push(req.query.createdFrom); }
  if (req.query.createdTo) { where.push('t.created_at < DATE_ADD(?, INTERVAL 1 DAY)'); params.push(req.query.createdTo); }
  if (req.query.activeSince) { where.push('t.last_activity_at >= ?'); params.push(req.query.activeSince); }
  if (req.query.inactiveDays) { where.push('(t.last_activity_at IS NULL OR t.last_activity_at < DATE_SUB(NOW(), INTERVAL ? DAY))'); params.push(Number(req.query.inactiveDays) || 30); }
  if (req.query.minEmployees) { where.push('(SELECT COUNT(*) FROM employees e WHERE e.tenant_id = t.id AND e.deleted_at IS NULL) >= ?'); params.push(Number(req.query.minEmployees)); }
  if (req.query.maxEmployees) { where.push('(SELECT COUNT(*) FROM employees e WHERE e.tenant_id = t.id AND e.deleted_at IS NULL) <= ?'); params.push(Number(req.query.maxEmployees)); }
  if (req.query.status) {
    const wanted = String(req.query.status).split(',').filter(Boolean);
    where.push(`t.status IN (${wanted.map(() => '?').join(',')})`);
    params.push(...wanted);
  }
  if (req.query.plan) { where.push('t.plan = ?'); params.push(req.query.plan); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM tenants t ${clause}`, params);
  const [rows] = await pool.query(
    `SELECT t.id, t.name, t.slug, t.plan, t.status, t.created_at, t.onboarded_at, t.last_activity_at,
            (SELECT COUNT(*) FROM employees e WHERE e.tenant_id = t.id AND e.deleted_at IS NULL) AS employees,
            (SELECT COUNT(*) FROM users u WHERE u.tenant_id = t.id AND u.status = 'active') AS active_users,
            (SELECT COUNT(*) FROM legal_entities le WHERE le.tenant_id = t.id) AS legal_entities,
            (SELECT s.status FROM subscriptions s WHERE s.tenant_id = t.id ORDER BY s.id DESC LIMIT 1) AS subscription_status,
            (SELECT s.current_period_end FROM subscriptions s WHERE s.tenant_id = t.id ORDER BY s.id DESC LIMIT 1) AS period_end
     FROM tenants t ${clause} ORDER BY t.id LIMIT ${limit} OFFSET ${offset}`,
    params
  );
  res.json({ data: rows, meta: { total: Number(total), page, pages: Math.ceil(Number(total) / limit), limit } });
}));

/** GET /tenants/:id — one company with plan, subscription, modules and usage. */
r.get('/tenants/:id', requirePermission('platform.tenants.view'), tenantReach, asyncH(async (req, res) => {
  const id = int(req.params.id);
  const tenant = await tenantService.get(id);
  if (!tenant) throw new HttpError(404, 'Tenant not found');
  const [modules] = await pool.query(
    'SELECT module_key, name, category, enabled, updated_at FROM module_configurations WHERE tenant_id = ? ORDER BY module_key', [id]
  );
  const [overrides] = await pool.query(
    `SELECT o.id, o.value, o.reason, o.status, o.effective_from, o.effective_until, o.created_at, e.entitlement_key, e.name
     FROM tenant_entitlement_overrides o JOIN entitlements e ON e.id = o.entitlement_id
     WHERE o.tenant_id = ? ORDER BY o.created_at DESC`, [id]
  );
  const [statusHistory] = await pool.query(
    'SELECT from_status, to_status, reason, actor_name, created_at FROM tenant_status_history WHERE tenant_id = ? ORDER BY id DESC LIMIT 25', [id]
  );
  const [domains] = await pool.query('SELECT * FROM tenant_domains WHERE tenant_id = ? ORDER BY is_primary DESC', [id]);
  const snapshot = await entitlements.resolveTenant(id, { bypassCache: true });
  res.json({
    data: {
      ...tenant,
      modules,
      overrides,
      statusHistory,
      domains,
      subscriptionEvents: tenant.subscription ? await subscriptions.events(tenant.subscription.id, 25) : [],
      entitlementSnapshot: snapshot,
    },
  });
}));

/**
 * PATCH /tenants/:id — edit a company's profile. Plan, modules, status and limits
 * have their own audited endpoints; this only touches descriptive fields.
 */
r.patch('/tenants/:id', SUPER, asyncH(async (req, res) => {
  const id = int(req.params.id);
  const reason = String(req.body?.reason || '').trim();
  if (reason.length < 5) throw new HttpError(400, 'A reason is required — every change is recorded against it');
  const FIELDS = {
    legalName: 'name', displayName: 'display_name', industry: 'industry', country: 'country',
    timezone: 'timezone', currency: 'currency', contactEmail: 'contact_email', contactPhone: 'contact_phone',
  };
  const [[before]] = await pool.query('SELECT * FROM tenants WHERE id = ?', [id]);
  if (!before) throw new HttpError(404, 'Tenant not found');
  const sets = []; const vals = []; const after = {}; const prev = {};
  for (const [k, col] of Object.entries(FIELDS)) {
    if (req.body[k] === undefined) continue;
    const v = req.body[k] === null ? null : String(req.body[k]).trim();
    if (col === 'name' && !v) throw new HttpError(400, 'Legal name cannot be empty');
    if (col === 'contact_email' && v && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) throw new HttpError(400, 'Contact email is not valid');
    sets.push(`${col} = ?`); vals.push(v || null); prev[k] = before[col]; after[k] = v || null;
  }
  if (!sets.length) throw new HttpError(400, 'Nothing to change');
  await pool.query(`UPDATE tenants SET ${sets.join(', ')} WHERE id = ?`, [...vals, id]);
  await platformAudit.logPlatformAudit({
    tenantId: id, actor: req.user, action: 'tenant.updated', category: 'tenant',
    entityType: 'tenant', entityId: id, before: prev, after, reason, req,
  });
  res.json({ data: await tenantService.get(id) });
}));

/**
 * The full tenant lifecycle as distinct, explicit actions (spec §27).
 * Archiving is not deletion and neither is suspension; each says what it does to
 * access so an operator cannot confuse them.
 */
r.post('/tenants/:id/status', SUPER, asyncH(async (req, res) => {
  const id = int(req.params.id);
  const { status, reason } = req.body || {};
  if (!reason || String(reason).trim().length < 5) {
    throw new HttpError(400, 'A reason is required — every lifecycle change is recorded against it');
  }
  if (!TENANT_STATUSES.includes(status)) {
    throw new HttpError(400, `Unknown status "${status}". Expected one of: ${TENANT_STATUSES.join(', ')}`);
  }
  const before = await pool.query('SELECT status FROM tenants WHERE id = ?', [id]);
  if (!before[0]) throw new HttpError(404, 'Tenant not found');
  const result = await subscriptions.setTenantStatus(id, status, { actor: req.user, reason, req });
  await entitlements.invalidateTenant(id);
  res.json({ data: result });
}));

/** POST /tenants — the provisioning wizard's single submit (spec §18). */
r.post('/tenants', SUPER, asyncH(async (req, res) => {
  const result = await tenantService.provision(req.body || {}, { actor: req.user, req });
  res.status(201).json({ data: result, adminEmail: result.ownerEmail, tempPassword: result.tempPassword });
}));

// ============================================================ plans (spec §34)
r.get('/plans', requirePermission('platform.plans.view'), asyncH(async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM platform_plans ORDER BY sort_order, plan_key');
  const [grants] = await pool.query(
    `SELECT pe.plan_id, e.entitlement_key, e.kind, e.name, e.unit, pe.value
     FROM plan_entitlements pe JOIN entitlements e ON e.id = pe.entitlement_id
     ORDER BY e.sort_order`
  );
  const byPlan = new Map(rows.map((p) => [p.id, []]));
  for (const g of grants) {
    if (byPlan.has(g.plan_id)) byPlan.get(g.plan_id).push(g);
  }
  res.json({
    data: rows.map((p) => ({
      ...p,
      module_keys: unj(p.module_keys, null),
      entitlements: byPlan.get(p.id) || [],
    })),
  });
}));

/** PUT /plans/:id/entitlements — the plan editor's write path (spec §34). */
r.put('/plans/:id/entitlements', requirePermission('platform.plans.manage'), asyncH(async (req, res) => {
  const planId = int(req.params.id);
  const { entitlements: updates, reason } = req.body || {};
  if (!Array.isArray(updates)) throw new HttpError(400, 'entitlements must be an array of { entitlementKey, value }');
  if (!reason) throw new HttpError(400, 'A reason is required when changing what a plan includes');

  const [[plan]] = await pool.query('SELECT * FROM platform_plans WHERE id = ?', [planId]);
  if (!plan) throw new HttpError(404, 'Plan not found');
  const [known] = await pool.query('SELECT id, entitlement_key, kind FROM entitlements WHERE entitlement_key IN (?)', [updates.map((u) => u.entitlementKey)]);
  const byKey = new Map(known.map((k) => [k.entitlement_key, k]));

  const before = new Map();
  const [current] = await pool.query(
    'SELECT pe.entitlement_id, pe.value FROM plan_entitlements pe WHERE pe.plan_id = ?', [planId]
  );
  for (const c of current) before.set(c.entitlement_id, c.value);

  const changed = [];
  for (const u of updates) {
    const ent = byKey.get(u.entitlementKey);
    if (!ent) continue;
    const value = ent.kind === 'boolean' ? (u.value ? '1' : '0') : String(u.value);
    await pool.query(
      `INSERT INTO plan_entitlements (plan_id, entitlement_id, value, created_by) VALUES (?,?,?,?)
       ON DUPLICATE KEY UPDATE value = VALUES(value)`,
      [planId, ent.id, value, req.user.id]
    );
    if (before.get(ent.id) !== value) {
      changed.push({ entitlementKey: u.entitlementKey, from: before.get(ent.id) ?? null, to: value });
    }
  }
  if (!changed.length) return res.json({ ok: true, changed: [] });

  // Every tenant on this plan must see the new values immediately.
  const [affected] = await pool.query('SELECT id FROM tenants WHERE plan = ?', [plan.plan_key]);
  for (const t of affected) entitlements.invalidateTenant(t.id);

  await platformAudit.logPlatformAudit({
    tenantId: null, actor: req.user, action: 'plan.entitlements_change', category: 'plan',
    entityType: 'plan', entityId: planId,
    before: Object.fromEntries(changed.map((c) => [c.entitlementKey, c.from])),
    after: Object.fromEntries(changed.map((c) => [c.entitlementKey, c.to])),
    reason, req,
  });
  res.json({ ok: true, changed, affectedTenants: affected.length });
}));

// ============================================================ entitlements
r.get('/entitlements', requirePermission('platform.entitlements.view'), asyncH(async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM entitlements ORDER BY sort_order, entitlement_key');
  const [overrideCounts] = await pool.query(
    "SELECT entitlement_id, COUNT(*) AS c FROM tenant_entitlement_overrides WHERE status = 'active' GROUP BY entitlement_id"
  );
  const countBy = new Map(overrideCounts.map((o) => [o.entitlement_id, Number(o.c)]));
  const data = [];
  for (const e of rows) {
    data.push({ ...e, allowedValues: await planValuesFor(e.id), overrides: countBy.get(e.id) || 0 });
  }
  res.json({
    data,
    meta: { catalog: ENTITLEMENT_CATALOG.length, plans: PLATFORM_PLANS.map((p) => p.key) },
  });
}));

async function planValuesFor(entitlementId) {
  const [rows] = await pool.query(
    `SELECT p.plan_key, pe.value FROM plan_entitlements pe JOIN platform_plans p ON p.id = pe.plan_id
     WHERE pe.entitlement_id = ? ORDER BY p.sort_order`, [entitlementId]
  );
  return Object.fromEntries(rows.map((r) => [r.plan_key, r.value]));
}

/** GET /tenants/:id/entitlements — the tenant's effective grants with their provenance. */
r.get('/tenants/:id/entitlements', requirePermission('platform.entitlements.view'), tenantReach, asyncH(async (req, res) => {
  const id = int(req.params.id);
  const snapshot = await entitlements.resolveTenant(id, { bypassCache: true });
  res.json({
    data: {
      tenant: snapshot.tenant,
      plan: snapshot.plan,
      subscription: snapshot.subscription,
      readOnly: snapshot.readOnly,
      entitlements: Object.values(snapshot.entitlements),
      overrides: snapshot.overrides,
    },
  });
}));

/** GET /tenants/:id/entitlements/:key/explain — "why is this unavailable?" (spec §35). */
r.get('/tenants/:id/entitlements/:key/explain', requirePermission('platform.entitlements.view'), tenantReach, asyncH(async (req, res) => {
  const id = int(req.params.id);
  const key = String(req.params.key);
  const [exists] = await pool.query('SELECT id FROM tenants WHERE id = ?', [id]);
  if (!exists[0]) throw new HttpError(404, 'Tenant not found');
  res.json({ data: await entitlements.explain(id, key) });
}));

/** POST /tenants/:id/overrides — a bespoke, auditable, time-boxed grant (spec §11). */
r.post('/tenants/:id/overrides', requirePermission('platform.entitlements.manage'), asyncH(async (req, res) => {
  const id = int(req.params.id);
  const { entitlementKey, value, reason, effectiveFrom, effectiveUntil } = req.body || {};
  if (!entitlementKey) throw new HttpError(400, 'entitlementKey is required');
  if (!reason || String(reason).trim().length < 5) throw new HttpError(400, 'A reason is required — overrides are auditable');
  const [[ent]] = await pool.query('SELECT * FROM entitlements WHERE entitlement_key = ?', [entitlementKey]);
  if (!ent) throw new HttpError(404, `Unknown entitlement "${entitlementKey}"`);

  const [existing] = await pool.query(
    'SELECT * FROM tenant_entitlement_overrides WHERE tenant_id = ? AND entitlement_id = ? AND status = \'active\' LIMIT 1',
    [id, ent.id]
  );
  const stored = ent.kind === 'boolean' ? (value ? '1' : '0') : String(value);

  if (existing[0]) {
    await pool.query(
      `UPDATE tenant_entitlement_overrides
       SET value = ?, reason = ?, effective_from = ?, effective_until = ?, status = 'active', approved_by = ?, approved_at = NOW()
       WHERE id = ?`,
      [stored, reason, effectiveFrom || null, effectiveUntil || null, req.user.id, existing[0].id]
    );
  } else {
    const [ins] = await pool.query(
      `INSERT INTO tenant_entitlement_overrides (tenant_id, entitlement_id, value, reason, status, approved_by, approved_at, effective_from, effective_until, created_by)
       VALUES (?,?,?,?, 'active', ?, NOW(), ?, ?, ?)`,
      [id, ent.id, stored, reason, req.user.id, effectiveFrom || null, effectiveUntil || null, req.user.id]
    );
    await platformAudit.logPlatformAudit({
      tenantId: id, actor: req.user, action: 'entitlement.override_create', category: 'entitlement',
      entityType: 'tenant_entitlement_override', entityId: ins.insertId,
      after: { entitlementKey, value: stored, effectiveFrom, effectiveUntil }, reason, req,
    });
  }
  entitlements.invalidateTenant(id);
  res.status(201).json({ ok: true, data: { entitlementKey, value: stored } });
}));

/** DELETE /tenants/:id/overrides/:overrideId — revoke, never delete. */
r.delete('/tenants/:id/overrides/:overrideId', requirePermission('platform.entitlements.manage'), asyncH(async (req, res) => {
  const id = int(req.params.id);
  const overrideId = int(req.params.overrideId);
  const reason = req.body?.reason || req.query.reason || null;
  const [rows] = await pool.query(
    `SELECT o.*, e.entitlement_key FROM tenant_entitlement_overrides o JOIN entitlements e ON e.id = o.entitlement_id
     WHERE o.id = ? AND o.tenant_id = ?`, [overrideId, id]
  );
  if (!rows[0]) throw new HttpError(404, 'Override not found');
  await pool.query(
    `UPDATE tenant_entitlement_overrides SET status = 'revoked', revoked_at = NOW(), revoked_by = ? WHERE id = ?`,
    [req.user.id, overrideId]
  );
  entitlements.invalidateTenant(id);
  await platformAudit.logPlatformAudit({
    tenantId: id, actor: req.user, action: 'entitlement.override_revoke', category: 'entitlement',
    entityType: 'tenant_entitlement_override', entityId: overrideId,
    before: { entitlementKey: rows[0].entitlement_key, value: rows[0].value },
    after: { status: 'revoked' }, reason, req,
  });
  res.json({ ok: true });
}));

// ============================================================ subscriptions (spec §26)
r.get('/subscriptions', requirePermission('platform.subscriptions.view'), asyncH(async (req, res) => {
  const { limit, offset, page } = paging(req.query);
  const where = [];
  const params = [];
  if (req.query.status) { where.push('s.status = ?'); params.push(req.query.status); }
  if (req.query.tenantId) { where.push('s.tenant_id = ?'); params.push(int(req.query.tenantId)); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM subscriptions s ${clause}`, params);
  const [rows] = await pool.query(
    `SELECT s.*, t.name AS tenant_name, t.slug AS tenant_slug,
            (SELECT COALESCE(SUM(price_per_period * (1 - discount_pct / 100)), 0) FROM subscriptions
              WHERE status IN ('trialing','active','past_due','grace_period')) AS platform_mrr
     FROM subscriptions s JOIN tenants t ON t.id = s.tenant_id
     ${clause} ORDER BY s.id DESC LIMIT ${limit} OFFSET ${offset}`,
    params
  );
  res.json({ data: rows, meta: { total: Number(total), page, pages: Math.ceil(Number(total) / limit), limit, statuses: SUBSCRIPTION_STATUSES } });
}));

r.get('/subscriptions/:id', requirePermission('platform.subscriptions.view'), asyncH(async (req, res) => {
  const [rows] = await pool.query(
    'SELECT s.*, t.name AS tenant_name FROM subscriptions s JOIN tenants t ON t.id = s.tenant_id WHERE s.id = ?',
    [int(req.params.id)]
  );
  if (!rows[0]) throw new HttpError(404, 'Subscription not found');
  res.json({ data: { ...rows[0], events: await subscriptions.events(rows[0].id, 100) } });
}));

/** POST /subscriptions/:id/transition — the only path that moves a subscription. */
r.post('/subscriptions/:id/transition', requirePermission('platform.subscriptions.manage'), asyncH(async (req, res) => {
  const { status, reason, ...patch } = req.body || {};
  if (!status) throw new HttpError(400, 'status is required');
  if (!reason || String(reason).trim().length < 5) throw new HttpError(400, 'A reason is required');
  const sub = await subscriptions.transition(int(req.params.id), status, { actor: req.user, reason, req, patch });
  res.json({ ok: true, data: sub });
}));

/** POST /subscriptions/:id/plan — move a company onto a different plan. */
r.post('/subscriptions/:id/plan', requirePermission('platform.subscriptions.manage'), asyncH(async (req, res) => {
  const { planKey, reason } = req.body || {};
  if (!planKey) throw new HttpError(400, 'planKey is required');
  if (!reason || String(reason).trim().length < 5) throw new HttpError(400, 'A reason is required');
  const sub = await subscriptions.changePlan({ subscriptionId: int(req.params.id), planKey, actor: req.user, req, reason });
  res.json({ ok: true, data: sub });
}));

// ============================================================ billing: terms, invoices, payments (spec §3)
r.patch('/subscriptions/:id/terms', requirePermission('platform.subscriptions.manage'), asyncH(async (req, res) => {
  const { reason, ...input } = req.body || {};
  const sub = await billing.updateTerms(int(req.params.id), input, { actor: req.user, req, reason });
  res.json({ ok: true, data: sub });
}));

r.get('/billing/invoices', requirePermission('platform.subscriptions.view'), asyncH(async (req, res) => {
  const { limit, offset, page } = paging(req.query);
  const result = await billing.listInvoices({
    tenantId: int(req.query.tenantId), status: req.query.status, overdueOnly: req.query.overdue === '1', limit, offset,
  });
  res.json({ data: result.rows, summary: result.summary, meta: { total: result.total, page, pages: Math.ceil(result.total / limit), limit } });
}));

r.get('/billing/invoices/:id', requirePermission('platform.subscriptions.view'), asyncH(async (req, res) => {
  res.json({ data: await billing.getInvoice(int(req.params.id)) });
}));

r.post('/subscriptions/:id/invoices', requirePermission('platform.subscriptions.manage'), asyncH(async (req, res) => {
  const { reason, ...input } = req.body || {};
  res.status(201).json({ data: await billing.createInvoice(int(req.params.id), input, { actor: req.user, req, reason }) });
}));

r.post('/billing/invoices/:id/payments', requirePermission('platform.subscriptions.manage'), asyncH(async (req, res) => {
  const { reason, ...input } = req.body || {};
  res.status(201).json({ data: await billing.recordPayment(int(req.params.id), input, { actor: req.user, req, reason }) });
}));

r.post('/billing/invoices/:id/void', requirePermission('platform.subscriptions.manage'), asyncH(async (req, res) => {
  res.json({ data: await billing.voidInvoice(int(req.params.id), { actor: req.user, req, reason: req.body?.reason }) });
}));

// ============================================================ usage & limits (spec §13, §33)
r.get('/tenants/:id/usage', requirePermission('platform.usage.view'), tenantReach, asyncH(async (req, res) => {
  const id = int(req.params.id);
  const [exists] = await pool.query('SELECT id FROM tenants WHERE id = ?', [id]);
  if (!exists[0]) throw new HttpError(404, 'Tenant not found');
  await usage.recompute(id, { source: 'platform_read', actorUserId: req.user.id, requestId: req.requestId });
  res.json({ data: await entitlements.usageDashboard(id) });
}));

r.post('/tenants/:id/usage/recompute', requirePermission('platform.usage.manage'), asyncH(async (req, res) => {
  const id = int(req.params.id);
  const results = await usage.recompute(id, { source: 'manual', actorUserId: req.user.id, requestId: req.requestId });
  await platformAudit.logPlatformAudit({
    tenantId: id, actor: req.user, action: 'usage.recompute', category: 'usage',
    entityType: 'tenant', entityId: id, after: results, req,
  });
  res.json({ data: results });
}));

r.get('/usage/breaches', requirePermission('platform.usage.view'), asyncH(async (req, res) => {
  res.json({ data: await limits.breaches() });
}));

// ============================================================ modules (spec §16, §17)
r.get('/modules', requirePermission('platform.tenants.view'), tenantReach, asyncH(async (req, res) => {
  const id = int(req.query.tenantId || req.user.tenant_id);
  if (!id) throw new HttpError(400, 'tenantId is required');
  const out = [];
  for (const m of MODULE_CATALOG) {
    const av = await entitlements.moduleAvailability(id, m.key);
    out.push({
      ...m,
      requires: moduleDependencies(m.key),
      entitled: av.entitled,
      configured: av.configured,
      available: av.enabled,
      reason: av.reason,
      missingDependencies: av.missingDependencies,
    });
  }
  res.json({ data: out });
}));

/**
 * PUT /tenants/:id/modules/:key — enable/disable for one company.
 *
 * Disabling never deletes data (spec §17): the row is flipped, historical records
 * stay, and re-enabling restores them. Dependencies are checked before the write
 * so the refusal explains which module is missing.
 */
r.put('/tenants/:id/modules/:key', requirePermission('platform.plans.manage'), asyncH(async (req, res) => {
  const id = int(req.params.id);
  const key = String(req.params.key);
  const { enabled, reason } = req.body || {};
  const catalog = MODULE_CATALOG.find((m) => m.key === key);
  if (!catalog) throw new HttpError(404, 'Unknown module');

  if (enabled) {
    const errors = [];
    for (const dep of moduleDependencies(key)) {
      const depAv = await entitlements.moduleAvailability(id, dep);
      if (!depAv.enabled) errors.push({ module: dep, name: depAv.name, reason: depAv.reason });
    }
    if (errors.length) {
      throw new HttpError(409, `${catalog.name} cannot be enabled: it requires ${errors.map((e) => e.name).join(', ')}`,
        { dependencies: errors });
    }
    const av = await entitlements.moduleAvailability(id, key);
    if (!av.entitled) {
      throw new HttpError(402, `${catalog.name} is not included in this company's plan`, { entitlement: av.entitlement, reason: av.reason });
    }
  }

  const [before] = await pool.query('SELECT enabled FROM module_configurations WHERE tenant_id = ? AND module_key = ?', [id, key]);
  await pool.query(
    `INSERT INTO module_configurations (tenant_id, module_key, name, category, enabled, updated_by)
     VALUES (?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE enabled = VALUES(enabled), updated_by = VALUES(updated_by), updated_at = NOW()`,
    [id, key, catalog.name, catalog.category, enabled ? 1 : 0, req.user.id]
  );
  rbac.invalidateTenant(id);
  await platformAudit.logPlatformAudit({
    tenantId: id, actor: req.user, action: enabled ? 'module.enabled' : 'module.disabled',
    category: 'tenant', entityType: 'module', entityId: key,
    before: { enabled: before[0] ? !!before[0].enabled : null }, after: { enabled: !!enabled },
    reason: reason || null, req,
  });
  res.json({ ok: true, data: { module: key, enabled: !!enabled } });
}));

// ============================================================ support access (spec §21)
r.get('/support-access', requirePermission('platform.support.view'), asyncH(async (req, res) => {
  await supportAccess.sweepExpired();
  const { limit, offset, page } = paging(req.query);
  const result = await supportAccess.list({
    tenantId: int(req.query.tenantId), status: req.query.status, limit, offset,
  });
  res.json({ data: result.rows, meta: { total: result.total, page, pages: Math.ceil(result.total / limit), limit, accessTypes: supportAccess.ACCESS_TYPES } });
}));

r.get('/support-access/mine', requirePermission('platform.support.view'), asyncH(async (req, res) => {
  res.json({ data: await supportAccess.currentSession(req.user.id) });
}));

r.post('/support-access', requirePermission('platform.support.grant'), asyncH(async (req, res) => {
  const { tenantId, reason, accessType, durationMinutes, scope, ticketRef, requiresApproval } = req.body || {};
  if (!tenantId) throw new HttpError(400, 'tenantId is required');
  const session = await supportAccess.grant({
    tenantId: int(tenantId), reason, accessType, durationMinutes,
    scope, ticketRef, requiresApproval: !!requiresApproval, actor: req.user, req,
  });
  res.status(201).json({ data: session });
}));

r.post('/support-access/:id/revoke', requirePermission('platform.support.revoke'), asyncH(async (req, res) => {
  const reason = req.body?.reason || null;
  const session = await supportAccess.revoke(int(req.params.id), { reason, actor: req.user, req });
  res.json({ ok: true, data: session });
}));

/**
 * Second-operator approval (spec §21). A session requested with
 * `requires_approval` grants nothing until a *different* operator approves it —
 * self-approval is refused inside the service, so this route cannot be used to
 * wave your own request through.
 */
r.post('/support-access/:id/approve', requirePermission('platform.support.grant'), asyncH(async (req, res) => {
  const session = await supportAccess.approve(int(req.params.id), {
    actor: req.user, req, reason: req.body?.reason || null,
  });
  res.json({ ok: true, data: session });
}));

r.get('/support-access/:id/logs', requirePermission('platform.support.view'), asyncH(async (req, res) => {
  res.json({ data: await supportAccess.logsForSession(int(req.params.id)) });
}));

// ============================================================ platform audit (spec §30)
r.get('/audit', requirePermission('platform.audit.view'), asyncH(async (req, res) => {
  const { limit, offset, page } = paging(req.query, 50);
  const result = await platformAudit.list({
    limit, offset,
    tenantId: int(req.query.tenantId),
    category: req.query.category,
    action: req.query.action,
    actorUserId: int(req.query.actorUserId),
    q: req.query.q,
  });
  res.json({ data: result.rows, meta: { total: result.total, page, pages: Math.ceil(result.total / limit), limit } });
}));

// ============================================================ data export / deletion (spec §28, §29)
r.get('/exports/catalog', requirePermission('platform.data.export'), asyncH(async (req, res) => {
  // `formats` is sent so the console can only offer what the worker can really
  // produce — offering CSV/zip here while the worker emits JSON would be a lie
  // the customer only discovers at download time.
  res.json({
    data: {
      datasets: Object.entries(exportService.DATASETS).map(([key, ds]) => ({
        key, label: ds.label, sensitive: !!ds.sensitive,
      })),
      formats: Object.keys(exportService.SUPPORTED_FORMATS),
      csvSingleDatasetOnly: true,
    },
  });
}));

/**
 * POST /tenants/:id/exports
 *
 * Queues a tracked export job (spec §28). The response is the *request*, not the
 * data — assembly happens in the lifecycle worker, so this endpoint cannot be
 * used to pull a whole tenant inside one authenticated request.
 */
r.post('/tenants/:id/exports', requirePermission('platform.data.export'), asyncH(async (req, res) => {
  const id = int(req.params.id);
  const { scope, format, reason } = req.body || {};
  let job;
  try {
    job = await exportService.request({
      tenantId: id, scope, format, reason, actor: req.user, req,
    });
  } catch (e) {
    throw new HttpError(400, e.message);
  }
  res.status(201).json({ data: { id: job.id, status: job.status, scope: job.scope } });
}));

/** Tracked export requests for a company — the Data tab's export panel. */
r.get('/tenants/:id/exports', requirePermission('platform.data.export'), tenantReach, asyncH(async (req, res) => {
  res.json({ data: await exportService.listForTenant(int(req.params.id)) });
}));

/**
 * GET /exports/:id/download
 *
 * Retrieval of a finished artefact. Refused unless the caller has a live support
 * session for that tenant — the file contains the customer's payroll, so it is
 * gated exactly like reading payroll would be, not like requesting an export.
 */
r.get('/exports/:id/download', requirePermission('platform.data.export'), asyncH(async (req, res) => {
  const job = await exportService.byId(int(req.params.id));
  if (!job) throw new HttpError(404, 'Export not found');
  await supportAccess.assertTenantReach(req.user, job.tenant_id);
  if (job.status !== 'completed' || !job.storage_path) throw new HttpError(409, 'That export has not completed');
  if (job.expires_at && new Date(job.expires_at) < new Date()) throw new HttpError(410, 'That export has expired');
  const path = require('path');
  const fs = require('fs');
  const full = path.join(require('../../config/env').uploadDir, job.storage_path);
  if (!fs.existsSync(full)) throw new HttpError(410, 'That export artefact is no longer available');
  await platformAudit.logPlatformAudit({
    tenantId: job.tenant_id, actor: req.user, action: 'data.export_downloaded', category: 'data',
    entityType: 'data_export_request', entityId: job.id,
    after: { byteSize: Number(job.byte_size || 0) }, reason: job.reason, req,
  });
  res.download(full);
}));

/**
 * POST /tenants/:id/delete-now — permanent, immediate deletion (Super Admin only).
 * The grace-period request remains the default; this is the deliberate shortcut and
 * therefore asks for the most: a reason, the company's slug typed back, and the
 * operator's own password. The purge itself refuses while a live subscription exists.
 */
r.post('/tenants/:id/delete-now', SUPER, requirePermission('platform.data.delete'), asyncH(async (req, res) => {
  const id = int(req.params.id);
  if (req.user.role !== 'platform_super_admin') throw new HttpError(403, 'Only the Platform Super Admin may delete a company immediately');
  const { reason, password, confirmSlug } = req.body || {};
  if (!reason || String(reason).trim().length < 10) throw new HttpError(400, 'A detailed reason is required');
  const [[t]] = await pool.query('SELECT id, name, slug FROM tenants WHERE id = ?', [id]);
  if (!t) throw new HttpError(404, 'Tenant not found');
  if (String(confirmSlug || '').trim() !== t.slug) throw new HttpError(400, `Type the company slug "${t.slug}" to confirm`);
  if (!password) throw new HttpError(428, 'Re-enter your password to confirm', { requiresReauthentication: true });
  const bcrypt = require('bcryptjs');
  const [me] = await pool.query('SELECT password_hash FROM users WHERE id = ?', [req.user.id]);
  if (!me[0] || !(await bcrypt.compare(String(password), me[0].password_hash))) {
    await platformAudit.logPlatformAudit({
      tenantId: id, actor: req.user, action: 'data.deletion_requested', category: 'data',
      outcome: 'denied', reason: 'Immediate deletion: re-authentication failed', req,
    });
    throw new HttpError(401, 'That password is incorrect');
  }
  const [open] = await pool.query("SELECT id FROM tenant_deletion_requests WHERE tenant_id = ? AND status IN ('requested','scheduled')", [id]);
  let requestId = open[0]?.id;
  if (requestId) {
    await pool.query("UPDATE tenant_deletion_requests SET status = 'scheduled' WHERE id = ?", [requestId]);
  } else {
    const [ins] = await pool.query(
      `INSERT INTO tenant_deletion_requests (tenant_id, requested_by, requested_by_name, reason, status, grace_ends_at, purge_after, reauthenticated_at)
       VALUES (?,?,?,?, 'scheduled', NOW(), NOW(), NOW())`, [id, req.user.id, req.user.name, reason]);
    requestId = ins.insertId;
    await subscriptions.setTenantStatus(id, 'deletion_pending', { actor: req.user, reason, req });
  }
  const lifecycle = require('../../services/lifecycle');
  const report = { errors: [], deletionsPurged: [], deletionCancellations: [] };
  await lifecycle.purgeDeletedTenants({ actor: req.user, req, why: 'Immediate deletion by Platform Super Admin', report, onlyIds: [Number(requestId)] });
  if (!report.deletionsPurged.length) {
    const why = report.errors[0]?.message || 'The company still holds a live subscription — cancel it first';
    throw new HttpError(409, `Company was not deleted: ${why}`);
  }
  res.json({ data: { deleted: true, tenantId: id } });
}));

/**
 * POST /tenants/:id/deletion-request
 *
 * There is no one-click hard delete (spec §29). This starts a tracked request
 * with a grace period during which it can be cancelled, and the destructive step
 * itself is a separate, deliberate call.
 *
 * The caller's *password* is required, not merely their session. Deleting a
 * company is the most damaging action in the product and the one most likely to
 * be attempted from a borrowed or unattended console session, so the operator
 * re-proves who they are at the moment they ask for it. `reauthenticated_at`
 * records that the password was actually checked — previously it was stamped
 * unconditionally, which made the column a claim rather than a fact.
 */
r.post('/tenants/:id/deletion-request', requirePermission('platform.data.delete'), asyncH(async (req, res) => {
  const id = int(req.params.id);
  const { reason, graceDays = 30, password } = req.body || {};
  if (!reason || String(reason).trim().length < 10) throw new HttpError(400, 'A detailed reason is required');
  if (!password) {
    throw new HttpError(428, 'Re-enter your password to confirm a tenant deletion', { requiresReauthentication: true });
  }
  const bcrypt = require('bcryptjs');
  const [me] = await pool.query('SELECT password_hash FROM users WHERE id = ?', [req.user.id]);
  if (!me[0] || !(await bcrypt.compare(String(password), me[0].password_hash))) {
    await platformAudit.logPlatformAudit({
      tenantId: id, actor: req.user, action: 'data.deletion_requested', category: 'data',
      outcome: 'denied', before: null, after: null,
      reason: 'Re-authentication failed — wrong password', req,
    });
    throw new HttpError(401, 'That password is incorrect');
  }
  const [open] = await pool.query(
    "SELECT id FROM tenant_deletion_requests WHERE tenant_id = ? AND status IN ('requested','scheduled')", [id]
  );
  if (open[0]) throw new HttpError(409, 'A deletion request is already open for this company');

  const grace = Math.min(90, Math.max(1, Number(graceDays) || 30));
  const [ins] = await pool.query(
    `INSERT INTO tenant_deletion_requests (tenant_id, requested_by, requested_by_name, reason, status, grace_ends_at, purge_after, reauthenticated_at)
     VALUES (?,?,?,?, 'requested', DATE_ADD(NOW(), INTERVAL ? DAY), DATE_ADD(NOW(), INTERVAL ? DAY), NOW())`,
    [id, req.user.id, req.user.name, reason, grace, grace]
  );
  await subscriptions.setTenantStatus(id, 'deletion_pending', { actor: req.user, reason, req });
  await platformAudit.logPlatformAudit({
    tenantId: id, actor: req.user, action: 'data.deletion_requested', category: 'data',
    entityType: 'tenant_deletion_request', entityId: ins.insertId,
    after: { graceDays: grace, purgeAfter: new Date(Date.now() + grace * 86400000).toISOString() },
    reason, req,
  });
  res.status(201).json({ data: { id: ins.insertId, status: 'requested', graceDays: grace } });
}));

r.post('/deletion-requests/:id/cancel', requirePermission('platform.data.delete'), asyncH(async (req, res) => {
  const id = int(req.params.id);
  const [rows] = await pool.query('SELECT * FROM tenant_deletion_requests WHERE id = ?', [id]);
  if (!rows[0]) throw new HttpError(404, 'Deletion request not found');
  if (rows[0].status === 'completed') throw new HttpError(409, 'That deletion has already completed');
  await pool.query(
    `UPDATE tenant_deletion_requests SET status = 'cancelled', cancelled_at = NOW(), cancelled_by = ? WHERE id = ?`,
    [req.user.id, id]
  );
  await subscriptions.setTenantStatus(rows[0].tenant_id, 'active', {
    actor: req.user, reason: req.body?.reason || 'Deletion request cancelled', req,
  });
  await platformAudit.logPlatformAudit({
    tenantId: rows[0].tenant_id, actor: req.user, action: 'data.deletion_cancelled', category: 'data',
    entityType: 'tenant_deletion_request', entityId: id, after: { status: 'cancelled' },
    reason: req.body?.reason || null, req,
  });
  res.json({ ok: true });
}));

// ============================================================ modules catalog + tenancy
r.get('/catalog', requirePermission('platform.dashboard.view'), asyncH(async (req, res) => {
  res.json({
    data: {
      modules: MODULE_CATALOG.map((m) => ({ ...m, requires: moduleDependencies(m.key) })),
      entitlements: ENTITLEMENT_CATALOG,
      plans: PLATFORM_PLANS.map((p) => ({ key: p.key, name: p.name, planType: p.planType, priceMonthly: p.priceMonthly, trialDays: p.trialDays, isPublic: p.isPublic !== false })),
      subscriptionStatuses: SUBSCRIPTION_STATUSES,
      tenantStatuses: TENANT_STATUSES,
      accessTypes: supportAccess.ACCESS_TYPES,
    },
  });
}));

module.exports = r;