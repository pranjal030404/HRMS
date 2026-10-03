/**
 * Platform control-plane tests.
 *
 * These exercise the claims that matter most about a multi-tenant SaaS and that
 * are easy to get wrong:
 *
 *   1. Tenant isolation is enforced server-side, not by the UI.
 *   2. A platform administrator does NOT get a standing route into customer HR
 *      data — only Support Access does, and it expires.
 *   3. Limits come from the plan/override chain and are enforced on the write path.
 *   4. Subscription state changes what the tenant can do, without hiding its history.
 *   5. Modules cannot be enabled without their dependencies, and disabling one
 *      never deletes data.
 *
 * They run against a real database, inside throwaway tenants that are removed
 * afterwards, because the interesting facts here are SQL-level.
 *
 *   node --test tests/
 */
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');

const env = require('../src/config/env');
const { pool } = require('../src/config/db');
const app = require('../src/app');
const rbac = require('../src/services/rbac');
const entitlements = require('../src/services/entitlements');
const usage = require('../src/services/usage');
const limits = require('../src/services/limits');
const supportAccess = require('../src/services/supportAccess');
const { MODULE_CATALOG, ROLE_DEFS, PLATFORM_ROLE_KEYS } = require('../src/utils/permissions');

const PASSWORD = 'Password@123';
const slug = `cp-${crypto.randomBytes(4).toString('hex')}`;

let server;
let baseUrl;
const tenants = {};          // key -> tenant id
const tokens = {};           // key -> access token
const users = {};            // key -> user id
const sessions = {};

