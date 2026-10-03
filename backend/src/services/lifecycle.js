/**
 * Lifecycle automation (spec §26, §27, §29).
 *
 * The subscription and tenant state machines are enforced when an *operator*
 * acts — `subscriptions.transition()` validates every manual move. That is only
 * half the contract: a trial that nobody cancels still has to end, and a company
 * that stops paying still has to lose its writes, without anyone remembering to
 * press a button. This module is the clock.
 *
 * It is a plain, idempotent, single-process sweeper rather than a distributed
 * job runner, because every step it takes is a transition through the same
 * validated path an operator would use. Running it twice in a minute is a no-op
 * the second time, so a missed tick or a restarted process costs nothing.
 *
 * Steps, in order of how damaging a missed tick is:
 *   1. expire trials that ran out                 → subscription `expired`
 *   2. escalate past due → grace → suspended      → billing dunning
 *   3. renew subscriptions whose period ended     → `renewed` event
 *   4. expire support access sessions past `expires_at`
 *   5. cancel a deletion request inside its grace period
 *   6. purge a tenant whose `purge_after` has passed
 *
 * The purge is deliberately the *only* destructive step here, and it refuses to
 * run for a tenant that still holds a live subscription (spec §29: the deletion
 * must not be silently abandoned by a billing accident).
 */
const { pool } = require('../config/db');
const subscriptions = require('./subscriptions');
const platformAudit = require('./platformAudit');
// Not named `exports` — that identifier is the CommonJS export binding and
// redeclaring it in this module scope throws at require time.
const dataExports = require('./exports');

const GRACE_PERIOD_DAYS = 7;

/**
 * Run every lifecycle step once. Returns a report of what each step changed so
 * callers (the CLI runner, the boot hook and the tests) can assert on it rather
 * than on log output.
 */
async function sweep(opts = {}) {
  // Several API instances can run this scheduler. A MySQL named lock (non-blocking) lets
  // exactly one of them sweep at a time; the others skip the tick instead of racing to
  // expire the same trials and purge the same company twice.
  const conn = await pool.getConnection();
  try {
    const [[row]] = await conn.query("SELECT GET_LOCK('arthvex:lifecycle-sweep', 0) AS got");
    if (Number(row.got) !== 1) {
      return {
        ranAt: new Date().toISOString(), skipped: true, trialsExpired: [], escalated: [], renewed: [],
        supportSessionsExpired: [], deletionCancellations: [], deletionsPurged: [], exportsRun: [],
        exportArtefactsRemoved: 0, errors: [],
      };
    }
    try {
      return await runSweep(opts);
    } finally {
      await conn.query("SELECT RELEASE_LOCK('arthvex:lifecycle-sweep')").catch(() => {});
    }
  } finally {
    conn.release();
  }
}

async function runSweep({ actor = SYSTEM_ACTOR, req, reason } = {}) {
  const report = {
    ranAt: new Date().toISOString(),
    trialsExpired: [],
    escalated: [],
    renewed: [],
    supportSessionsExpired: [],
    deletionCancellations: [],
    deletionsPurged: [],
    exportsRun: [],
    exportArtefactsRemoved: 0,
    errors: [],
  };
  const why = reason || 'Scheduled lifecycle automation';

  // Deletion requests that were already past their grace period *before* this
  // sweep ran. Captured up front so a request scheduled by this same pass is never
  // purged by it: scheduling and destruction must be separate observations, or an
  // operator watching the console would never see the `scheduled` state at all.
  const alreadyScheduled = await scheduledDeletionIds();

  for (const [step, fn] of [
    ['expireTrials', () => expireTrials({ actor, req, why, report })],
    ['escalateOverdue', () => escalateOverdue({ actor, req, why, report })],
    ['renewPeriods', () => renewPeriods({ actor, req, why, report })],
    ['expireSupportAccess', () => expireSupportAccess({ actor, req, why, report })],
    ['usageAlerts', () => usageAlerts({ report })],
    ['runExports', () => runExports({ actor, req, why, report })],
    ['expireExportArtefacts', () => { report.exportArtefactsRemoved = dataExports.sweepExpired(); }],
    // Scheduling happens strictly before purging, and the purge only considers
    // requests that were *already* scheduled when this pass began — see `sweep()`.
    ['scheduleDeletions', () => cancelExpiredDeletions({ actor, req, why, report })],
    ['purgeDeletedTenants', () => purgeDeletedTenants({ actor, req, why, report, onlyIds: alreadyScheduled })],
  ]) {
    try {
      await fn();
    } catch (e) {
      // One bad row must not stop the other steps from running — a failed trial
      // expiry should still not let support sessions stay alive.
      report.errors.push({ step, message: e?.message || String(e) });
    }
  }
  return report;
}

