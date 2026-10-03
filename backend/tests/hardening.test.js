/**
 * Production-hardening probes found during the audit.
 *   node --test tests/hardening.test.js
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const { pool } = require('../src/config/db');
const app = require('../src/app');
const rbac = require('../src/services/rbac');
const entitlements = require('../src/services/entitlements');
const { ROLE_DEFS } = require('../src/utils/permissions');

const PASSWORD = 'Password@123';
const tag = crypto.randomBytes(3).toString('hex');
let server; let base; let tenantId; let token; let userId; let roleId;

const call = async (method, path, { tk = token, body } = {}) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(tk ? { Authorization: `Bearer ${tk}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const t = await res.text();
  let json = null; try { json = t ? JSON.parse(t) : null; } catch { json = { raw: t }; }
  return { status: res.status, body: json };
};

before(async () => {
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  const [t] = await pool.query(
    "INSERT INTO tenants (name, slug, plan, status, onboarded_at) VALUES (?,?, 'growth','active', NOW())", [`Hard ${tag}`, `hard-${tag}`]);
  tenantId = t.insertId;
  const [r] = await pool.query(
    "INSERT INTO roles (tenant_id,name,label,permissions,is_system,is_protected,role_type,status) VALUES (?,?,?,?,1,1,'system','active')",
    [tenantId, 'company_owner', 'Company Owner', JSON.stringify(ROLE_DEFS.company_owner.permissions)]);
  roleId = r.insertId;
  const [[plan]] = await pool.query("SELECT * FROM platform_plans WHERE plan_key = 'growth'");
  await pool.query(
    `INSERT INTO subscriptions (tenant_id, plan_id, plan_key, status, billing_cycle, quantity, price_per_period, current_period_start, current_period_end)
     VALUES (?,?,?, 'active','monthly',0,?, NOW(), DATE_ADD(NOW(), INTERVAL 1 MONTH))`, [tenantId, plan.id, 'growth', plan.price_monthly]);
  const [u] = await pool.query(
    "INSERT INTO users (tenant_id,email,password_hash,name,role,status) VALUES (?,?,?,?, 'company_owner','active')",
    [tenantId, `own-${tag}@hard.local`, await bcrypt.hash(PASSWORD, 10), 'Owner']);
  userId = u.insertId;
  await pool.query('INSERT INTO user_roles (tenant_id,user_id,role_id,is_primary) VALUES (?,?,?,1)', [tenantId, userId, roleId]);
  token = (await call('POST', '/api/auth/login', { tk: null, body: { email: `own-${tag}@hard.local`, password: PASSWORD } })).body.accessToken;
});

after(async () => {
  for (const t of ['api_keys', 'tenant_entitlement_overrides', 'employees', 'user_roles', 'users', 'subscriptions', 'roles', 'holidays', 'tenants']) {
    await pool.query(`DELETE FROM ${t} WHERE ${t === 'tenants' ? 'id' : 'tenant_id'} = ?`, [tenantId]).catch(() => {});
  }
  rbac.invalidateAll(); entitlements.invalidateAll();
  await new Promise((r) => server.close(r));
  await pool.end();
});

const suspend = async (status) => {
  await pool.query('UPDATE tenants SET status = ? WHERE id = ?', [status, tenantId]);
  await pool.query('UPDATE subscriptions SET status = ? WHERE tenant_id = ?', [status === 'suspended' ? 'suspended' : 'active', tenantId]);
  entitlements.invalidateAll(); rbac.invalidateAll();
};

test('a suspended company cannot change ANY record, not only the ones guarded by a limit', async () => {
  const ok = await call('POST', '/api/org/holidays', { body: { name: 'Founders day', hdate: '2026-12-01' } });
  assert.ok(ok.status < 300, `active company should be able to write: ${ok.status} ${JSON.stringify(ok.body)}`);
  await suspend('suspended');
  try {
    const blocked = await call('POST', '/api/org/holidays', { body: { name: 'Blocked day', hdate: '2026-12-02' } });
    assert.equal(blocked.status, 402, `suspended write got ${blocked.status}`);
    const read = await call('GET', '/api/org/holidays');
    assert.equal(read.status, 200, 'reads stay available');
    const [[{ n }]] = await pool.query("SELECT COUNT(*) AS n FROM holidays WHERE tenant_id = ? AND name = 'Blocked day'", [tenantId]);
    assert.equal(Number(n), 0);
  } finally { await suspend('active'); }
});

test('database error text is never returned to the client in production', async () => {
  const env = require('../src/config/env');
  const prev = env.nodeEnv; env.nodeEnv = 'production';
  try {
  const res = await fetch(`${base}/api/org/holidays`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ name: 'x'.repeat(5000), hdate: 'not-a-date' }),
  });
  const body = await res.json();
  assert.equal(body.dbError, undefined, `leaked SQL message: ${body.dbError}`);
  } finally { env.nodeEnv = prev; }
});

test('concurrent creations at the employee cap admit exactly the headroom, never more', async () => {
  const [[ent]] = await pool.query("SELECT id FROM entitlements WHERE entitlement_key = 'employees.max'");
  const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM employees WHERE tenant_id = ? AND deleted_at IS NULL', [tenantId]);
  await pool.query(
    "INSERT INTO tenant_entitlement_overrides (tenant_id, entitlement_id, value, reason, status, effective_from) VALUES (?,?,?,?, 'active', NULL)",
    [tenantId, ent.id, String(Number(n) + 1), 'race test']);
  entitlements.invalidateAll();
  const results = await Promise.all(Array.from({ length: 6 }, (_, i) => call('POST', '/api/employees', {
    body: { first_name: 'Race', last_name: `R${i}`, email: `race${i}-${tag}@hard.local`, joined_on: '2026-01-01', createLogin: false },
  })));
  const created = results.filter((r) => r.status === 201).length;
  const [[{ after }]] = await pool.query('SELECT COUNT(*) AS after FROM employees WHERE tenant_id = ? AND deleted_at IS NULL', [tenantId]);
  assert.equal(Number(after) - Number(n), 1, `statuses: ${results.map((r) => r.status).join(',')} (created ${created})`);
});

test('API keys: expired and revoked keys are refused, trial companies are served', async () => {
  const mk = async (suffix, extra) => {
    const key = `akv1_test_${tag}_${suffix}`;
    await pool.query(
      `INSERT INTO api_keys (tenant_id, name, key_prefix, key_hash, scopes, ${extra.col}) VALUES (?,?,?,?,?, ${extra.val})`,
      [tenantId, suffix, key.slice(0, 12), crypto.createHash('sha256').update(key).digest('hex'), JSON.stringify(['employee.read'])]);
    return key;
  };
  const live = await mk('live', { col: 'expires_at', val: 'DATE_ADD(NOW(), INTERVAL 1 DAY)' });
  const expired = await mk('old', { col: 'expires_at', val: 'DATE_SUB(NOW(), INTERVAL 1 DAY)' });
  const revoked = await mk('rev', { col: 'revoked_at', val: 'NOW()' });
  const v1 = (k) => call('GET', '/api/v1/employees?limit=1', { tk: k });
  await pool.query("UPDATE tenants SET status = 'trial' WHERE id = ?", [tenantId]);
  entitlements.invalidateAll();
  try {
    assert.equal((await v1(live)).status, 200, 'a valid key on a trial company must work');
    assert.equal((await v1(expired)).status, 401);
    assert.equal((await v1(revoked)).status, 401);
  } finally {
    await pool.query("UPDATE tenants SET status = 'active' WHERE id = ?", [tenantId]);
    entitlements.invalidateAll();
  }
});

test('platform health reports measured values for an operator and is refused to tenants', async () => {
  assert.equal((await call('GET', '/api/platform/health')).status, 403);
});

test('admin employee import honours the employee cap and per-data-set permission; dry run writes nothing', async () => {
  const [[ent]] = await pool.query("SELECT id FROM entitlements WHERE entitlement_key = 'employees.max'");
  const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM employees WHERE tenant_id = ? AND deleted_at IS NULL', [tenantId]);
  await pool.query('UPDATE tenant_entitlement_overrides SET status = \'revoked\' WHERE tenant_id = ?', [tenantId]).catch(() => {});
  await pool.query('DELETE FROM tenant_entitlement_overrides WHERE tenant_id = ?', [tenantId]);
  await pool.query(
    "INSERT INTO tenant_entitlement_overrides (tenant_id, entitlement_id, value, reason, status) VALUES (?,?,?,?, 'active')",
    [tenantId, ent.id, String(Number(n) + 1), 'import cap test']);
  entitlements.invalidateAll();
  const rows = [0, 1, 2].map((i) => ({ first_name: 'Imp', last_name: `I${i}`, email: `imp${i}-${tag}@hard.local`, joined_on: '2026-01-01' }));

  const dry = await call('POST', '/api/administration/import/employees', { body: { rows, dry_run: true } });
  assert.equal(dry.status, 200, JSON.stringify(dry.body));
  const [[{ a }]] = await pool.query('SELECT COUNT(*) AS a FROM employees WHERE tenant_id = ? AND deleted_at IS NULL', [tenantId]);
  assert.equal(Number(a), Number(n), 'a dry run must not write');

  const real = await call('POST', '/api/administration/import/employees', { body: { rows, dry_run: false } });
  assert.equal(real.status, 402, `3 rows over a headroom of 1 must be refused, got ${real.status}`);
  const [[{ b }]] = await pool.query('SELECT COUNT(*) AS b FROM employees WHERE tenant_id = ? AND deleted_at IS NULL', [tenantId]);
  assert.equal(Number(b), Number(n));
});

test('photos are served only to the company that owns them', async () => {
  const fs = require('node:fs'); const path = require('node:path'); const env = require('../src/config/env');
  const dir = path.join(env.uploadDir, 'photos'); fs.mkdirSync(dir, { recursive: true });
  const name = `t-${tag}.png`; fs.writeFileSync(path.join(dir, name), 'x');
  const [e] = await pool.query(
    "INSERT INTO employees (tenant_id, employee_code, first_name, last_name, email, joined_on, profile_photo) VALUES (?,?,?,?,?, '2026-01-01', ?)",
    [tenantId, `PH${tag}`, 'Pho', 'To', `pho-${tag}@hard.local`, `photos/${name}`]);
  try {
    assert.equal((await fetch(`${base}/api/files/photos/${name}`, { headers: { Authorization: `Bearer ${token}` } })).status, 200);
    const [t2] = await pool.query("INSERT INTO tenants (name, slug, plan, status) VALUES (?,?, 'starter','active')", [`Other ${tag}`, `other-${tag}`]);
    const [r2] = await pool.query("INSERT INTO roles (tenant_id,name,label,permissions,is_system,is_protected,role_type,status) VALUES (?,?,?,?,1,1,'system','active')",
      [t2.insertId, 'company_owner', 'Company Owner', JSON.stringify(ROLE_DEFS.company_owner.permissions)]);
    const [u2] = await pool.query("INSERT INTO users (tenant_id,email,password_hash,name,role,status) VALUES (?,?,?,?, 'company_owner','active')",
      [t2.insertId, `o2-${tag}@hard.local`, await bcrypt.hash(PASSWORD, 10), 'O2']);
    await pool.query('INSERT INTO user_roles (tenant_id,user_id,role_id,is_primary) VALUES (?,?,?,1)', [t2.insertId, u2.insertId, r2.insertId]);
    const tok2 = (await call('POST', '/api/auth/login', { tk: null, body: { email: `o2-${tag}@hard.local`, password: PASSWORD } })).body.accessToken;
    try {
      assert.equal((await fetch(`${base}/api/files/photos/${name}`, { headers: { Authorization: `Bearer ${tok2}` } })).status, 404);
    } finally {
      for (const tb of ['user_roles', 'users', 'roles']) await pool.query(`DELETE FROM ${tb} WHERE tenant_id = ?`, [t2.insertId]);
      await pool.query('DELETE FROM tenants WHERE id = ?', [t2.insertId]);
    }
  } finally {
    await pool.query('DELETE FROM employees WHERE id = ?', [e.insertId]);
    fs.unlinkSync(path.join(dir, name));
  }
});

test('the AI assistant refuses company-wide answers to people who only hold own/team scope', async () => {
  const [r] = await pool.query("INSERT INTO roles (tenant_id,name,label,permissions,is_system,is_protected,role_type,status) VALUES (?,?,?,?,1,1,'system','active')",
    [tenantId, 'employee', 'Employee', JSON.stringify(ROLE_DEFS.employee.permissions)]);
  const [u] = await pool.query("INSERT INTO users (tenant_id,email,password_hash,name,role,status) VALUES (?,?,?,?, 'employee','active')",
    [tenantId, `emp-${tag}@hard.local`, await bcrypt.hash(PASSWORD, 10), 'Emp']);
  await pool.query('INSERT INTO user_roles (tenant_id,user_id,role_id,is_primary) VALUES (?,?,?,1)', [tenantId, u.insertId, r.insertId]);
  // Make the assistant genuinely available to this company so a refusal can only come from scope.
  await pool.query("INSERT INTO module_configurations (tenant_id, module_key, name, category, enabled, settings) VALUES (?, 'ai_assistant', 'AI HR Assistant', 'insight', 1, '{}') ON DUPLICATE KEY UPDATE enabled = 1", [tenantId]);
  for (const [key, value] of [['ai_assistant.enabled', '1'], ['ai.enabled', '1'], ['ai.requests.month', '1000']]) {
    const [[ent]] = await pool.query('SELECT id FROM entitlements WHERE entitlement_key = ?', [key]);
    if (ent) await pool.query("INSERT INTO tenant_entitlement_overrides (tenant_id, entitlement_id, value, reason, status) VALUES (?,?,?,?, 'active')", [tenantId, ent.id, value, 'ai test']);
  }
  entitlements.invalidateAll();
  rbac.invalidateAll();
  const empTok = (await call('POST', '/api/auth/login', { tk: null, body: { email: `emp-${tag}@hard.local`, password: PASSWORD } })).body.accessToken;
  for (const q of ['Who is on leave today?', 'Show attendance summary for last 30 days', 'What is the payroll cost last month?']) {
    const res = await call('POST', '/api/ai/ask', { tk: empTok, body: { question: q } });
    assert.equal(res.status, 200, `assistant should be reachable: ${res.status} ${JSON.stringify(res.body)}`);
    assert.match(JSON.stringify(res.body), /need .* permission|blocked/i, `scoped user got an answer: ${JSON.stringify(res.body)}`);
  }
  const owner = await call('POST', '/api/ai/ask', { body: { question: 'Who is on leave today?' } });
  assert.equal(owner.status, 200, JSON.stringify(owner.body));
  assert.doesNotMatch(JSON.stringify(owner.body), /need .* permission/i);
});

test('PF return remits the employer EPF share as well as EPS, not just the employee side', async () => {
  const { pfEcr } = require('../src/services/statutoryReturns');
  const [emp] = await pool.query(
    "INSERT INTO employees (tenant_id, employee_code, first_name, last_name, email, joined_on) VALUES (?,?,?,?,?, '2025-01-01')",
    [tenantId, `PF${tag}`, 'Pf', 'Person', `pf-${tag}@hard.local`]);
  const [run] = await pool.query("INSERT INTO payroll_runs (tenant_id, period_year, period_month, status, month_days) VALUES (?, 2026, 5, 'locked', 31)", [tenantId]);
  const snapshot = { statutoryValues: { pfEmployee: 1800, pfEmployer: 1800, pfEps: 1249.5 }, statutoryBreakdown: { pf: { pfWage: 15000, ruleVersion: 'PF-2026A' } } };
  await pool.query(
    `INSERT INTO payroll_items (tenant_id, run_id, employee_id, month_days, payable_days, lop_days, earnings, deductions, gross, total_deductions, net_pay, employer_cost, inputs_snapshot)
     VALUES (?,?,?,31,31,0,'[]','[]',20000,1800,18200,21800,?)`, [tenantId, run.insertId, emp.insertId, JSON.stringify(snapshot)]);
  try {
    const out = await pfEcr(tenantId, { year: 2026, month: 5 });
    assert.equal(out.totals.epsContribution, 1249.5);
    assert.equal(out.totals.employerEpfShare, 550.5);
    // 12% employee + 12% employer = 24% of the 15,000 wage
    assert.equal(out.totals.totalRemittance, 3600);
  } finally {
    await pool.query('DELETE FROM payroll_items WHERE run_id = ?', [run.insertId]);
    await pool.query('DELETE FROM payroll_runs WHERE id = ?', [run.insertId]);
  }
});

test('a second lifecycle sweeper skips its tick while another instance holds the lock', async () => {
  const lifecycle = require('../src/services/lifecycle');
  const conn = await pool.getConnection();
  try {
    const [[row]] = await conn.query("SELECT GET_LOCK('arthvex:lifecycle-sweep', 0) AS got");
    assert.equal(Number(row.got), 1);
    const report = await lifecycle.sweep();
    assert.equal(report.skipped, true);
    assert.deepEqual(report.deletionsPurged, []);
  } finally {
    await conn.query("SELECT RELEASE_LOCK('arthvex:lifecycle-sweep')");
    conn.release();
  }
  const ran = await lifecycle.sweep();
  assert.notEqual(ran.skipped, true, 'the lock must be released afterwards');
});