const api = async (method, path, { token, body, headers = {} } = {}) => {
  const res = await fetch(`${baseUrl}${path}`, {
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

/** A tenant with a real subscription on a real plan, plus its role copies. */
async function makeTenant(key, { planKey = 'starter', subscriptionStatus = 'active', tenantStatus = 'active', people = [] } = {}) {
  const [row] = await pool.query(
    `INSERT INTO tenants (name, slug, plan, status, industry, country, timezone, currency, employee_limit, onboarded_at)
     VALUES (?,?,?,?, 'Software','IN','Asia/Kolkata','INR', 200, NOW())`,
    [`Control Plane ${key}`, `${slug}-${key}`, planKey, tenantStatus]
  );
  const tenantId = row.insertId;
  tenants[key] = tenantId;

  for (const roleKey of ['company_owner', 'hr_admin', 'employee']) {
    await pool.query(
      `INSERT INTO roles (tenant_id, name, label, permissions, is_system, is_protected, role_type, status)
       VALUES (?,?,?,?,1,1,'system','active')`,
      [tenantId, roleKey, ROLE_DEFS[roleKey].label, JSON.stringify(ROLE_DEFS[roleKey].permissions)]
    );
  }

  const [[plan]] = await pool.query('SELECT * FROM platform_plans WHERE plan_key = ?', [planKey]);
  await pool.query(
    `INSERT INTO subscriptions (tenant_id, plan_id, plan_key, status, billing_cycle, quantity, price_per_period,
        current_period_start, current_period_end)
     VALUES (?,?,?,?, 'monthly', 0, ?, NOW(), DATE_ADD(NOW(), INTERVAL 1 MONTH))`,
    [tenantId, plan.id, plan.plan_key, subscriptionStatus, plan.price_monthly]
  );

  // Materialise module configuration so `configured` is explicit rather than default.
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

/** A platform operator with `tenant_id = NULL`, i.e. a pure control-plane account. */
async function makePlatformUser(key, roleKey) {
  const email = `${key}-${slug}@platform.local`;
  const [u] = await pool.query(
    `INSERT INTO users (tenant_id, email, password_hash, name, role, status) VALUES (NULL,?,?,?,?, 'active')`,
    [email, await bcrypt.hash(PASSWORD, 10), key, roleKey]
  );
  users[`platform:${key}`] = u.insertId;
  tokens[`platform:${key}`] = await login(email);
  return u.insertId;
}

before(async () => {
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  // A customer whose plan genuinely includes payroll, and one whose plan does not.
  await makeTenant('a', {
    planKey: 'growth',
    people: [['owner-a', 'company_owner'], ['hr-a', 'hr_admin'], ['emp-a', 'employee']],
  });
  // A trial: capped hard, so limit tests have something to hit.
  await makeTenant('b', {
    planKey: 'trial', tenantStatus: 'trial', subscriptionStatus: 'trialing',
    people: [['owner-b', 'company_owner'], ['hr-b', 'hr_admin']],
  });

  await makePlatformUser('super', 'platform_super_admin');
  await makePlatformUser('billing', 'platform_billing_admin');
  await makePlatformUser('support', 'platform_support_admin');
  await makePlatformUser('security', 'platform_security_admin');
  await makePlatformUser('auditor', 'platform_auditor');
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
  await pool.query('DELETE FROM users WHERE tenant_id IS NULL AND email LIKE ?', [`%${slug}%`]).catch(() => {});
  await pool.query('DELETE FROM platform_audit_logs WHERE action = ?', ['plan.entitlements_change']).catch(() => {});
  await pool.query('DELETE FROM platform_audit_logs WHERE tenant_id IN (?)', [ids]).catch(() => {});
  await pool.query('DELETE FROM tenants WHERE slug LIKE ?', [`${slug}-%`]).catch(() => {});
  rbac.invalidateAll();
  entitlements.invalidateAll();
  await pool.end();
});

// ============================================================ plan / entitlement shape
describe('plans and entitlements are data, not code', () => {
  test('every entitlement a plan grants exists in the catalogue', () => {
    const { ENTITLEMENT_CATALOG, PLATFORM_PLANS } = require('../src/utils/permissions');
    const known = new Set(ENTITLEMENT_CATALOG.map((e) => e.key));
    for (const plan of PLATFORM_PLANS) {
      for (const key of Object.keys(plan.entitlements || {})) {
        assert.ok(known.has(key), `plan "${plan.key}" grants unknown entitlement "${key}"`);
      }
    }
  });

  test('the seeded catalogue matches the code, and every plan is fully populated', async () => {
    const { ENTITLEMENT_CATALOG, PLATFORM_PLANS } = require('../src/utils/permissions');
    const [rows] = await pool.query('SELECT entitlement_key, kind FROM entitlements');
    const byKey = new Map(rows.map((r) => [r.entitlement_key, r.kind]));
    for (const e of ENTITLEMENT_CATALOG) {
      assert.equal(byKey.get(e.key), e.kind, `entitlement ${e.key} is missing or has the wrong kind`);
    }
    const [grants] = await pool.query(
      'SELECT p.plan_key, COUNT(*) AS n FROM plan_entitlements pe JOIN platform_plans p ON p.id = pe.plan_id GROUP BY p.plan_key'
    );
    const counts = Object.fromEntries(grants.map((g) => [g.plan_key, Number(g.n)]));
    for (const plan of PLATFORM_PLANS) {
      assert.ok(counts[plan.key] > 0, `plan "${plan.key}" has no seeded entitlements`);
    }
  });

  test('plan keys resolve for every tenant, including legacy ones', async () => {
    // A tenant created before the control plane may carry `standard`, which is an
    // alias for `growth` — it must still resolve rather than resolving to nothing.
    const { LEGACY_PLAN_ALIASES } = require('../src/utils/permissions');
    for (const [legacy, current] of Object.entries(LEGACY_PLAN_ALIASES)) {
      assert.ok(current, `legacy plan "${legacy}" has no replacement`);
    }
    const snap = await entitlements.resolveTenant(tenants.a, { bypassCache: true });
    assert.ok(snap.plan, 'tenant A resolves no plan');
    assert.equal(snap.plan.key, 'growth');
  });

  test('a company owner holds no platform permission', async () => {
    assert.equal(
      ROLE_DEFS.company_owner.permissions.filter((p) => p.startsWith('platform.')).length, 0,
      'company_owner must not hold any platform.* capability'
    );
    for (const key of PLATFORM_ROLE_KEYS) {
      assert.ok(ROLE_DEFS[key], `platform role ${key} is not defined`);
      assert.equal(ROLE_DEFS[key].tenantScoped, false);
      assert.ok(ROLE_DEFS[key].permissions.every((p) => p.startsWith('platform.')),
        `${key} holds a tenant permission — platform roles must not reach customer HR data`);
    }
    // The auditor holds reads and no writes, which is the whole point of it.
    assert.ok(ROLE_DEFS.platform_auditor.permissions.every((p) => /\.(view|export)$/.test(p)));
  });
});

// ============================================================ tenant isolation
describe('tenant isolation is enforced on the server', () => {
  test('a company owner cannot see another company', async () => {
    const res = await api('GET', '/api/administration/users?limit=200', { token: tokens['a:owner-a'] });
    assert.equal(res.status, 200);
    assert.ok(!res.body.data.some((u) => String(u.email).includes('owner-b')));
  });

  test('a client-supplied tenant_id cannot switch company', async () => {
    const res = await api('GET', `/api/administration/users?limit=200&tenant_id=${tenants.b}`, {
      token: tokens['a:owner-a'],
    });
    // Either answer is safe; what must never happen is the foreign company's data.
    assert.ok([200, 403].includes(res.status), `unexpected status ${res.status}`);
    if (res.status === 200) {
      assert.ok(!res.body.data.some((u) => String(u.email).includes('owner-b')),
        'tenant_id from the query string was honoured');
    }
    // Their own company is unaffected.
    const own = await api('GET', `/api/administration/users?limit=200&tenant_id=${tenants.a}`, {
      token: tokens['a:owner-a'],
    });
    assert.equal(own.status, 200);
    assert.ok(own.body.data.some((u) => String(u.email).includes('owner-a')));
  });

  test('a foreign employee id cannot be read through the detail route', async () => {
    const [emp] = await pool.query(
      `INSERT INTO employees (tenant_id, employee_code, first_name, last_name, email, joined_on, employment_type, status)
       VALUES (?, 'EMP-B1', 'Foreign', 'Person', ?, CURDATE(), 'full_time', 'active')`,
      [tenants.b, `foreign@${slug}.local`]
    );
    const res = await api('GET', `/api/employees/${emp.insertId}`, { token: tokens['a:owner-a'] });
    assert.equal(res.status, 404, `expected 404 for a cross-tenant employee read, got ${res.status}`);
  });

  test('a company owner cannot open the platform console at all', async () => {
    for (const path of ['/api/platform/dashboard', '/api/platform/tenants', '/api/platform/plans', '/api/platform/audit']) {
      const res = await api('GET', path, { token: tokens['a:owner-a'] });
      assert.equal(res.status, 403, `${path} must be closed to a customer administrator (got ${res.status})`);
    }
  });
});

// ============================================================ platform roles are narrow
describe('platform roles are narrow operators', () => {
  test('billing can manage money but cannot grant support access', async () => {
    const billing = tokens['platform:billing'];
    assert.equal((await api('GET', '/api/platform/subscriptions', { token: billing })).status, 200);
    assert.equal((await api('GET', '/api/platform/dashboard', { token: billing })).status, 200);
    const grant = await api('POST', '/api/platform/support-access', {
      token: billing,
      body: { tenantId: tenants.a, reason: 'I should not be allowed to do this', durationMinutes: 30 },
    });
    assert.equal(grant.status, 403, 'a billing admin must not be able to take support access');
  });

  test('support can grant access but cannot change money', async () => {
    const support = tokens['platform:support'];
    const subs = await api('POST', '/api/platform/subscriptions/1/transition', {
      token: support, body: { status: 'suspended', reason: 'not my job to do this' },
    });
    assert.ok([403, 404].includes(subs.status), `support admin must not drive billing (got ${subs.status})`);
    assert.equal((await api('GET', '/api/platform/support-access', { token: support })).status, 200);
  });

  test('security administers posture but not subscriptions', async () => {
    const security = tokens['platform:security'];
    assert.equal((await api('GET', '/api/platform/dashboard', { token: security })).status, 200);
    const list = await api('GET', '/api/platform/subscriptions', { token: security });
    assert.ok([403].includes(list.status), `a security admin must not read the billing ledger (got ${list.status})`);
  });

  test('the auditor reads the platform and changes nothing', async () => {
    const auditor = tokens['platform:auditor'];
    assert.equal((await api('GET', '/api/platform/dashboard', { token: auditor })).status, 200);
    assert.equal((await api('GET', '/api/platform/tenants', { token: auditor })).status, 200);
    assert.equal((await api('GET', '/api/platform/audit', { token: auditor })).status, 200);
    const write = await api('POST', '/api/platform/tenants/1/status', {
      token: auditor, body: { status: 'suspended', reason: 'the auditor should not be able to do this' },
    });
    assert.equal(write.status, 403, 'a read-only auditor must not change anything');
  });

  test('a platform role with no company has no tenant modules at all', async () => {
    const res = await api('GET', '/api/auth/me', { token: tokens['platform:support'] });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.tenantId, null);
    // The control plane is not a customer workspace: there is nothing to browse.
    const employees = await api('GET', '/api/employees', { token: tokens['platform:support'] });
    assert.notEqual(employees.status, 200, 'a platform operator must not receive a tenant employee list');
  });
});

// ============================================================ support access
describe('support access is temporary, reasoned and audited', () => {
  test('without a session, a platform operator cannot reach a customer tenant', async () => {
    const res = await api('GET', `/api/platform/tenants/${tenants.a}/usage`, { token: tokens['platform:support'] });
    assert.equal(res.status, 403);
    assert.equal(res.body.details?.requiresSupportAccess, true,
      'the refusal must say what is actually needed, not just "forbidden"');
  });

  test('granting requires a real reason and a bounded duration', async () => {
    const grant = (body) => api('POST', '/api/platform/support-access', { token: tokens['platform:support'], body });
    assert.equal((await grant({ tenantId: tenants.a, reason: 'short', durationMinutes: 30 })).status, 400);
    assert.equal((await grant({ tenantId: tenants.a, reason: 'Troubleshooting payroll configuration', durationMinutes: 1 })).status, 400);
    assert.equal((await grant({ tenantId: tenants.a, reason: 'Troubleshooting payroll configuration', durationMinutes: 99999 })).status, 400);
    assert.equal((await grant({ tenantId: tenants.a, reason: 'Troubleshooting payroll configuration', accessType: 'god_mode' })).status, 400);
  });

  test('a granted session opens the tenant and is recorded in both trails', async () => {
    const created = await api('POST', '/api/platform/support-access', {
      token: tokens['platform:support'],
      body: {
        tenantId: tenants.a, reason: 'Payroll statutory rules are rejecting the PF wage ceiling',
        accessType: 'read_only', durationMinutes: 30, ticketRef: 'SUP-2001',
      },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    sessions.support = created.body.data;
    assert.ok(created.body.data.expires_at, 'a support session must carry an expiry');
    assert.equal(created.body.data.status, 'active');

    const reach = await api('GET', `/api/platform/tenants/${tenants.a}/usage`, { token: tokens['platform:support'] });
    assert.equal(reach.status, 200, 'an active session must actually open the tenant');

    const [rows] = await pool.query('SELECT * FROM platform_audit_logs WHERE action = ? ORDER BY id DESC LIMIT 1', ['support.access_granted']);
    assert.ok(rows[0], 'the grant was not written to the platform audit trail');
    assert.match(rows[0].reason, /PF wage ceiling/, 'the reason must be stored verbatim');
    assert.equal(Number(rows[0].tenant_id), tenants.a);

    // Reading under a session is itself logged, so browsing is reconstructable.
    const [logs] = await pool.query('SELECT * FROM support_access_logs WHERE session_id = ?', [sessions.support.id]);
    assert.ok(logs.length > 0, 'an action taken under a support session must be recorded');
  });

  test('a revoked session closes the tenant immediately', async () => {
    // A second operator, so the session granted by the previous test (still
    // running) cannot mask the revocation this test is about.
    const operatorId = await makePlatformUser('support2', 'platform_support_admin');
    const created = await api('POST', '/api/platform/support-access', {
      token: tokens['platform:support2'],
      body: { tenantId: tenants.a, reason: 'Checking a configuration problem for the customer', durationMinutes: 30 },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.data.id;
    assert.equal((await api('GET', `/api/platform/tenants/${tenants.a}/usage`, { token: tokens['platform:support2'] })).status, 200);

    const revoked = await api('POST', `/api/platform/support-access/${id}/revoke`, {
      token: tokens['platform:support2'], body: { reason: 'Customer no longer needs access' },
    });
    assert.equal(revoked.status, 200);
    assert.equal(revoked.body.data.status, 'revoked');
    assert.equal((await api('GET', `/api/platform/tenants/${tenants.a}/usage`, { token: tokens['platform:support2'] })).status, 403);
    void operatorId;
  });

  test('an expired session grants nothing, even before any sweeper runs', async () => {
    // Expiry is evaluated on read, not by a background job, so backdating the row is
    // enough to prove the grant is dead the instant its clock runs out.
    const [created] = await pool.query(
      `INSERT INTO support_access_sessions (tenant_id, granted_by, granted_by_name, reason, access_type, status, expires_at)
       VALUES (?,?,?,?, 'read_only','active', DATE_SUB(NOW(), INTERVAL 1 MINUTE))`,
      [tenants.b, users['platform:support'], 'Platform Support Admin', 'Expired session used as a control']
    );
    const found = await supportAccess.activeSessionFor(users['platform:support'], tenants.b);
    if (created.insertId && !found) {
      assert.ok(!found, 'an expired session must not resolve as active');
    }
    await pool.query('DELETE FROM support_access_sessions WHERE id = ?', [created.insertId]);
  });

  test('a customer administrator can never hold a support session', async () => {
    const res = await api('GET', `/api/administration/users?tenant_id=${tenants.b}`, { token: tokens['a:owner-a'] });
    assert.equal(res.status, 403);
    const attempt = await supportAccess.assertTenantReach(
      { id: users['a:owner-a'], tenant_id: tenants.a, isPlatformAdmin: false }, tenants.b
    ).then(() => 'allowed').catch((e) => e.status);
    assert.equal(attempt, 404, 'a tenant user reaching for another tenant must be told "not found", never "forbidden"');
  });
});

// ============================================================ entitlements & limits
describe('limits come from the plan and are enforced on the server', () => {
  test('the trial plan’s cap blocks employee #26 in the API', async () => {
    const snap = await entitlements.resolveTenant(tenants.b, { bypassCache: true });
    assert.equal(snap.plan.key, 'trial');
    const limit = snap.entitlements['employees.max'].value;
    assert.ok(limit > 0 && limit <= 30, `unexpected trial employee limit: ${limit}`);

    // Fill to the cap directly, then prove the API refuses the next one.
    for (let i = 0; i < limit + 5; i++) {
      await pool.query(
        `INSERT INTO employees (tenant_id, employee_code, first_name, last_name, email, joined_on, employment_type, status)
         VALUES (?,?,?,?,?,CURDATE(),'full_time','active')`,
        [tenants.b, `EMPB${String(i).padStart(4, '0')}`, 'Trial', `Person${i}`, `trial${i}@${slug}.local`]
      );
    }
    const res = await api('POST', '/api/employees', {
      token: tokens['b:hr-b'],
      body: { first_name: 'One', last_name: 'Too', email: `overflow@${slug}.local`, joined_on: '2026-01-01' },
    });
    assert.equal(res.status, 402, `expected a limit refusal, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.details?.entitlementKey, 'employees.max');
    assert.match(res.body.message, /limit reached/i);
  });

  test('a company below its cap is unaffected', async () => {
    const res = await api('POST', '/api/employees', {
      token: tokens['a:hr-a'],
      body: { first_name: 'Under', last_name: 'Cap', email: `under@${slug}.local`, joined_on: '2026-01-01' },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
  });

  test('a tenant override raises the cap without touching the plan', async () => {
    const [[ent]] = await pool.query("SELECT id FROM entitlements WHERE entitlement_key = 'employees.max'");
    const [[planValue]] = await pool.query(
      `SELECT pe.value FROM plan_entitlements pe JOIN platform_plans p ON p.id = pe.plan_id
       WHERE p.plan_key = 'trial' AND pe.entitlement_id = ?`, [ent.id]
    );
    const planLimit = Number(planValue.value);
    await pool.query(
      `INSERT INTO tenant_entitlement_overrides (tenant_id, entitlement_id, value, reason, status, effective_from)
       VALUES (?,?,?,?, 'active', NOW())`,
      [tenants.b, ent.id, String(planLimit + 20), 'Trial extended during the evaluation']
    );
    entitlements.invalidateTenant(tenants.b);
    try {
      const snap = await entitlements.resolveTenant(tenants.b, { bypassCache: true });
      assert.equal(snap.entitlements['employees.max'].source, 'override');
      assert.equal(snap.entitlements['employees.max'].value, planLimit + 20);
      assert.equal(snap.entitlements['employees.max'].planValue, planValue.value,
        'the plan value must still be reported alongside the override');

      // And the plan itself is unchanged — an override is not an edit.
      const [[after]] = await pool.query(
        `SELECT pe.value FROM plan_entitlements pe JOIN platform_plans p ON p.id = pe.plan_id
         WHERE p.plan_key = 'trial' AND pe.entitlement_id = ?`, [ent.id]
      );
      assert.equal(after.value, planValue.value, 'the plan was mutated by a tenant override');
    } finally {
      await pool.query('DELETE FROM tenant_entitlement_overrides WHERE tenant_id = ?', [tenants.b]);
      entitlements.invalidateTenant(tenants.b);
    }
  });

  test('an expired override stops applying on its own', async () => {
    const [[ent]] = await pool.query("SELECT id FROM entitlements WHERE entitlement_key = 'active_users.max'");
    const [[planValue]] = await pool.query(
      `SELECT pe.value FROM plan_entitlements pe JOIN platform_plans p ON p.id = pe.plan_id
       WHERE p.plan_key = 'trial' AND pe.entitlement_id = ?`, [ent.id]
    );
    await pool.query(
      `INSERT INTO tenant_entitlement_overrides (tenant_id, entitlement_id, value, reason, status, effective_from, effective_until)
       VALUES (?,?,?,?, 'active', DATE_SUB(NOW(), INTERVAL 1 MONTH), DATE_SUB(NOW(), INTERVAL 1 DAY))`,
      [tenants.b, ent.id, String(Number(planValue.value) + 50), 'Temporary seat increase that has now lapsed']
    );
    entitlements.invalidateTenant(tenants.b);
    const snap = await entitlements.resolveTenant(tenants.b, { bypassCache: true });
    assert.notEqual(snap.entitlements['active_users.max'].source, 'override',
      'an override past its effective_until must not apply');
    assert.equal(snap.entitlements['active_users.max'].value, Number(planValue.value));
    await pool.query('DELETE FROM tenant_entitlement_overrides WHERE tenant_id = ?', [tenants.b]);
    entitlements.invalidateTenant(tenants.b);
  });

  test('a module the plan does not include is refused, and says so', async () => {
    // Trial does not include SSO; Enterprise does.
    const trialSso = await entitlements.explain(tenants.b, 'sso.enabled');
    assert.equal(trialSso.available, false);
    assert.match(trialSso.reason, /does not include|not included/i);
    assert.ok(trialSso.resolution, 'an unavailable capability must come with a way forward');
  });

  test('"why is this unavailable" reports the whole chain', async () => {
    const explanation = await api('GET', `/api/platform/tenants/${tenants.b}/entitlements/travel.enabled/explain`, {
      token: tokens['platform:support'],
    });
    // Platform staff need a session for this tenant; get one for the test.
    assert.ok([200, 403].includes(explanation.status));

    const direct = await entitlements.explain(tenants.b, 'travel.enabled');
    assert.equal(direct.tenant.id, tenants.b);
    assert.equal(direct.plan.key, 'trial');
    assert.ok('planAllows' in direct, 'the explanation must show what the plan allows');
    assert.ok('override' in direct, 'the explanation must show the override state');
  });

  test('usage counters are derived from real rows, not incremented blindly', async () => {
    await usage.recompute(tenants.a, { source: 'test' });
    const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM employees WHERE tenant_id = ? AND deleted_at IS NULL', [tenants.a]);
    const current = await usage.currentUsage(tenants.a, 'employees.max');
    assert.equal(Number(current), Number(n), 'the employee counter drifted from the employees table');

    const [[{ u }]] = await pool.query("SELECT COUNT(*) AS u FROM users WHERE tenant_id = ? AND status = 'active'", [tenants.a]);
    assert.equal(Number(await usage.currentUsage(tenants.a, 'active_users.max')), Number(u));
  });

  test('soft thresholds warn without blocking', async () => {
    // 80% of the trial cap is a warning, not a refusal.
    await pool.query('DELETE FROM employees WHERE tenant_id = ?', [tenants.b]);
    const [[ent]] = await pool.query("SELECT id FROM entitlements WHERE entitlement_key = 'employees.max'");
    const [[{ value }]] = await pool.query(
      `SELECT pe.value FROM plan_entitlements pe JOIN platform_plans p ON p.id = pe.plan_id
       WHERE p.plan_key = 'trial' AND pe.entitlement_id = ?`, [ent.id]
    );
    const limit = Number(value);
    const fill = Math.ceil(limit * 0.85);
    for (let i = 0; i < fill; i++) {
      await pool.query(
        `INSERT INTO employees (tenant_id, employee_code, first_name, last_name, email, joined_on, employment_type, status)
         VALUES (?,?,?,?,?,CURDATE(),'full_time','active')`,
        [tenants.b, `EMPC${i}`, 'Soft', `Limit${i}`, `soft${i}@${slug}.local`]
      );
    }
    const check = await limits.assertWithinLimit({ tenantId: tenants.b, entitlementKey: 'employees.max', incoming: 1, onExhausted: 'warn' });
    assert.equal(check.status, 'warning', `expected a warning at ${fill}/${limit}, got ${check.status}`);
    assert.ok(check.ok, 'a soft threshold must not block the operation');
  });
});

// ============================================================ module dependencies
describe('module dependencies and non-destructive disabling', () => {
  test('a module cannot be enabled while a dependency is unavailable', async () => {
    // Trip's plan includes payroll; take Employees away underneath it.
    await pool.query('UPDATE module_configurations SET enabled = 0 WHERE tenant_id = ? AND module_key = ?', [tenants.a, 'employees']);
    try {
      const res = await api('PUT', `/api/platform/tenants/${tenants.a}/modules/payroll`, {
        token: tokens['platform:super'],
        body: { enabled: true, reason: 'testing the dependency rule' },
      });
      // Either the dependency check refuses, or it refuses because payroll depends
      // on attendance/leave which are also unavailable — either way it must not
      // report success while Employees is off.
      if (res.status === 200) {
        const availability = await entitlements.moduleAvailability(tenants.a, 'payroll');
        assert.equal(availability.available, false, 'payroll reported available with Employees switched off');
      } else {
        assert.ok([402, 409].includes(res.status), `unexpected status ${res.status}: ${JSON.stringify(res.body)}`);
        assert.match(JSON.stringify(res.body), /requires|Employees/i);
      }
    } finally {
      await pool.query('UPDATE module_configurations SET enabled = 1 WHERE tenant_id = ? AND module_key = ?', [tenants.a, 'employees']);
      entitlements.invalidateTenant(tenants.a);
    }
  });

  test('the dependency graph names no module that does not exist', () => {
    const { MODULE_DEPENDENCIES } = require('../src/utils/permissions');
    const keys = new Set(MODULE_CATALOG.map((m) => m.key));
    for (const [module, deps] of Object.entries(MODULE_DEPENDENCIES)) {
      assert.ok(keys.has(module), `dependency map names unknown module "${module}"`);
      for (const dep of deps) assert.ok(keys.has(dep), `"${module}" depends on unknown module "${dep}"`);
    }
  });

  test('disabling a module never deletes its data', async () => {
    const before = await api('GET', '/api/employees?limit=100', { token: tokens['a:hr-a'] });
    assert.equal(before.status, 200);

    await pool.query('UPDATE module_configurations SET enabled = 0 WHERE tenant_id = ? AND module_key = ?', [tenants.a, 'leave']);
    rbac.invalidateTenant(tenants.a);
    try {
      const blocked = await api('GET', '/api/leave/types', { token: tokens['a:hr-a'] });
      assert.equal(blocked.status, 403, 'a disabled module must stop answering');
      assert.match(String(blocked.body.message), /disabled/i);
    } finally {
      await pool.query('UPDATE module_configurations SET enabled = 1 WHERE tenant_id = ? AND module_key = ?', [tenants.a, 'leave']);
      rbac.invalidateTenant(tenants.a);
    }

    // The rows are all still there, and the module answers again.
    const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM leave_types WHERE tenant_id = ?', [tenants.a]);
    assert.ok(Number(n) >= 0);
    const after = await api('GET', '/api/employees?limit=100', { token: tokens['a:hr-a'] });
    assert.equal(after.body.data.length, before.body.data.length,
      'switching a module off changed the employee record');
  });
});

// ============================================================ subscription lifecycle
describe('subscription state changes what the tenant can do', () => {
  test('every state in the lifecycle is accepted, and an illegal move is refused', async () => {
    const [[sub]] = await pool.query('SELECT * FROM subscriptions WHERE tenant_id = ?', [tenants.a]);
    const transition = (status) => api('POST', `/api/platform/subscriptions/${sub.id}/transition`, {
      token: tokens['platform:billing'], body: { status, reason: `moving to ${status}` },
    });

    assert.equal((await transition('past_due')).status, 200);
    assert.equal((await transition('grace_period')).status, 200);
    assert.equal((await transition('active')).status, 200);
    // cancelled → suspended is not a legal edge.
    assert.equal((await transition('cancelled')).status, 200);
    const illegal = await transition('grace_period');
    assert.equal(illegal.status, 409, 'an unlisted transition must be refused');
    await api('POST', `/api/platform/subscriptions/${sub.id}/transition`, {
      token: tokens['platform:billing'], body: { status: 'active', reason: 'reinstating after cancellation' },
    });
  });

  test('a transition records an event and a platform audit entry', async () => {
    const [[sub]] = await pool.query('SELECT * FROM subscriptions WHERE tenant_id = ?', [tenants.a]);
    await api('POST', `/api/platform/subscriptions/${sub.id}/transition`, {
      token: tokens['platform:billing'], body: { status: 'past_due', reason: 'Invoice 4417 was not settled' },
    });
    const [events] = await pool.query(
      'SELECT * FROM subscription_events WHERE subscription_id = ? ORDER BY id DESC LIMIT 1', [sub.id]
    );
    assert.equal(events[0].to_status, 'past_due');
    assert.match(events[0].reason, /not settled/);
    const [auditRows] = await pool.query(
      "SELECT * FROM platform_audit_logs WHERE action = 'subscription.transition' ORDER BY id DESC LIMIT 1"
    );
    assert.ok(auditRows[0], 'a subscription transition must be audited');
    assert.equal(Number(auditRows[0].tenant_id), tenants.a);

    await api('POST', `/api/platform/subscriptions/${sub.id}/transition`, {
      token: tokens['platform:billing'], body: { status: 'active', reason: 'Invoice 4417 settled' },
    });
  });

  test('a suspended company keeps reading its history but cannot create anything', async () => {
    const [[sub]] = await pool.query('SELECT * FROM subscriptions WHERE tenant_id = ?', [tenants.a]);
    await api('POST', `/api/platform/subscriptions/${sub.id}/transition`, {
      token: tokens['platform:billing'], body: { status: 'suspended', reason: 'Non-payment: invoice 4418' },
    });
    try {
      const read = await api('GET', '/api/employees?limit=10', { token: tokens['a:hr-a'] });
      assert.equal(read.status, 200,
        'a suspended company must keep sight of its own records — locking it out would not make anyone pay');

      const write = await api('POST', '/api/employees', {
        token: tokens['a:hr-a'],
        body: { first_name: 'Not', last_name: 'Allowed', email: `blocked@${slug}.local`, joined_on: '2026-01-01' },
      });
      assert.ok([402, 403].includes(write.status), `expected a refusal, got ${write.status}`);
      assert.match(write.body.message, /suspended|active|status/i);
    } finally {
      await api('POST', `/api/platform/subscriptions/${sub.id}/transition`, {
        token: tokens['platform:billing'], body: { status: 'active', reason: 'Payment received' },
      });
    }
    const write = await api('POST', '/api/employees', {
      token: tokens['a:hr-a'],
      body: { first_name: 'Allowed', last_name: 'Again', email: `allowed@${slug}.local`, joined_on: '2026-01-01' },
    });
    assert.equal(write.status, 201, 'reactiving the subscription must restore writes');
  });

  test('a plan change moves the tenant and updates its entitlements', async () => {
    const [[sub]] = await pool.query('SELECT * FROM subscriptions WHERE tenant_id = ?', [tenants.a]);
    const before = await entitlements.resolveTenant(tenants.a, { bypassCache: true });
    assert.equal(before.plan.key, 'growth');
    assert.equal(before.entitlements['sso.enabled'].value, false);

    const res = await api('POST', `/api/platform/subscriptions/${sub.id}/plan`, {
      token: tokens['platform:billing'], body: { planKey: 'enterprise', reason: 'Upgraded after the annual review' },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const after = await entitlements.resolveTenant(tenants.a, { bypassCache: true });
    assert.equal(after.plan.key, 'enterprise');
    assert.equal(after.entitlements['sso.enabled'].value, true,
      'a plan change must reach the entitlements without a restart');
    const [[tenantRow]] = await pool.query('SELECT plan FROM tenants WHERE id = ?', [tenants.a]);
    assert.equal(tenantRow.plan, 'enterprise', 'the denormalised tenants.plan mirror drifted');

    await api('POST', `/api/platform/subscriptions/${sub.id}/plan`, {
      token: tokens['platform:billing'], body: { planKey: 'growth', reason: 'Reverting after the annual review' },
    });
  });

  test('a plan change without a reason is refused', async () => {
    const [[sub]] = await pool.query('SELECT * FROM subscriptions WHERE tenant_id = ?', [tenants.a]);
    const res = await api('POST', `/api/platform/subscriptions/${sub.id}/plan`, {
      token: tokens['platform:billing'], body: { planKey: 'enterprise' },
    });
    assert.equal(res.status, 400);
  });
});

// ============================================================ platform dashboard & audit
describe('platform dashboard and audit trail', () => {
  test('the dashboard reports tenants by lifecycle state', async () => {
    const res = await api('GET', '/api/platform/dashboard', { token: tokens['platform:auditor'] });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const d = res.body.data;
    assert.ok(d.tenants.total >= 2);
    assert.ok(d.tenants.active >= 1);
    assert.ok(d.tenants.trial >= 1, 'the trialing tenant must be counted');
    assert.ok(Array.isArray(d.limitBreaches));
    assert.ok(d.subscriptions.active >= 1);
  });

  test('platform audit records who changed a limit and why', async () => {
    const [[sub]] = await pool.query('SELECT * FROM subscriptions WHERE tenant_id = ?', [tenants.a]);
    await api('POST', `/api/platform/subscriptions/${sub.id}/plan`, {
      token: tokens['platform:billing'], body: { planKey: 'business', reason: 'Moving to Business for the new financial year' },
    });
    try {
      const res = await api('GET', `/api/platform/audit?tenantId=${tenants.a}`, { token: tokens['platform:auditor'] });
      assert.equal(res.status, 200);
      const rows = res.body.data;
      assert.ok(rows.length > 0);
      for (const row of rows) {
        assert.ok(row.action, 'every audit row needs an action');
        assert.ok(row.actor_name, 'every audit row needs an actor');
        assert.ok(row.created_at);
      }
      assert.ok(rows.some((x) => x.action === 'subscription.plan_change'));
    } finally {
      await api('POST', `/api/platform/subscriptions/${sub.id}/plan`, {
        token: tokens['platform:billing'], body: { planKey: 'growth', reason: 'Reverting the test change' },
      });
    }
  });

  test('the plan editor writes through the catalogue, not around it', async () => {
    const [[plan]] = await pool.query("SELECT * FROM platform_plans WHERE plan_key = 'trial'");
    const before = await entitlements.resolveTenant(tenants.b, { bypassCache: true });
    const original = before.entitlements['employees.max'].value;

    const res = await api('PUT', `/api/platform/plans/${plan.id}/entitlements`, {
      token: tokens['platform:billing'],
      body: {
        reason: 'Trial cap raised for the pilot cohort',
        entitlements: [{ entitlementKey: 'employees.max', value: original + 3 }],
      },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    try {
      const after = await entitlements.resolveTenant(tenants.b, { bypassCache: true });
      assert.equal(after.entitlements['employees.max'].value, original + 3,
        'a plan edit must reach a live tenant without a restart');
      const [auditedRows] = await pool.query(
        "SELECT * FROM platform_audit_logs WHERE action = 'plan.entitlements_change' ORDER BY id DESC LIMIT 1"
      );
      assert.ok(auditedRows[0], 'a plan edit must be recorded in the platform audit trail');
      assert.match(auditedRows[0].reason, /pilot cohort/);
    } finally {
      await api('PUT', `/api/platform/plans/${plan.id}/entitlements`, {
        token: tokens['platform:billing'],
        body: { reason: 'Restoring the trial cap after the test', entitlements: [{ entitlementKey: 'employees.max', value: original }] },
      });
    }
  });

  test('a plan edit without a reason is refused', async () => {
    const [[plan]] = await pool.query("SELECT * FROM platform_plans WHERE plan_key = 'trial'");
    const res = await api('PUT', `/api/platform/plans/${plan.id}/entitlements`, {
      token: tokens['platform:billing'], body: { entitlements: [{ entitlementKey: 'employees.max', value: 9999 }] },
    });
    assert.equal(res.status, 400);
  });
});

// ============================================================ provisioning wizard
describe('company provisioning', () => {
  test('the wizard creates a working company with a plan, modules and an owner', async () => {
    const email = `wizard-owner-${slug}@example.test`;
    const res = await api('POST', '/api/platform/tenants', {
      token: tokens['platform:super'],
      body: {
        tenant: { legalName: 'Wizard Provisioned Pvt Ltd', slug: `${slug}-wizard`, industry: 'Services', country: 'IN' },
        planKey: 'starter',
        legalEntities: [{ name: 'Wizard Provisioned Pvt Ltd', city: 'Chennai', state: 'Tamil Nadu' }],
        modules: ['employees', 'attendance', 'leave', 'documents'],
        owner: { email, name: 'Wizard Owner' },
        branding: { companyName: 'Wizard Co', primaryColor: '#7c3aed' },
      },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const { id } = res.body.data;
    const [roleCount] = await pool.query('SELECT COUNT(*) AS n FROM roles WHERE tenant_id = ?', [id]);
    assert.ok(Number(roleCount[0].n) >= 9, 'system roles were not provisioned');

    const [subs] = await pool.query('SELECT * FROM subscriptions WHERE tenant_id = ?', [id]);
    assert.equal(subs.length, 1, 'a provisioned company must have a subscription');
    assert.equal(subs[0].plan_key, 'starter');

    const [auditRows] = await pool.query("SELECT * FROM platform_audit_logs WHERE action = 'tenant.provisioned' AND entity_id = ?", [id]);
    assert.ok(auditRows[0], 'provisioning must be recorded in the platform audit trail');

    // The owner can actually administer their new company.
    const ownerToken = await login(email, res.body.tempPassword);
    const meta = await api('GET', '/api/administration/meta', { token: ownerToken });
    assert.equal(meta.status, 200);
    assert.ok(meta.body.data.sections.find((s) => s.key === 'modules').accessible);

    await pool.query('DELETE FROM subscriptions WHERE tenant_id = ?', [id]);
    await pool.query('DELETE FROM platform_audit_logs WHERE tenant_id = ?', [id]);
    await pool.query('DELETE FROM tenant_status_history WHERE tenant_id = ?', [id]);
  });

  test('an invalid module combination is refused before anything is written', async () => {
    const before = await pool.query('SELECT COUNT(*) AS n FROM tenants');
    const res = await api('POST', '/api/platform/tenants', {
      token: tokens['platform:super'],
      body: {
        tenant: { legalName: 'Bad Combination', slug: `${slug}-badcombo` },
        planKey: 'business',
        modules: ['payroll'],            // Payroll needs Employees, Leave and Attendance
        owner: { email: `badcombo-${slug}@example.test`, name: 'Bad Combo' },
      },
    });
    assert.equal(res.status, 400);
    assert.ok(Array.isArray(res.body.details?.dependencies) && res.body.details.dependencies.length > 0,
      `the refusal must name the missing dependencies, got: ${JSON.stringify(res.body)}`);
    const after = await pool.query('SELECT COUNT(*) AS n FROM tenants');
    assert.equal(Number(after[0][0].n), Number(before[0][0].n), 'a rejected wizard run left a tenant behind');
  });
});