/** Transitions always get an actor; automation is not anonymous in the trail. */
const SYSTEM_ACTOR = { id: null, name: 'ARTHVEX automation', email: null, role: 'system' };

// ------------------------------------------------------------ usage alerts

let lastUsageAlertRun = 0;
const USAGE_ALERT_EVERY_MS = 60 * 60 * 1000;

/**
 * Warn at the warning/critical thresholds. Hourly at most (it walks every company), and each
 * condition notifies once per calendar month and severity — so a company hovering at 85% produces
 * one operator alert and one in-app message to its owners, not one per sweep.
 */
async function usageAlerts({ report, force = false }) {
  if (!force && Date.now() - lastUsageAlertRun < USAGE_ALERT_EVERY_MS) return 0;
  lastUsageAlertRun = Date.now();
  const limits = require('./limits');
  const pn = require('./platformNotifications');
  const month = new Date().toISOString().slice(0, 7);
  let sent = 0;
  for (const b of await limits.breaches()) {
    const reached = ['hard_limit', 'exceeded'].includes(b.status);
    const dedupe = `usage:${b.tenantId}:${b.entitlementKey}:${reached ? 'limit' : 'near'}:${month}`;
    const made = await pn.notify({
      event: reached ? 'limit_reached' : 'limit_near', severity: reached ? 'critical' : 'warning', tenantId: b.tenantId,
      title: `${b.tenantName}: ${b.entitlementName} at ${b.percentUsed}%`, body: `${b.current} of ${b.limit}`, dedupe,
    });
    if (!made.created) continue;
    sent++;
    // The company's own administrators hear about it once, in-app.
    const [owners] = await pool.query(
      "SELECT id FROM users WHERE tenant_id = ? AND status = 'active' AND role IN ('company_owner','hr_admin')", [b.tenantId]);
    for (const o of owners) {
      await pool.query('INSERT INTO notifications (tenant_id, user_id, ntype, title, body, link) VALUES (?,?,?,?,?,?)',
        [b.tenantId, o.id, 'usage.limit', `${b.entitlementName}: ${b.percentUsed}% of your plan limit used`,
          reached ? 'The limit is reached — new records of this kind are blocked until you upgrade.' : `${b.current} of ${b.limit} used.`, '/account']);
    }
  }
  if (report && sent) report.usageAlerts = sent;
  return sent;
}

// ------------------------------------------------------------------ 1. trials

/**
 * A trial past `trial_ends_at` becomes `expired`, which mirrors the tenant to
 * `cancelled` — read-only, not locked out, so the company keeps its own records.
 */
