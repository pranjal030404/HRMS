/**
 * Custom platform roles, company edit, and immediate deletion guards.
 *   node --test tests/platform-roles.test.js
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const { pool } = require('../src/config/db');
const app = require('../src/app');
const rbac = require('../src/services/rbac');

const PASSWORD = 'Password@123';
const tag = crypto.randomBytes(3).toString('hex');
let server; let base; let superToken; let tenantId; let superId; const roleKey = `platform_custom_tester_${tag}`;

const call = async (method, path, { token = superToken, body } = {}) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const t = await res.text();
  return { status: res.status, body: t ? JSON.parse(t) : null };
};
const login = async (email) => (await call('POST', '/api/auth/login', { token: null, body: { email, password: PASSWORD } })).body.accessToken;

before(async () => {
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  const [u] = await pool.query(
    "INSERT INTO users (tenant_id,email,password_hash,name,role,status) VALUES (NULL,?,?,?,'platform_super_admin','active')",
    [`sa-${tag}@platform.local`, await bcrypt.hash(PASSWORD, 10), 'SA']);
  superId = u.insertId;
  superToken = await login(`sa-${tag}@platform.local`);
  const [t] = await pool.query("INSERT INTO tenants (name, slug, plan, status) VALUES (?,?, 'starter','active')", [`Roles ${tag}`, `roles-${tag}`]);
  tenantId = t.insertId;
});

after(async () => {
  await pool.query('DELETE FROM users WHERE tenant_id IS NULL AND (id = ? OR email LIKE ?)', [superId, `%-${tag}@platform.local`]);
  await pool.query('DELETE FROM roles WHERE name = ? AND tenant_id IS NULL', [roleKey]);
  await pool.query('DELETE FROM tenants WHERE id = ?', [tenantId]);
  rbac.invalidateAll();
  await new Promise((r) => server.close(r));
  await pool.end();
});

test('a custom platform role can be created, assigned, and is limited to what it grants', async () => {
  const bad = await call('POST', '/api/platform/roles', { body: { label: 'Bad', permissions: ['employee.view'], reason: 'testing bad perm' } });
  assert.equal(bad.status, 400);

  const made = await call('POST', '/api/platform/roles', {
    body: { label: `Tester ${tag}`, permissions: ['platform.dashboard.view', 'platform.tenants.view'], reason: 'testing creation' } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const key = made.body.data.key;
  assert.equal(key, roleKey);

  const op = await call('POST', '/api/platform/operators', { body: { name: 'Tester', email: `op-${tag}@platform.local`, role: key, reason: 'testing operator' } });
  assert.equal(op.status, 201, JSON.stringify(op.body));
  await pool.query('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE email = ?', [await bcrypt.hash(PASSWORD, 10), `op-${tag}@platform.local`]);
  const opToken = await login(`op-${tag}@platform.local`);

  assert.equal((await call('GET', '/api/platform/tenants', { token: opToken })).status, 200);
  assert.equal((await call('POST', '/api/platform/roles', { token: opToken, body: { label: 'Escalate', permissions: ['platform.users.manage'], reason: 'escalate' } })).status, 403);
  assert.equal((await call('GET', '/api/platform/operators', { token: opToken })).status, 403);

  assert.equal((await call('DELETE', `/api/platform/roles/${key}`, { body: { reason: 'still in use' } })).status, 409);
});

test('built-in roles cannot be edited or deleted', async () => {
  assert.equal((await call('PUT', '/api/platform/roles/platform_auditor', { body: { permissions: ['platform.dashboard.view'], reason: 'nope nope' } })).status, 404);
  assert.equal((await call('DELETE', '/api/platform/roles/platform_auditor', { body: { reason: 'nope nope' } })).status, 404);
});

test('company profile edit requires a reason and applies', async () => {
  assert.equal((await call('PATCH', `/api/platform/tenants/${tenantId}`, { body: { industry: 'Retail' } })).status, 400);
  const ok = await call('PATCH', `/api/platform/tenants/${tenantId}`, { body: { industry: 'Retail', reason: 'profile correction' } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const [[row]] = await pool.query('SELECT industry FROM tenants WHERE id = ?', [tenantId]);
  assert.equal(row.industry, 'Retail');
});

test('immediate deletion needs the slug and the password', async () => {
  const wrongSlug = await call('POST', `/api/platform/tenants/${tenantId}/delete-now`, { body: { reason: 'cleanup of test company', password: PASSWORD, confirmSlug: 'nope' } });
  assert.equal(wrongSlug.status, 400);
  const wrongPw = await call('POST', `/api/platform/tenants/${tenantId}/delete-now`, { body: { reason: 'cleanup of test company', password: 'bad', confirmSlug: `roles-${tag}` } });
  assert.equal(wrongPw.status, 401);
  const ok = await call('POST', `/api/platform/tenants/${tenantId}/delete-now`, { body: { reason: 'cleanup of test company', password: PASSWORD, confirmSlug: `roles-${tag}` } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  // The tenant row stays as a tombstone so the audit trail still has something to point at.
  const [[row]] = await pool.query('SELECT status FROM tenants WHERE id = ?', [tenantId]);
  assert.equal(row.status, 'deleted');
});

test('platform health returns measured values', async () => {
  const res = await call('GET', '/api/platform/health');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.database.ok, true);
  assert.equal(typeof res.body.data.database.latencyMs, 'number');
});

test('a company role can be created from the console only inside a support session', async () => {
  const [t] = await pool.query("INSERT INTO tenants (name, slug, plan, status) VALUES (?,?, 'starter','active')", [`RoleCo ${tag}`, `roleco-${tag}`]);
  const tid = t.insertId;
  try {
    const body = { tenant_id: tid, name: 'Auditors', label: 'Auditors', permissions: ['dashboard.view'] };
    const denied = await call('POST', '/api/administration/roles', { body });
    assert.equal(denied.status, 403, `no session should be refused, got ${denied.status}`);

    const sess = await call('POST', '/api/platform/support-access', {
      body: { tenantId: tid, reason: 'Creating an auditor role on request', accessType: 'configuration', durationMinutes: 15 } });
    assert.equal(sess.status, 201, JSON.stringify(sess.body));

    const made = await call('POST', '/api/administration/roles', { body });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const [[row]] = await pool.query('SELECT tenant_id, is_custom FROM roles WHERE id = ?', [made.body.data.id]);
    assert.equal(Number(row.tenant_id), tid);
    const gone = await call('DELETE', `/api/administration/roles/${made.body.data.id}?tenant_id=${tid}`);
    assert.equal(gone.status, 200, JSON.stringify(gone.body));
  } finally {
    await pool.query('DELETE FROM support_access_log WHERE session_id IN (SELECT id FROM support_access_sessions WHERE tenant_id = ?)', [tid]).catch(() => {});
    await pool.query('DELETE FROM support_access_sessions WHERE tenant_id = ?', [tid]).catch(() => {});
    await pool.query('DELETE FROM roles WHERE tenant_id = ?', [tid]).catch(() => {});
    await pool.query('DELETE FROM tenants WHERE id = ?', [tid]).catch(() => {});
  }
});
