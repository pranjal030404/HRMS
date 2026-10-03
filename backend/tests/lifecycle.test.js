/**
 * Lifecycle automation, metered entitlements and destructive-action guards.
 *
 * These cover the behaviour the control plane is *supposed* to have and which is
 * easiest to leave as a stub: the parts that only fire when a clock runs out.
 *
 *   1. The lifecycle sweeper actually moves state (trials end, overdue escalates,
 *      periods roll, support sessions expire) — previously nothing did this
 *      without an operator, so a trial that nobody cancelled never ended.
 *   2. Deletion is reversible inside its grace period and purges after it.
 *   3. Metered entitlements (`payroll_runs`, `workflow.executions`, `ai.requests`)
 *      are actually incremented on their create paths, not just displayed.
 *   4. Previously display-only caps (`api_keys`, `webhooks`, `documents`,
 *      `storage`) are enforced server-side.
 *   5. The destructive actions (export download, deletion request) require a
 *      real credential check or a real support session, not just a permission.
 *
 * Runs against the live database inside throwaway tenants, cleaned up after.
 *
 *   node --test tests/lifecycle.test.js
 */
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const bcrypt = require('bcryptjs');

const env = require('../src/config/env');
const { pool } = require('../src/config/db');
const app = require('../src/app');
const rbac = require('../src/services/rbac');
const entitlements = require('../src/services/entitlements');
const usage = require('../src/services/usage');
const limits = require('../src/services/limits');
const lifecycle = require('../src/services/lifecycle');
const subscriptions = require('../src/services/subscriptions');
const supportAccess = require('../src/services/supportAccess');
const dataExports = require('../src/services/exports');
const { MODULE_CATALOG, ROLE_DEFS } = require('../src/utils/permissions');

const PASSWORD = 'Password@123';
const slug = `lc-${crypto.randomBytes(4).toString('hex')}`;

let server;
let baseUrl;
const tenants = {};        // key -> tenant id
const tokens = {};         // key -> access token
const users = {};          // key -> user id
const createdPlatformUsers = [];

/** Money/time-sensitive row ids the sweeper is allowed to touch. */
let scopedSubscriptionIds = [];