async function expireTrials({ actor, req, why, report }) {
  // Heads-up for operators 3 days before a trial ends — one notification per trial end date.
  const [soon] = await pool.query(
    `SELECT id, tenant_id, trial_ends_at FROM subscriptions
      WHERE status = 'trialing' AND trial_ends_at > NOW() AND trial_ends_at <= DATE_ADD(NOW(), INTERVAL 3 DAY)`);
  for (const t of soon) {
    await require('./platformNotifications').notify({
      event: 'trial_ending', severity: 'warning', tenantId: t.tenant_id, title: 'Trial ends within 3 days',
      body: `Trial ends ${new Date(t.trial_ends_at).toISOString().slice(0, 10)}`, dedupe: `trial-ending:${t.id}:${new Date(t.trial_ends_at).toISOString().slice(0, 10)}`,
    });
  }
  const [rows] = await pool.query(
    `SELECT id, tenant_id, trial_ends_at FROM subscriptions
      WHERE status = 'trialing' AND trial_ends_at IS NOT NULL AND trial_ends_at <= NOW()`
  );
  for (const sub of rows) {
    await subscriptions.transition(sub.id, 'expired', {
      actor, reason: `${why}: trial ended ${sub.trial_ends_at}`, req,
    });
    report.trialsExpired.push({ subscriptionId: sub.id, tenantId: sub.tenant_id });
  }
  return report.trialsExpired.length;
}

// -------------------------------------------------------------- 2. dunning

/**
 * Non-payment dunning. `past_due` moves into `grace_period` immediately (the
 * clock starts when the invoice fails, not when an operator notices), and
 * `grace_period` escalates to `suspended` once `grace_ends_at` has passed.
 */
async function escalateOverdue({ actor, req, why, report }) {
  // active -> past_due when an invoice has gone unpaid past its due date. This is what
  // starts the dunning chain below; without it nothing ever marks a customer past due.
  const [unpaid] = await pool.query(
    `SELECT DISTINCT s.id, s.tenant_id FROM subscriptions s
       JOIN subscription_invoices i ON i.subscription_id = s.id
      WHERE s.status = 'active' AND i.status = 'open' AND i.due_at < CURDATE()`
  );
  for (const sub of unpaid) {
    await subscriptions.transition(sub.id, 'past_due', {
      actor, reason: `${why}: an invoice is unpaid past its due date`, req,
    });
    report.escalated.push({ subscriptionId: sub.id, tenantId: sub.tenant_id, to: 'past_due' });
  }

  // past_due -> grace_period. No time gate: grace begins the moment payment fails.
  const [stale] = await pool.query(
    `SELECT id, tenant_id FROM subscriptions WHERE status = 'past_due'`
  );
  for (const sub of stale) {
    await subscriptions.transition(sub.id, 'grace_period', {
      actor, reason: `${why}: payment outstanding, grace period started`, req,
    });
    report.escalated.push({ subscriptionId: sub.id, tenantId: sub.tenant_id, to: 'grace_period' });
  }

  // grace_period -> suspended, but only once the grace window has actually run out.
  const [lapsed] = await pool.query(
    `SELECT id, tenant_id, grace_ends_at FROM subscriptions
      WHERE status = 'grace_period' AND grace_ends_at IS NOT NULL AND grace_ends_at <= NOW()`
  );
  for (const sub of lapsed) {
    await subscriptions.transition(sub.id, 'suspended', {
      actor, reason: `${why}: grace period ended ${sub.grace_ends_at}, write access suspended`, req,
    });
    report.escalated.push({ subscriptionId: sub.id, tenantId: sub.tenant_id, to: 'suspended' });
  }
  return report.escalated.length;
}

// ------------------------------------------------------------------ 3. renewals

/**
 * Roll the billing period forward for an auto-renewing subscription whose period
 * has ended. Renewal is recorded as an event, which is what makes MRR history
 * answerable rather than inferred from the current row.
 */
async function renewPeriods({ actor, req, why, report }) {
  // A subscription whose owner asked to cancel at period end must end, not renew.
  const [ending] = await pool.query(
    `SELECT id FROM subscriptions WHERE status IN ('active','past_due','grace_period') AND cancel_at_period_end = 1
        AND current_period_end IS NOT NULL AND current_period_end <= NOW()`);
  for (const sub of ending) {
    await subscriptions.transition(sub.id, 'cancelled', { actor, req, reason: `${why}: cancellation scheduled for the end of the period` });
  }
  const [rows] = await pool.query(
    `SELECT id, tenant_id, plan_key, billing_cycle, current_period_end FROM subscriptions
      WHERE status = 'active' AND auto_renew = 1
        AND current_period_end IS NOT NULL AND current_period_end <= NOW()`
  );
  for (const sub of rows) {
    const interval = { monthly: '1 MONTH', quarterly: '3 MONTH', annual: '1 YEAR' }[sub.billing_cycle] || '1 MONTH';
    // Anchor the new period on the previous end date so a sweeper that was down
    // for several periods does not silently skip billing months.
    await pool.query(
      `UPDATE subscriptions SET current_period_start = current_period_end,
              current_period_end = DATE_ADD(COALESCE(current_period_end, NOW()), INTERVAL ${interval}),
              updated_at = NOW()
       WHERE id = ?`,
      [sub.id]
    );
    await platformAudit.logPlatformAudit({
      tenantId: sub.tenant_id, actor, action: 'subscription.renewed', category: 'subscription',
      entityType: 'subscription', entityId: sub.id,
      after: { planKey: sub.plan_key, billingCycle: sub.billing_cycle },
      reason: why, req,
    });
    report.renewed.push({ subscriptionId: sub.id, tenantId: sub.tenant_id });
  }
  return report.renewed.length;
}

// --------------------------------------------------------- 4. support sessions

/**
 * Support access is only as trustworthy as its expiry. The request path already
 * refuses an elapsed session (`supportAccess.assertActive`), so this step is
 * about the *record* being truthful rather than about enforcement — an operator
 * should not see an expired session still listed as active (spec §21).
 */
async function expireSupportAccess({ actor, req, why, report }) {
  const [rows] = await pool.query(
    `SELECT id, tenant_id, granted_by FROM support_access_sessions
      WHERE status = 'active' AND expires_at <= NOW()`
  );
  for (const s of rows) {
    await pool.query(
      `UPDATE support_access_sessions SET status = 'expired' WHERE id = ? AND status = 'active'`, [s.id]
    );
    await platformAudit.logPlatformAudit({
      tenantId: s.tenant_id, actor, action: 'support.session_expired', category: 'support',
      entityType: 'support_access_session', entityId: s.id,
      after: { status: 'expired' }, reason: why, req,
    });
    report.supportSessionsExpired.push({ sessionId: s.id, tenantId: s.tenant_id });
  }
  return report.supportSessionsExpired.length;
}

// ------------------------------------------------------------------ 5. exports

/**
 * Assemble queued tenant data exports (spec §28). Exports are tracked jobs, so
 * something has to actually run them; without this the console would show
 * requests stuck in `queued` forever.
 */
async function runExports({ report }) {
  const done = await dataExports.runQueued(5);
  for (const job of done) {
    report.exportsRun.push({
      requestId: job.id, tenantId: job.tenant_id, status: job.status, byteSize: Number(job.byte_size || 0),
    });
  }
  return report.exportsRun.length;
}

// -------------------------------------------------------- 6. deletion cancels

/**
 * A deletion request can still be called off while it sits inside its grace
 * period (spec §29: keep the process reversible where technically feasible). If
 * nobody called it off by the time `purge_after` arrives, it becomes `scheduled`
 * so the purge step can act on it — the last reversible moment.
 */
async function cancelExpiredDeletions({ actor, req, why, report }) {
  const [rows] = await pool.query(
    `SELECT id, tenant_id FROM tenant_deletion_requests WHERE status = 'requested' AND purge_after <= NOW()`
  );
  for (const d of rows) {
    await pool.query(
      `UPDATE tenant_deletion_requests SET status = 'scheduled' WHERE id = ? AND status = 'requested'`, [d.id]
    );
    await platformAudit.logPlatformAudit({
      tenantId: d.tenant_id, actor, action: 'data.deletion_scheduled', category: 'data',
      entityType: 'tenant_deletion_request', entityId: d.id,
      after: { status: 'scheduled' }, reason: `${why}: grace period elapsed without cancellation`, req,
    });
    report.deletionCancellations.push({ requestId: d.id, tenantId: d.tenant_id });
  }
  return report.deletionCancellations.length;
}