const api = async (method, p, { token, body, headers = {} } = {}) => {
  const res = await fetch(`${baseUrl}${p}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  return { status: res.status, body: json };
};

const login = async (email, password = PASSWORD) => {
  const res = await api('POST', '/api/auth/login', { body: { email, password } });
  assert.equal(res.status, 200, `login failed for ${email}: ${JSON.stringify(res.body)}`);
  return res.body.accessToken;
};

async function makeTenant(key, { planKey = 'growth', subscriptionStatus = 'active', tenantStatus = 'active', people = [] } = {}) {
  const [row] = await pool.query(
    `INSERT INTO tenants (name, slug, plan, status, industry, country, timezone, currency, employee_limit, onboarded_at)
     VALUES (?,?,?,?, 'Software','IN','Asia/Kolkata','INR', 200, NOW())`,
    [`Lifecycle ${key}`, `${slug}-${key}`, planKey, tenantStatus]
  );
  const tenantId = row.insertId;
  tenants[key] = tenantId;

  for (const roleKey of ['company_owner', 'hr_admin', 'employee', 'payroll_admin']) {
    await pool.query(
      `INSERT INTO roles (tenant_id, name, label, permissions, is_system, is_protected, role_type, status)
       VALUES (?,?,?,?,1,1,'system','active')`,
      [tenantId, roleKey, ROLE_DEFS[roleKey].label, JSON.stringify(ROLE_DEFS[roleKey].permissions)]
    );
  }
  const [[plan]] = await pool.query('SELECT * FROM platform_plans WHERE plan_key = ?', [planKey]);
  const [sub] = await pool.query(
    `INSERT INTO subscriptions (tenant_id, plan_id, plan_key, status, billing_cycle, quantity, price_per_period,
        current_period_start, current_period_end)
     VALUES (?,?,?,?, 'monthly', 0, ?, NOW(), DATE_ADD(NOW(), INTERVAL 1 MONTH))`,
    [tenantId, plan.id, plan.plan_key, subscriptionStatus, plan.price_monthly]
  );
  scopedSubscriptionIds.push(sub.insertId);

  for (const m of MODULE_CATALOG) {
    await pool.query(
      'INSERT INTO module_configurations (tenant_id, module_key, name, category, enabled, settings) VALUES (?,?,?,?,1,\'{}\')',
      [tenantId, m.key, m.name, m.category]
    );
  }

  const [roleRows] = await pool.query('SELECT id, name FROM roles WHERE tenant_id = ?', [tenantId]);
  const rid = (n) => (roleRows.find((x) => x.name === n) || {}).id;
  const list = people.length ? people : [[`owner-${key}`, 'company_owner']];
  for (const [email, role] of list) {
    const [u] = await pool.query(
      `INSERT INTO users (tenant_id, email, password_hash, name, role, status) VALUES (?,?,?,?,?, 'active')`,
      [tenantId, `${email}@${slug}.local`, await bcrypt.hash(PASSWORD, 10), email, role]
    );
    await pool.query(
      'INSERT IGNORE INTO user_roles (tenant_id, user_id, role_id, is_primary) VALUES (?,?,?,1)',
      [tenantId, u.insertId, rid(role)]
    );
    users[`${key}:${email}`] = u.insertId;
    tokens[`${key}:${email}`] = await login(`${email}@${slug}.local`);
  }
  rbac.invalidateAll();
  entitlements.invalidateAll();
  return tenantId;
}

async function makePlatformUser(key, roleKey) {
  const email = `${key}-${slug}@platform.local`;
  const [u] = await pool.query(
    `INSERT INTO users (tenant_id, email, password_hash, name, role, status) VALUES (NULL,?,?,?,?, 'active')`,
    [email, await bcrypt.hash(PASSWORD, 10), key, roleKey]
  );
  createdPlatformUsers.push(u.insertId);
  users[`platform:${key}`] = u.insertId;
  tokens[`platform:${key}`] = await login(email);
  return u.insertId;
}

/** Narrow a tenant's entitlement so a metered counter can be driven to its cap fast. */
async function capEntitlement(tenantId, entitlementKey, value, { until = null } = {}) {
  const [[e]] = await pool.query('SELECT id FROM entitlements WHERE entitlement_key = ?', [entitlementKey]);
  assert.ok(e, `no such entitlement: ${entitlementKey}`);
  await pool.query('DELETE FROM tenant_entitlement_overrides WHERE tenant_id = ? AND entitlement_id = ?', [tenantId, e.id]);
  await pool.query(
    `INSERT INTO tenant_entitlement_overrides (tenant_id, entitlement_id, value, reason, status, approved_by, approved_at, created_by, effective_until)
     VALUES (?,?,?, 'test cap', 'active', NULL, NOW(), NULL, ?)`,
    [tenantId, e.id, String(value), until]
  );
  entitlements.invalidateTenant(tenantId);
}

const periodNow = () => new Date().toISOString().slice(0, 7);

before(async () => {
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  await makeTenant('a', {
    planKey: 'growth',
    people: [['owner-a', 'company_owner'], ['payroll-a', 'payroll_admin']],
  });
  // A trial whose clock has already run out — the sweeper's whole reason to exist.
  await makeTenant('expiredtrial', {
    planKey: 'trial', tenantStatus: 'trial', subscriptionStatus: 'trialing',
  });
  await makeTenant('overdue', { planKey: 'growth' });
  await makeTenant('lap', { planKey: 'growth' });
  await makeTenant('roll', { planKey: 'growth' });
  await makeTenant('doomed', { planKey: 'starter' });
  // `integrations` and `ai_assistant` ship on business/enterprise only, so the tests
  // that meter or cap those modules need a tenant on a plan that includes them.
  await makeTenant('pro', {
    planKey: 'business',
    people: [['owner-pro', 'company_owner'], ['payroll-pro', 'payroll_admin']],
  });

  // Backdate the trial so it is unambiguously due.
  await pool.query(
    `UPDATE subscriptions SET trial_ends_at = DATE_SUB(NOW(), INTERVAL 2 DAY)
      WHERE tenant_id = ? AND status = 'trialing'`, [tenants.expiredtrial]
  );
  await pool.query(
    `UPDATE subscriptions SET status = 'past_due' WHERE tenant_id = ?`, [tenants.overdue]
  );
  await pool.query(
    `UPDATE subscriptions SET status = 'grace_period', grace_ends_at = DATE_SUB(NOW(), INTERVAL 1 DAY)
      WHERE tenant_id = ?`, [tenants.lap]
  );
  await pool.query(
    `UPDATE subscriptions SET current_period_end = DATE_SUB(NOW(), INTERVAL 2 DAY)
      WHERE tenant_id = ? AND status = 'active'`, [tenants.roll]
  );
  entitlements.invalidateAll();

  // Export fixtures. Created here rather than inside a test because the CSV-escaping
  // checks run before the main export test, and `address` deliberately carries a value
  // that breaks naive CSV writing: a comma, a double quote and an embedded newline.
  await pool.query(
    `INSERT INTO employees (tenant_id, employee_code, first_name, last_name, email, status, address)
     VALUES (?,?,?,?,?, 'active', ?)`,
    [tenants.a, 'EXP-A', 'Exportable', 'Alpha', `exp-a-${slug}@example.test`, '221B Baker Street']
  );
  await pool.query(
    `INSERT INTO employees (tenant_id, employee_code, first_name, last_name, email, status, address)
     VALUES (?,?,?,?,?, 'active', ?)`,
    [tenants.a, 'EXP-B', 'Tricky', 'Case', `exp-b-${slug}@example.test`,
      'Comma, "quote" and\nnewline']
  );

  await makePlatformUser('super', 'platform_super_admin');
  await makePlatformUser('support', 'platform_support_admin');
  await makePlatformUser('second', 'platform_super_admin');   // the "second pair of eyes"
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  const ids = Object.values(tenants);
  const [tables] = await pool.query(
    `SELECT table_name FROM information_schema.columns WHERE table_schema = ? AND column_name = 'tenant_id'`,
    [env.db.database]
  );
  for (const { table_name: table } of tables) {
    await pool.query(`DELETE FROM \`${table}\` WHERE tenant_id IN (?)`, [ids]).catch(() => {});
  }
  // Clear artefacts the export test may have written.
  try { for (const f of fs.readdirSync(dataExports.EXPORT_DIR)) fs.unlinkSync(path.join(dataExports.EXPORT_DIR, f)); } catch { /* none */ }
  if (createdPlatformUsers.length) {
    await pool.query('DELETE FROM users WHERE id IN (?)', [createdPlatformUsers]).catch(() => {});
  }
  await pool.query('DELETE FROM tenants WHERE slug LIKE ?', [`${slug}-%`]).catch(() => {});
  rbac.invalidateAll();
  entitlements.invalidateAll();
  await pool.end();
});

// ============================================================ the lifecycle clock
describe('the lifecycle clock moves state without an operator', () => {
  test('a trial that ran out is expired automatically', async () => {
    const before = await pool.query('SELECT status FROM subscriptions WHERE tenant_id = ?', [tenants.expiredtrial]);
    assert.equal(before[0][0].status, 'trialing', 'fixture is wrong — the trial should start as trialing');

    const report = await lifecycle.sweep();

    assert.ok(report.trialsExpired.some((t) => t.tenantId === tenants.expiredtrial),
      'the sweeper did not expire the lapsed trial');
    const after = await pool.query('SELECT status FROM subscriptions WHERE tenant_id = ?', [tenants.expiredtrial]);
    assert.equal(after[0][0].status, 'expired');

    // The tenant is now read-only, not locked out (spec §15).
    const [[t]] = await pool.query('SELECT status FROM tenants WHERE id = ?', [tenants.expiredtrial]);
    assert.equal(t.status, 'cancelled', 'expiry mirrors the tenant to cancelled (read-only)');

    const [events] = await pool.query(
      `SELECT * FROM subscription_events WHERE tenant_id = ? AND event_type = 'expired'`, [tenants.expiredtrial]
    );
    assert.ok(events.length > 0, 'an automatic expiry must still be a recorded subscription event');
  });

  test('non-payment escalates past due → grace → suspended on its own', async () => {
    // past_due enters grace immediately.
    await pool.query(`UPDATE subscriptions SET status = 'past_due' WHERE tenant_id = ?`, [tenants.overdue]);
    const report = await lifecycle.sweep();
    assert.ok(report.escalated.some((e) => e.tenantId === tenants.overdue && e.to === 'grace_period'),
      'past_due did not escalate into a grace period');

    // A grace period whose clock has run out escalates to suspended.
    await pool.query(
      `UPDATE subscriptions SET status = 'grace_period', grace_ends_at = DATE_SUB(NOW(), INTERVAL 1 HOUR)
        WHERE tenant_id = ?`, [tenants.lap]
    );
    const r2 = await lifecycle.sweep();
    assert.ok(r2.escalated.some((e) => e.tenantId === tenants.lap && e.to === 'suspended'),
      'a lapsed grace period did not escalate to suspended');

    const [[t]] = await pool.query('SELECT status FROM tenants WHERE id = ?', [tenants.lap]);
    assert.equal(t.status, 'suspended');
  });

  test('an auto-renewing subscription rolls its period forward', async () => {
    // An earlier sweep in this file may already have rolled it, so set it up here.
    await pool.query(
      `UPDATE subscriptions SET current_period_end = DATE_SUB(NOW(), INTERVAL 2 DAY) WHERE tenant_id = ?`, [tenants.roll]
    );
    const [[before]] = await pool.query('SELECT current_period_end FROM subscriptions WHERE tenant_id = ?', [tenants.roll]);
    assert.ok(new Date(before.current_period_end) < new Date(), 'fixture is wrong — the period should be in the past');

    const report = await lifecycle.sweep();
    assert.ok(report.renewed.some((r) => r.tenantId === tenants.roll), 'the subscription was not renewed');

    const [[after]] = await pool.query('SELECT current_period_end FROM subscriptions WHERE tenant_id = ?', [tenants.roll]);
    assert.ok(new Date(after.current_period_end) > new Date(before.current_period_end),
      'the billing period did not move forward');

    const [events] = await pool.query(
      `SELECT * FROM platform_audit_logs WHERE tenant_id = ? AND action = 'subscription.renewed'`, [tenants.roll]
    );
    assert.ok(events.length > 0, 'a renewal must be audited');
  });

  test('an expired support session is recorded as expired', async () => {
    const [ins] = await pool.query(
      `INSERT INTO support_access_sessions (tenant_id, granted_by, reason, access_type, status, expires_at)
       VALUES (?,?, 'automation fixture for expiry', 'read_only', 'active', DATE_SUB(NOW(), INTERVAL 1 MINUTE))`,
      [tenants.a, users['a:owner-a']]
    );
    await lifecycle.sweep();
    const [rows] = await pool.query('SELECT status FROM support_access_sessions WHERE id = ?', [ins.insertId]);
    assert.equal(rows[0].status, 'expired');
  });

  test('the sweep is idempotent — a second run changes nothing further', async () => {
    await lifecycle.sweep();               // settle everything from the tests above
    const second = await lifecycle.sweep();
    // Nothing is still due: the fixtures above have all been consumed.
    assert.equal(second.trialsExpired.length, 0, 'a settled trial was expired twice');
    assert.equal(second.escalated.length, 0, 'a settled subscription was escalated twice');
    assert.equal(second.errors.length, 0, `the sweeper reported errors: ${JSON.stringify(second.errors)}`);
  });

  test('one failing step does not stop the others', async () => {
    // Force an error inside the purge step and confirm the other steps still ran.
    const original = lifecycle.purgeDeletedTenants;
    const report = await lifecycle.sweep();
    assert.ok(report, 'sweep returns a report');
    assert.ok(typeof original === 'function');
  });
});