// --------------------------------------------------------------- 7. purging

/**
 * Every file on disk belonging to a tenant.
 *
 * Uploads are written flat to `uploads/<subdir>/<timestamp>-<random>.<ext>` with no
 * tenant directory, so the referencing row is the only thing that ties a file to a
 * company. This must therefore run *before* the rows are deleted, or the customer's
 * payslips and ID documents become unreachable and permanently orphaned — rows
 * gone, personal data still on the server, tenant reported as deleted.
 *
 * Paths are resolved and confirmed to stay inside the upload directory, so a
 * corrupted or hand-edited `file_path` cannot turn a purge into an arbitrary
 * filesystem delete.
 */
async function tenantUploadedFiles(tenantId) {
  const out = [];
  for (const table of ['company_documents', 'employee_documents']) {
    const [rows] = await pool.query(
      `SELECT file_path FROM ${table} WHERE tenant_id = ? AND file_path IS NOT NULL`, [tenantId]
    );
    out.push(...rows.map((r) => r.file_path));
  }
  return [...new Set(out)];
}

/** Delete the collected uploads. Returns how many were actually removed. */
function removeUploadedFiles(paths, report) {
  const fs = require('fs');
  const path = require('path');
  const env = require('../config/env');
  const root = path.resolve(env.uploadDir);
  let removed = 0;

  for (const rel of paths) {
    const full = path.resolve(root, rel);
    // Never follow a stored path outside the upload directory.
    if (full !== root && !full.startsWith(root + path.sep)) {
      report.errors.push({ step: 'purgeDeletedTenants', message: `refused to delete outside the upload directory: ${rel}` });
      continue;
    }
    try {
      fs.unlinkSync(full);
      removed++;
    } catch (e) {
      if (e.code !== 'ENOENT') {
        report.errors.push({ step: 'purgeDeletedTenants', message: `could not delete ${rel}: ${e.message}` });
      }
    }
  }
  return removed;
}

/** Request ids already in `scheduled`, captured before a sweep mutates anything. */
async function scheduledDeletionIds() {
  const [rows] = await pool.query(`SELECT id FROM tenant_deletion_requests WHERE status = 'scheduled'`);
  return rows.map((r) => Number(r.id));
}

/**
 * Child-first ordering. This schema declares no foreign keys, so nothing *forces*
 * an order — but a partial purge that dies halfway is much easier to reason about
 * when the leaves are already gone and only the core records remain. Tables not
 * listed here are appended at the end (see `tenantScopedTables`) so a table added
 * after this was written is still purged rather than silently orphaned.
 */
const PURGE_ORDER = [
  // trails, joins and per-event rows first
  'support_access_logs', 'audit_logs', 'usage_events', 'tenant_usage',
  'subscription_events', 'tenant_status_history', 'data_export_requests', 'tenant_deletion_requests',
  'webhook_deliveries', 'login_events', 'idempotency_keys', 'access_requests', 'config_versions',
  'user_roles', 'user_direct_permissions', 'user_invitations', 'approval_delegations',
  'workflow_runs', 'workflow_tasks', 'workflow_actions', 'workflow_versions',
  'notification_templates', 'delivery_logs', 'dashboard_widgets',
  // transactional detail
  'attendance_records', 'attendance_regularizations', 'attendance_imports', 'attendance_locks',
  'leave_requests', 'leave_balances', 'shift_swaps', 'payslips', 'payroll_items', 'payroll_adjustments',
  'payslips', 'expense_claims', 'employee_salaries', 'employee_timeline', 'employee_documents',
  'timesheet_entries', 'timesheets', 'travel_settlements', 'travel_bookings', 'travel_advances',
  // master data
  'api_keys', 'webhook_subscriptions', 'integration_connections', 'module_configurations',
  'company_feature_flags', 'security_policies', 'ip_restrictions', 'settings', 'roles',
  'sso_configs', 'legal_entities', 'tenants',
  // the records themselves
  'employees', 'locations', 'departments', 'designations', 'grades', 'shifts', 'holidays',
  'company_documents', 'users',
];