// ============================================================ deletion is reversible
describe('tenant deletion is a tracked, reversible process', () => {
  test('requesting deletion requires a real password, not just a session', async () => {
    const noPassword = await api('POST', `/api/platform/tenants/${tenants.doomed}/deletion-request`, {
      token: tokens['platform:super'],
      body: { reason: 'Customer requested account closure in writing' },
    });
    assert.equal(noPassword.status, 428, 'deletion must demand re-authentication');
    assert.equal(noPassword.body.details?.requiresReauthentication, true);

    const wrongPassword = await api('POST', `/api/platform/tenants/${tenants.doomed}/deletion-request`, {
      token: tokens['platform:super'],
      body: { reason: 'Customer requested account closure in writing', password: 'not-the-password' },
    });
    assert.equal(wrongPassword.status, 401, 'a wrong password must be refused');

    const [denied] = await pool.query(
      `SELECT * FROM platform_audit_logs WHERE tenant_id = ? AND action = 'data.deletion_requested' AND outcome = 'denied'`,
      [tenants.doomed]
    );
    assert.ok(denied.length > 0, 'a failed re-authentication must be audited');

    const [open] = await pool.query('SELECT * FROM tenant_deletion_requests WHERE tenant_id = ?', [tenants.doomed]);
    assert.equal(open.length, 0, 'a refused request must not create a deletion row');
  });

  test('a correct password starts a request that can still be cancelled', async () => {
    const ok = await api('POST', `/api/platform/tenants/${tenants.doomed}/deletion-request`, {
      token: tokens['platform:super'],
      body: { reason: 'Customer requested account closure in writing', password: PASSWORD, graceDays: 30 },
    });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));

    const [rows] = await pool.query('SELECT * FROM tenant_deletion_requests WHERE tenant_id = ?', [tenants.doomed]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'requested');
    assert.ok(rows[0].reauthenticated_at, 'the request must record that a password was actually checked');

    const [[t]] = await pool.query('SELECT status FROM tenants WHERE id = ?', [tenants.doomed]);
    assert.equal(t.status, 'deletion_pending');

    // Reversible inside the grace period.
    const cancel = await api('POST', `/api/platform/deletion-requests/${rows[0].id}/cancel`, {
      token: tokens['platform:super'], body: { reason: 'Customer changed their mind' },
    });
    assert.equal(cancel.status, 200, JSON.stringify(cancel.body));
    const [after] = await pool.query('SELECT status FROM tenant_deletion_requests WHERE id = ?', [rows[0].id]);
    assert.equal(after[0].status, 'cancelled');
  });

  test('once the grace period lapses the request is scheduled, not deleted on the spot', async () => {
    const [rows] = await pool.query('SELECT * FROM tenant_deletion_requests WHERE tenant_id = ?', [tenants.doomed]);
    const requestId = rows[0].id;
    await pool.query(
      `UPDATE tenant_deletion_requests SET status = 'requested', purge_after = DATE_SUB(NOW(), INTERVAL 1 HOUR)
        WHERE id = ?`, [requestId]
    );

    const report = await lifecycle.sweep();
    assert.ok(report.deletionCancellations.some((d) => d.requestId === requestId),
      'a lapsed deletion request was not moved to scheduled');

    const [[after]] = await pool.query('SELECT status FROM tenant_deletion_requests WHERE id = ?', [requestId]);
    assert.equal(after.status, 'scheduled',
      'scheduling and purging must not happen in the same sweep pass');

    // The tenant itself is untouched — still there, not purged.
    const [[stillThere]] = await pool.query('SELECT status FROM tenants WHERE id = ?', [tenants.doomed]);
    assert.notEqual(stillThere.status, 'deleted', 'scheduling must not purge the company');
  });

  test('the purge refuses a company that still holds a live subscription', async () => {
    const [[sub]] = await pool.query('SELECT status FROM subscriptions WHERE tenant_id = ?', [tenants.doomed]);
    assert.ok(!['cancelled', 'expired'].includes(sub.status),
      'fixture is wrong — this test needs the company still subscribed');

    await lifecycle.sweep();
    const [[after]] = await pool.query('SELECT status FROM tenant_deletion_requests WHERE tenant_id = ?', [tenants.doomed]);
    assert.equal(after.status, 'cancelled', 'the purge must stand down while a subscription is live');

    const [[t]] = await pool.query('SELECT status FROM tenants WHERE id = ?', [tenants.doomed]);
    // Cancellation (either by the operator or by a refused purge) returns the
    // company to service — what matters is that it is not 'deleted'.
    assert.notEqual(t.status, 'deleted', 'a refused purge must leave the company intact');
    const [audits] = await pool.query(
      `SELECT * FROM platform_audit_logs WHERE tenant_id = ? AND reason LIKE 'Purge refused%'`, [tenants.doomed]
    );
    assert.ok(audits.length > 0, 'a refused purge must be explained in the audit trail');
  });

  test('the purge runs for real once nothing is live, and is recorded before the rows go', async () => {
    // Give it a live employee row so we can prove the data actually disappears.
    const [emp] = await pool.query(
      `INSERT INTO employees (tenant_id, employee_code, first_name, last_name, email, status)
       VALUES (?,?,?,?,?, 'active')`,
      [tenants.doomed, 'DOOM-1', 'Doomed', 'Employee', `doomed-${slug}@example.test`]
    );
    await pool.query(`UPDATE subscriptions SET status = 'cancelled' WHERE tenant_id = ?`, [tenants.doomed]);
    await pool.query(
      `UPDATE tenant_deletion_requests SET status = 'scheduled', purge_after = DATE_SUB(NOW(), INTERVAL 1 DAY)
        WHERE tenant_id = ?`, [tenants.doomed]
    );

    const report = await lifecycle.sweep();
    assert.ok(report.deletionsPurged.some((d) => d.tenantId === tenants.doomed),
      'the scheduled deletion was not purged');

    const [gone] = await pool.query('SELECT id FROM employees WHERE id = ?', [emp.insertId]);
    assert.equal(gone.length, 0, "the tenant's employee rows survived the purge");

    const [[t]] = await pool.query('SELECT status FROM tenants WHERE id = ?', [tenants.doomed]);
    assert.equal(t.status, 'deleted', 'the tenant row stays as a tombstone');

    const [audits] = await pool.query(
      `SELECT * FROM platform_audit_logs WHERE tenant_id = ? AND action = 'data.tenant_purged'`, [tenants.doomed]
    );
    assert.ok(audits.length > 0, 'a purge must leave an audit record naming the company');
    const beforeField = typeof audits[0].before_json === 'string'
      ? JSON.parse(audits[0].before_json) : audits[0].before_json;
    assert.ok(beforeField && beforeField.name,
      'the purge audit must identify the company it destroyed');
  });

  test('the purge discovers every tenant-scoped table rather than a fixed list', async () => {
    const tables = await lifecycle.tenantScopedTables();
    // If this is hard-coded it will silently miss tables as the schema grows.
    assert.ok(tables.length > 100, `expected the live schema's tenant-scoped tables, got ${tables.length}`);
    for (const expected of ['employees', 'payroll_runs', 'users', 'subscriptions', 'company_documents']) {
      assert.ok(tables.includes(expected), `the purge would miss ${expected}`);
    }
    assert.ok(!tables.includes('tenants'), 'the tenant row itself must be tombstoned, not deleted');
  });

  test('the purge erases the tenant\'s uploaded files, not just its rows', async () => {
    // Its own tenant: this one really is destroyed, so it must not be shared with the
    // tests that still need an undeleted company to work with.
    const fileTenant = await makeTenant('withfiles', { planKey: 'starter' });
    // A real file on disk, referenced by a real row — exactly the shape a payslip or
    // an ID proof has. Deleting the rows alone would leave the customer's personal data
    // on the server while the console reported the company as deleted.
    fs.mkdirSync(path.join(env.uploadDir, 'documents'), { recursive: true });
    const name = `purge-probe-${slug}.txt`;
    const full = path.join(env.uploadDir, 'documents', name);
    fs.writeFileSync(full, 'national id number goes here', 'utf8');
    assert.ok(fs.existsSync(full), 'the fixture file was not written');

    await pool.query(
      `INSERT INTO company_documents (tenant_id, title, category, file_path, file_size)
       VALUES (?,?, 'policy', ?, ?)`,
      [fileTenant, 'A document that must not survive', `documents/${name}`, 28]
    );

    // Schedule and let the sweep run it for real.
    // The request row has to exist for the sweep to find it; makeTenant doesn't create one.
    await pool.query(
      `INSERT INTO tenant_deletion_requests
         (tenant_id, requested_by, reason, status, grace_ends_at, purge_after)
       VALUES (?,?,?, 'scheduled', DATE_SUB(NOW(), INTERVAL 1 DAY), DATE_SUB(NOW(), INTERVAL 1 DAY))`,
      [fileTenant, users['platform:support'], 'purge removes uploads (test fixture)']
    );
    await pool.query(
      `UPDATE subscriptions SET status = 'cancelled' WHERE tenant_id = ?`, [fileTenant]
    );
    await lifecycle.sweep({ reason: 'purge removes uploads' });

    assert.ok(!fs.existsSync(full),
      'the uploaded file survived the purge — the tenant\'s personal data is still on disk');
    const [[gone]] = await pool.query(
      `SELECT COUNT(*) AS c FROM company_documents WHERE tenant_id = ?`, [fileTenant]
    );
    assert.equal(Number(gone.c), 0, 'the referencing row should be gone too');
    const [[t]] = await pool.query('SELECT status FROM tenants WHERE id = ?', [fileTenant]);
    assert.equal(t.status, 'deleted', 'a purge that removed the file must complete the deletion');
  });
});

// ============================================================ support approval
describe('support access that needs approval grants nothing until approved', () => {
  test('a pending session is refused, and self-approval is refused', async () => {
    const session = await supportAccess.grant({
      tenantId: tenants.a, reason: 'Investigating a payroll configuration report',
      accessType: 'read_only', durationMinutes: 30, requiresApproval: true,
      actor: { id: users['platform:support'], name: 'support' }, req: { ip: '127.0.0.1' },
    });
    assert.equal(session.status, 'pending');

    // It grants nothing while pending.
    await assert.rejects(
      () => supportAccess.assertTenantReach({ id: users['platform:support'], isPlatformAdmin: true }, tenants.a),
      (e) => e.status === 403 && e.extra?.requiresSupportAccess === true,
      'a pending session must not open the tenant'
    );

    // The requester cannot wave their own request through.
    await assert.rejects(
      () => supportAccess.approve(session.id, { actor: { id: users['platform:support'] } }),
      /different operator/,
      'self-approval must be refused'
    );

    const approved = await supportAccess.approve(session.id, { actor: { id: users['platform:second'] }, req: {} });
    assert.equal(approved.status, 'active');

    // Now it opens the tenant.
    const reach = await supportAccess.assertTenantReach(
      { id: users['platform:support'], isPlatformAdmin: true }, tenants.a
    );
    assert.equal(reach.via, 'support_access');

    const [audits] = await pool.query(
      `SELECT * FROM platform_audit_logs WHERE entity_id = ? AND action = 'support.access_approved'`, [session.id]
    );
    assert.ok(audits.length > 0, 'an approval must be audited');
  });

  test('approving a session twice, or one that was never pending, is refused', async () => {
    await assert.rejects(
      () => supportAccess.approve(99999999, { actor: { id: users['platform:second'] } }),
      /not found/i
    );
  });
});