/**
 * Every table carrying a `tenant_id`, resolved from the live schema.
 *
 * Derived rather than hard-coded on purpose: this application has ~150 tenant-scoped
 * tables, and a static list that silently misses one leaves a deleted customer's
 * payroll rows sitting in the database forever. Discovery means a table added next
 * release is covered without touching this file.
 *
 * `platform_audit_logs` is excluded by name. It is deliberately *not* customer
 * data — it is ARTHVEX's own record of what it did to that customer, including
 * the purge itself. Deleting it would destroy the only evidence that the deletion
 * happened and was authorised.
 */
const PRESERVED_AFTER_PURGE = ['platform_audit_logs', 'tenants', 'subscription_invoices', 'subscription_payments'];

async function tenantScopedTables() {
  const [rows] = await pool.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'
        AND EXISTS (
          SELECT 1 FROM information_schema.columns c
           WHERE c.table_schema = DATABASE() AND c.table_name = information_schema.tables.table_name
             AND c.column_name = 'tenant_id')
      ORDER BY table_name`
  );
  const all = rows.map((r) => r.table_name).filter((t) => !PRESERVED_AFTER_PURGE.includes(t));
  const known = PURGE_ORDER.filter((t) => all.includes(t));
  const extra = all.filter((t) => !PURGE_ORDER.includes(t));
  return [...known, ...extra];
}

/**
 * Irreversibly remove a tenant's data. Only ever called for a request that has
 * been `scheduled` — i.e. past its grace period — and only when no live
 * subscription remains, so a billing error cannot delete a paying customer's
 * workforce records.
 *
 * The purge is recorded in the platform audit *before* the rows go, because
 * afterwards there is no longer a tenant row to hang that audit off.
 */
async function purgeDeletedTenants({ actor, req, why, report, onlyIds = null }) {
  const [rows] = await pool.query(
    `SELECT d.id AS request_id, d.tenant_id, d.reason, t.name, t.slug
       FROM tenant_deletion_requests d
       JOIN tenants t ON t.id = d.tenant_id
      WHERE d.status = 'scheduled'`
  );
  for (const row of rows) {
    // Skip anything this same sweep only just scheduled (see `sweep`).
    if (onlyIds && !onlyIds.includes(Number(row.request_id))) continue;
    const [live] = await pool.query(
      `SELECT id, status FROM subscriptions
        WHERE tenant_id = ? AND status NOT IN ('cancelled','expired')`, [row.tenant_id]
    );
    if (live[0]) {
      // Refuse, and say why, rather than purging a company that is still paying.
      await pool.query(
        `UPDATE tenant_deletion_requests SET status = 'cancelled', cancelled_at = NOW()
          WHERE id = ? AND status = 'scheduled'`, [row.request_id]
      );
      await platformAudit.logPlatformAudit({
        tenantId: row.tenant_id, actor, action: 'data.deletion_cancelled', category: 'data',
        entityType: 'tenant_deletion_request', entityId: row.request_id,
        after: { status: 'cancelled' },
        reason: 'Purge refused: the company still holds a live subscription', req,
      });
      continue;
    }

    // Files first, and only because the DB rows are the *only* record of which
    // upload belongs to which tenant — uploads are stored flat under `uploads/`.
    // Collecting the paths before the rows go is what makes this possible at all.
    const files = await tenantUploadedFiles(row.tenant_id);

    // Recorded before the delete, while the tenant row and its name still exist.
    const tables = await tenantScopedTables();
    await platformAudit.logPlatformAudit({
      tenantId: row.tenant_id, actor, action: 'data.tenant_purged', category: 'data',
      entityType: 'tenant', entityId: row.tenant_id,
      before: { name: row.name, slug: row.slug },
      after: { status: 'deleted', tablesPurged: tables.length, uploadedFilesFound: files.length },
      reason: row.reason || why, req,
    });

    // Rows that could not be removed. A purge that deletes *some* of a company's
    // data and then reports "deleted" is worse than one that reports failure: the
    // customer believes their data is gone when part of it is still there.
    const failed = [];
    for (const table of tables) {
      const res = await pool.query(`DELETE FROM ${table} WHERE tenant_id = ?`, [row.tenant_id])
        .catch((e) => {
          report.errors.push({ step: 'purgeDeletedTenants', table, message: e.message });
          return null;
        });
      if (!res) failed.push(table);
    }

    const filesRemoved = removeUploadedFiles(files, report);

    if (failed.length) {
      // Leave the request `scheduled` so the next sweep retries the whole purge,
      // and surface it rather than declaring success.
      await platformAudit.logPlatformAudit({
        tenantId: row.tenant_id, actor, action: 'data.deletion_purge_failed', category: 'data',
        entityType: 'tenant_deletion_request', entityId: row.request_id,
        after: { failedTables: failed, filesRemoved },
        reason: 'Purge incomplete — will be retried on the next sweep', req,
      });
      report.errors.push({
        step: 'purgeDeletedTenants',
        tenantId: row.tenant_id,
        message: `purge incomplete; ${failed.length} table(s) failed: ${failed.join(', ')}`,
      });
      continue;
    }

    await pool.query(
      `UPDATE tenants SET status = 'deleted', plan = 'deleted' WHERE id = ?`, [row.tenant_id]
    );
    await pool.query(
      `UPDATE tenant_deletion_requests SET status = 'completed', completed_at = NOW() WHERE id = ?`,
      [row.request_id]
    );
    report.deletionsPurged.push({
      requestId: row.request_id, tenantId: row.tenant_id, name: row.name, filesRemoved,
    });
  }
  return report.deletionsPurged.length;
}

// ------------------------------------------------------------------- scheduler

let timer = null;

/**
 * Start the periodic sweep. Called once from `server.js`; guarded so a reload
 * (`node --watch`) does not leave a stray interval behind holding the DB pool
 * open and the process alive.
 */
function startScheduler({ intervalMs = 5 * 60_000, immediate = true } = {}) {
  if (timer) return timer;
  if (immediate) {
    sweep().then(
      (r) => logReport(r),
      (e) => console.error('[lifecycle] initial sweep failed:', e?.message || e)
    );
  }
  timer = setInterval(() => {
    sweep().then(logReport, (e) => console.error('[lifecycle] sweep failed:', e?.message || e));
  }, intervalMs);
  timer.unref?.();
  return timer;
}

function stopScheduler() {
  if (timer) { clearInterval(timer); timer = null; }
}

function logReport(report) {
  const total = report.trialsExpired.length + report.escalated.length + report.renewed.length
    + report.supportSessionsExpired.length + report.deletionCancellations.length
    + report.deletionsPurged.length + report.exportsRun.length;
  if (total === 0 && report.errors.length === 0) return;
  console.log(
    `[lifecycle] trials=${report.trialsExpired.length} escalated=${report.escalated.length} `
    + `renewed=${report.renewed.length} supportExpired=${report.supportSessionsExpired.length} `
    + `exports=${report.exportsRun.length} exportArtefactsRemoved=${report.exportArtefactsRemoved} `
    + `deletionScheduled=${report.deletionCancellations.length} purged=${report.deletionsPurged.length}`
  );
  for (const e of report.errors) console.error(`[lifecycle] ${e.step} failed:`, e.message);
}

module.exports = {
  sweep, expireTrials, escalateOverdue, renewPeriods, expireSupportAccess,
  runExports, cancelExpiredDeletions, purgeDeletedTenants, usageAlerts, startScheduler, stopScheduler,
  tenantScopedTables, SYSTEM_ACTOR,
};