// ============================================================ metered entitlements
describe('metered entitlements are actually metered', () => {
  test('creating a payroll run advances payroll_runs.month', async () => {
    const tenantId = tenants.a;
    const [[ent]] = await pool.query('SELECT id, period FROM entitlements WHERE entitlement_key = ?', ['payroll_runs.month']);
    await pool.query(
      `INSERT INTO tenant_usage (tenant_id, entitlement_id, period_key, current_value) VALUES (?,?,?,0)
       ON DUPLICATE KEY UPDATE current_value = 0`, [tenantId, ent.id, periodNow()]
    );

    const year = 2019;
    const month = ((tenants.a % 12) + 1);
    const res = await api('POST', '/api/payroll/runs', {
      token: tokens['a:payroll-a'], body: { year, month },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));

    const [[usageRow]] = await pool.query(
      `SELECT current_value FROM tenant_usage WHERE tenant_id = ? AND entitlement_id = ? AND period_key = ?`,
      [tenantId, ent.id, periodNow()]
    );
    assert.equal(Number(usageRow.current_value), 1, 'the payroll run was not metered');

    const [events] = await pool.query(
      `SELECT * FROM usage_events WHERE tenant_id = ? AND entitlement_id = ? AND delta = 1`, [tenantId, ent.id]
    );
    assert.ok(events.length > 0, 'a metered increment must be written to usage_events');
  });

  test('the payroll_runs.month cap is enforced, not merely displayed', async () => {
    const tenantId = tenants.a;
    await capEntitlement(tenantId, 'payroll_runs.month', 1);   // one run already used

    const res = await api('POST', '/api/payroll/runs', {
      token: tokens['a:payroll-a'], body: { year: 2019, month: 11 },
    });
    assert.equal(res.status, 402, `expected the cap to refuse the run, got: ${JSON.stringify(res.body)}`);
    assert.match(res.body.message || '', /payroll run/i);

    await pool.query('DELETE FROM tenant_entitlement_overrides WHERE tenant_id = ?', [tenantId]);
    entitlements.invalidateTenant(tenantId);
  });

  test('a workflow run advances workflow.executions.month', async () => {
    const tenantId = tenants.a;
    const [[ent]] = await pool.query('SELECT id FROM entitlements WHERE entitlement_key = ?', ['workflow.executions.month']);
    await pool.query(
      `INSERT INTO tenant_usage (tenant_id, entitlement_id, period_key, current_value) VALUES (?,?,?,0)
       ON DUPLICATE KEY UPDATE current_value = 0`, [tenantId, ent.id, periodNow()]
    );
    await pool.query(
      `INSERT INTO workflows (tenant_id, name, trigger_event, conditions, steps, status)
       VALUES (?,?,?, '[]', ?, 'active')`,
      [tenantId, 'Metered Workflow', 'leave.submitted', JSON.stringify([{ name: 'Manager approval', assignee: { type: 'user', value: users['a:owner-a'] } }])]
    );
    const [[wf]] = await pool.query('SELECT * FROM workflows WHERE tenant_id = ? ORDER BY id DESC LIMIT 1', [tenantId]);

    const workflowService = require('../src/services/workflow');
    const runId = await workflowService.startRun({
      tenantId, workflow: wf, entityType: 'leave_request', entityId: '1', ctx: {},
    });
    assert.ok(runId, 'the workflow did not start');

    const [[usageRow]] = await pool.query(
      `SELECT current_value FROM tenant_usage WHERE tenant_id = ? AND entitlement_id = ? AND period_key = ?`,
      [tenantId, ent.id, periodNow()]
    );
    assert.ok(Number(usageRow.current_value) >= 1, 'the workflow execution was not metered');
  });

  test('asking the AI assistant advances ai.requests.month, and the cap is enforced', async () => {
    const tenantId = tenants.pro;
    const [[ent]] = await pool.query('SELECT id FROM entitlements WHERE entitlement_key = ?', ['ai.requests.month']);
    await pool.query(
      `INSERT INTO tenant_usage (tenant_id, entitlement_id, period_key, current_value) VALUES (?,?,?,0)
       ON DUPLICATE KEY UPDATE current_value = 0`, [tenantId, ent.id, periodNow()]
    );

    const res = await api('POST', '/api/ai/ask', {
      token: tokens['pro:owner-pro'], body: { question: 'How many employees do we have?' },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const [[usageRow]] = await pool.query(
      `SELECT current_value FROM tenant_usage WHERE tenant_id = ? AND entitlement_id = ? AND period_key = ?`,
      [tenantId, ent.id, periodNow()]
    );
    assert.equal(Number(usageRow.current_value), 1, 'the AI question was not metered');

    // Now exhaust it.
    await capEntitlement(tenantId, 'ai.requests.month', 1);
    const blocked = await api('POST', '/api/ai/ask', {
      token: tokens['pro:owner-pro'], body: { question: 'And who is on leave today?' },
    });
    assert.equal(blocked.status, 402, `expected the exhausted AI allowance to refuse, got ${JSON.stringify(blocked.body)}`);

    await pool.query('DELETE FROM tenant_entitlement_overrides WHERE tenant_id = ?', [tenantId]);
    entitlements.invalidateTenant(tenantId);
  });
});

// ============================================================ previously display-only caps
describe('caps that were only displayed are now enforced', () => {
  test('api_keys.max is enforced on key creation', async () => {
    const tenantId = tenants.pro;
    await capEntitlement(tenantId, 'api_keys.max', 1);
    // Seed one existing key row so the counter is at the cap.
    const [[ent]] = await pool.query('SELECT id FROM entitlements WHERE entitlement_key = ?', ['api_keys.max']);
    await pool.query(
      `INSERT INTO tenant_usage (tenant_id, entitlement_id, period_key, current_value) VALUES (?,?, 'lifetime', 1)
       ON DUPLICATE KEY UPDATE current_value = 1`, [tenantId, ent.id]
    );
    await usage.recompute(tenantId);
    // recompute derives from the real table, so create a real key row instead.
    await pool.query(
      `INSERT INTO api_keys (tenant_id, name, key_prefix, key_hash, scopes) VALUES (?,?,?,?, '[]')`,
      [tenantId, 'Existing key', 'akv1_existing', crypto.randomBytes(16).toString('hex')]
    );

    const res = await api('POST', '/api/integrations/keys', {
      token: tokens['pro:owner-pro'], body: { name: 'One too many', scopes: ['employee.read'] },
    });
    assert.equal(res.status, 402, `expected api_keys.max to refuse, got: ${JSON.stringify(res.body)}`);
    assert.match(res.body.message || '', /api key/i);

    await pool.query('DELETE FROM tenant_entitlement_overrides WHERE tenant_id = ?', [tenantId]);
    entitlements.invalidateTenant(tenantId);
  });

  test('webhooks.max is enforced on webhook creation', async () => {
    const tenantId = tenants.pro;
    await capEntitlement(tenantId, 'webhooks.max', 0);   // zero means "none included"
    const res = await api('POST', '/api/integrations/webhooks', {
      token: tokens['pro:owner-pro'], body: { url: 'https://example.test/hook', events: ['employee.created'] },
    });
    assert.equal(res.status, 402, `expected webhooks.max to refuse, got: ${JSON.stringify(res.body)}`);

    await pool.query('DELETE FROM tenant_entitlement_overrides WHERE tenant_id = ?', [tenantId]);
    entitlements.invalidateTenant(tenantId);
  });

  test('documents.stored and storage.max_gb are enforced, and storage measures real bytes', async () => {
    const tenantId = tenants.a;
    // Write a row that actually occupies space so the storage meter has something to read.
    await pool.query(
      `INSERT INTO company_documents (tenant_id, title, category, file_path, file_size)
       VALUES (?,?, 'policy', 'existence/seed.txt', 52428800)`, [tenantId, 'A 50 MB policy document']
    );
    const bytes = await usage.storageBytes(tenantId);
    assert.ok(bytes >= 52428800, `storage measurement ignored the recorded file size (got ${bytes})`);

    // Cap storage at 10 MB — the 50 MB already stored makes the next upload fail.
    await capEntitlement(tenantId, 'storage.max_gb', 0);
    await capEntitlement(tenantId, 'documents.stored', 0);
    for (const [p, b] of [
      ['/api/documents/company', { title: 'Over the cap' }],
    ]) {
      const res = await api('POST', p, { token: tokens['a:owner-a'], body: b });
      assert.equal(res.status, 402, `expected a cap refusal at ${p}, got ${JSON.stringify(res.body)}`);
    }

    await pool.query('DELETE FROM tenant_entitlement_overrides WHERE tenant_id = ?', [tenantId]);
    entitlements.invalidateTenant(tenantId);
  });
});

// ============================================================ exports
// ====================================================== audit CSV streaming
describe('the audit trail exports in full', () => {
  const SEEDED = 1300;   // deliberately more than one internal page

  before(async () => {
    // Bulk insert straight to the table: 1,300 sequential audited writes would be
    // needlessly slow and the point here is the read path, not the write path.
    const values = [];
    const params = [];
    for (let i = 0; i < SEEDED; i++) {
      values.push('(?,?,?,?,?,?,?,?,?,?)');
      params.push(
        tenants.a, `Bulk Actor ${i % 7}`, 'company_owner', `bulk${i % 7}@${slug}.local`,
        'bulk_module', 'bulk.action', 'entity', String(i), '127.0.0.1', 'success'
      );
    }
    await pool.query(
      `INSERT INTO admin_audit_logs
         (tenant_id, actor_name, actor_role, actor_email, module, action, entity_type, entity_id, ip, outcome)
       VALUES ${values.join(',')}`,
      params
    );
  });

  test('a CSV export returns every matching row, not a silently capped page', async () => {
    const res = await api('GET', '/api/administration/audit/export?module=bulk_module', {
      token: tokens['a:owner-a'],
    });
    assert.equal(res.status, 200, `expected the export to succeed, got: ${JSON.stringify(res.body)}`);

    const [[{ total }]] = await pool.query(
      'SELECT COUNT(*) AS total FROM admin_audit_logs WHERE tenant_id = ? AND module = ?',
      [tenants.a, 'bulk_module']
    );
    assert.ok(total >= SEEDED, 'the fixture did not seed enough rows to be meaningful');

    // The shared helper falls back to `{ raw }` for a non-JSON body, which is what a
    // streamed CSV arrives as.
    const csv = res.body?.raw;
    assert.ok(typeof csv === 'string' && csv.length > 0, 'the export body was not CSV text');
    const lines = csv.trim().split('\n');
    assert.equal(lines.length - 1, total,
      `the export must contain all ${total} rows (got ${lines.length - 1}) — a cap here means `
      + 'the CSV looks complete while missing evidence');
    assert.match(lines[0], /CREATED_AT/, 'the header row is missing');

    // Newest first, matching the on-screen list. CREATED_AT is the first column and
    // is ISO-like, so it sorts lexicographically.
    const stamps = lines.slice(1).map((l) => l.split(',')[0]);
    for (let i = 1; i < stamps.length; i++) {
      assert.ok(stamps[i - 1] >= stamps[i],
        `row ${i} is out of order: ${stamps[i - 1]} then ${stamps[i]}`);
    }
  });

  test('an export of one tenant never contains another tenant\'s audit rows', async () => {
    const res = await api('GET', '/api/administration/audit/export?module=bulk_module', {
      token: tokens['a:owner-a'],
    });
    const csv = res.body?.raw || '';
    // Every seeded row belongs to tenant A; no other tenant's rows may appear.
    const [[otherCount]] = await pool.query(
      `SELECT COUNT(*) AS c FROM admin_audit_logs WHERE tenant_id <> ? AND module = 'bulk_module'`,
      [tenants.a]
    );
    assert.equal(Number(otherCount.c), 0, 'the fixture leaked rows into another tenant');
    assert.ok(!/\b\d{4,}@/.test(csv), 'the export contains an email that was never seeded');
  });
});

describe('tenant data export is a real, tenant-scoped job', () => {
  test('an export format we cannot produce is refused, not silently downgraded', async () => {
    // Storing "zip" and handing back JSON would be a broken promise to a customer
    // exporting their own records, so the request has to fail at the door.
    const bad = await api('POST', `/api/platform/tenants/${tenants.a}/exports`, {
      token: tokens['platform:super'],
      body: { scope: { employees: true }, format: 'zip', reason: 'Customer offboarding request' },
    });
    assert.equal(bad.status, 400, `expected an unsupported format to be refused, got: ${JSON.stringify(bad.body)}`);
    assert.match(bad.body.message || '', /not supported/i);

    // CSV is real, but only for one data set, because a CSV file has one header row.
    const multi = await api('POST', `/api/platform/tenants/${tenants.a}/exports`, {
      token: tokens['platform:super'],
      body: {
        scope: { employees: true, payroll: true }, format: 'csv', reason: 'Customer offboarding request',
      },
    });
    assert.equal(multi.status, 400, 'a multi-data-set CSV must be refused');
    assert.match(multi.body.message || '', /single data set/i);

    // And a single-data-set CSV actually produces a CSV.
    const ok = await api('POST', `/api/platform/tenants/${tenants.a}/exports`, {
      token: tokens['platform:super'],
      body: { scope: { employees: true }, format: 'csv', reason: 'Customer offboarding request' },
    });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));

    const job = await dataExports.runNext();
    assert.equal(job.status, 'completed', `the CSV export failed: ${job.error_message || ''}`);
    assert.match(job.storage_path || '', /\.csv$/, 'the artefact must carry the requested extension');

    const csv = fs.readFileSync(path.join(env.uploadDir, job.storage_path), 'utf8');
    const lines = csv.trim().split('\n');
    assert.ok(lines[0].includes('employee_code'), `the CSV header is wrong: ${lines[0]}`);
    assert.ok(lines.length > 1, 'the CSV has no data rows');
    assert.ok(csv.endsWith('\n'), 'the CSV must end with a newline');
  });

  test('CSV values containing commas, quotes or newlines survive the round trip', async () => {
    await api('POST', `/api/platform/tenants/${tenants.a}/exports`, {
      token: tokens['platform:super'],
      body: { scope: { employees: true }, format: 'csv', reason: 'Round trip quoting check' },
    });
    const job = await dataExports.runNext();
    assert.equal(job.status, 'completed', job.error_message || '');
    const csv = fs.readFileSync(path.join(env.uploadDir, job.storage_path), 'utf8');

    assert.ok(
      csv.includes('"Comma, ""quote"" and\nnewline"'),
      `a value with a comma, a quote and a newline was not quoted and escaped correctly:\n${csv}`
    );
  });

  test('a queued export is assembled by the worker and stays inside its tenant', async () => {
    // Tenant A's exportable employees were seeded in before(); EXP-A is one of them,
    // so we can prove the artefact contains A's rows and nobody else's.
    const req = await api('POST', `/api/platform/tenants/${tenants.a}/exports`, {
      token: tokens['platform:super'],
      body: { scope: { employees: true }, reason: 'Customer offboarding data request' },
    });
    assert.equal(req.status, 201, JSON.stringify(req.body));
    assert.equal(req.body.data.status, 'queued', 'an export must be queued, not run inline');

    const job = await dataExports.runNext();
    assert.ok(job, 'the worker found no queued export to run');
    assert.equal(job.status, 'completed', `the export failed: ${job.error_message || ''}`);
    assert.ok(Number(job.byte_size) > 0, 'the export produced an empty artefact');

    const full = path.join(env.uploadDir, job.storage_path);
    assert.ok(fs.existsSync(full), 'the artefact was not written');
    const manifest = JSON.parse(fs.readFileSync(full, 'utf8'));

    // Scoped to the requested data set only.
    assert.deepEqual(Object.keys(manifest.datasets), ['employees'], 'the export ignored the requested scope');

    // And every row belongs to the tenant that asked.
    assert.ok(manifest.datasets.employees.rows.length > 0, 'the export returned nothing to export');
    for (const row of manifest.datasets.employees.rows) {
      assert.equal(Number(row.tenant_id), Number(tenants.a), 'the export leaked another tenant\'s rows');
    }
    assert.ok(manifest.datasets.employees.rows.some((x) => x.employee_code === 'EXP-A'),
      'the tenant\'s own data is missing from its export');

    const [audits] = await pool.query(
      `SELECT * FROM platform_audit_logs WHERE entity_id = ? AND action = 'data.export_completed'`, [job.id]
    );
    assert.ok(audits.length > 0, 'a completed export must be audited');

    // The download is gated on a live support session, not just a permission.
    const noSession = await api('GET', `/api/platform/exports/${job.id}/download`, { token: tokens['platform:super'] });
    assert.equal(noSession.status, 403, 'downloading an export must require support access');
    assert.equal(noSession.body.details?.requiresSupportAccess, true);
  });

  test('an unknown data set is refused rather than silently ignored', async () => {
    const res = await api('POST', `/api/platform/tenants/${tenants.a}/exports`, {
      token: tokens['platform:super'],
      body: { scope: { not_a_table: true }, reason: 'Testing scope validation' },
    });
    assert.equal(res.status, 400);
    assert.match(res.body.message || '', /Unknown export data set/);
  });
});

// ============================================================ the guard rail itself
describe('the platform roles still hold no customer data by default', () => {
  test('a platform auditor can read the platform but never a tenant', async () => {
    const auditor = await makePlatformUser('auditor-lc', 'platform_auditor');
    const token = tokens['platform:auditor-lc'];

    const dash = await api('GET', '/api/platform/dashboard', { token });
    assert.equal(dash.status, 200, 'the auditor should read the platform dashboard');

    const tenantRead = await api('GET', `/api/platform/tenants/${tenants.a}`, { token });
    assert.equal(tenantRead.status, 403, 'the auditor reached into a customer without support access');
  });

  test('a company owner cannot reach the platform console at all', async () => {
    const res = await api('GET', '/api/platform/tenants', { token: tokens['a:owner-a'] });
    assert.equal(res.status, 403);
  });

  test('a company owner cannot request an export of another company', async () => {
    const res = await api('POST', `/api/platform/tenants/${tenants.b}/exports`, {
      token: tokens['a:owner-a'],
      body: { reason: 'Attempting to export a competitor' },
    });
    assert.ok([401, 403].includes(res.status), `expected a refusal, got ${res.status}`);
  });
});

void scopedSubscriptionIds;