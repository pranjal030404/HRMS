/**
 * Control-plane operations + cross-surface tenant isolation.
 *
 * Covers what platform-control-plane.test.js does not: platform operators and
 * security policy, the per-company tabs behind Support Access, configuration
 * versioning, the server-side audit export — and, for tenant isolation, the
 * surfaces a direct-ID attacker would actually try: files, search, exports,
 * bulk actions, analytics and workflows.
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
const supportAccess = require('../src/services/supportAccess');
const platformSecurity = require('../src/services/platformSecurity');
const { MODULE_CATALOG, ROLE_DEFS } = require('../src/utils/permissions');

const PASSWORD = 'Password@123';
const slug = `po-${crypto.randomBytes(4).toString('hex')}`;

let server; let baseUrl;
const tenants = {}; const tokens = {}; const users = {};
const cleanupFiles = [];

const api = async (method, urlPath, { token, body } = {}) => {
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  return { status: res.status, body: json, text, headers: res.headers };
};
const login = async (email) => {
  const res = await api('POST', '/api/auth/login', { body: { email, password: PASSWORD } });
  assert.equal(res.status, 200, `login failed for ${email}: ${JSON.stringify(res.body)}`);
  return res.body.accessToken;
};

async function makeTenant(key, planKey = 'growth') {
  const [row] = await pool.query(
    `INSERT INTO tenants (name, slug, plan, status, industry, country, timezone, currency, employee_limit, onboarded_at, branding)
     VALUES (?,?,?, 'active', 'Software','IN','Asia/Kolkata','INR', 200, NOW(), ?)`,
    [`Ops ${key}`, `${slug}-${key}`, planKey, JSON.stringify({ companyName: `Ops ${key}`, primaryColor: '#112233' })]
  );
  const tenantId = row.insertId; tenants[key] = tenantId;
  for (const roleKey of ['company_owner', 'employee']) {
    await pool.query(
      `INSERT INTO roles (tenant_id, name, label, permissions, is_system, is_protected, role_type, status) VALUES (?,?,?,?,1,1,'system','active')`,
      [tenantId, roleKey, ROLE_DEFS[roleKey].label, JSON.stringify(ROLE_DEFS[roleKey].permissions)]
    );
  }
  const [[plan]] = await pool.query('SELECT * FROM platform_plans WHERE plan_key = ?', [planKey]);
  await pool.query(
    `INSERT INTO subscriptions (tenant_id, plan_id, plan_key, status, billing_cycle, quantity, price_per_period, current_period_start, current_period_end)
     VALUES (?,?,?, 'active', 'monthly', 0, ?, NOW(), DATE_ADD(NOW(), INTERVAL 1 MONTH))`,
    [tenantId, plan.id, plan.plan_key, plan.price_monthly]
  );
  for (const m of MODULE_CATALOG) {
    await pool.query(`INSERT INTO module_configurations (tenant_id, module_key, name, category, enabled, settings) VALUES (?,?,?,?,1,'{}')`,
      [tenantId, m.key, m.name, m.category]);
  }
  const [roleRows] = await pool.query('SELECT id, name FROM roles WHERE tenant_id = ?', [tenantId]);
  const email = `owner-${key}@${slug}.local`;
  const [u] = await pool.query(
    `INSERT INTO users (tenant_id, email, password_hash, name, role, status) VALUES (?,?,?,?, 'company_owner', 'active')`,
    [tenantId, email, await bcrypt.hash(PASSWORD, 10), `owner-${key}`]
  );
  await pool.query('INSERT IGNORE INTO user_roles (tenant_id, user_id, role_id, is_primary) VALUES (?,?,?,1)',
    [tenantId, u.insertId, roleRows.find((x) => x.name === 'company_owner').id]);
  users[`${key}:owner`] = u.insertId;
  rbac.invalidateAll(); entitlements.invalidateAll();
  tokens[`${key}:owner`] = await login(email);
  return tenantId;
}

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

const session = (tenantId, accessType, who = 'super') => supportAccess.grant({
  tenantId, reason: 'Automated test of the company console tabs', accessType, durationMinutes: 30,
  actor: { id: users[`platform:${who}`], name: who, role: 'platform_super_admin' }, req: { ip: '127.0.0.1', headers: {} },
});

before(async () => {
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  await makeTenant('a'); await makeTenant('b');
  await makePlatformUser('super', 'platform_super_admin');
  await makePlatformUser('security', 'platform_security_admin');
  await makePlatformUser('auditor', 'platform_auditor');
  await makePlatformUser('billing', 'platform_billing_admin');
  rbac.invalidateAll();
});

after(async () => {
  await platformSecurity.setPolicy({ mfaRequired: false, ipAllowlist: [], sessionMaxHours: 0 }, null).catch(() => {});
  if (server) await new Promise((resolve) => server.close(resolve));
  for (const f of cleanupFiles) { try { fs.unlinkSync(f); } catch { /* already gone */ } }
  const ids = Object.values(tenants);
  const [tables] = await pool.query(`SELECT table_name FROM information_schema.columns WHERE table_schema = ? AND column_name = 'tenant_id'`, [env.db.database]);
  for (const { table_name: table } of tables) await pool.query(`DELETE FROM \`${table}\` WHERE tenant_id IN (?)`, [ids]).catch(() => {});
  await pool.query('DELETE FROM users WHERE email LIKE ?', [`%${slug}%`]).catch(() => {});
  await pool.query('DELETE FROM platform_audit_logs WHERE reason LIKE ? OR entity_type = ?', ['%Automated test%', 'platform_security_policy']).catch(() => {});
  await pool.query('DELETE FROM tenants WHERE slug LIKE ?', [`${slug}-%`]).catch(() => {});
  rbac.invalidateAll(); entitlements.invalidateAll();
  await pool.end();
});

// ============================================================ operators
describe('platform operators', () => {
  let newId;
  test('only a role holding platform.users.manage can create an operator', async () => {
    const body = { name: 'New Op', email: `newop-${slug}@platform.local`, role: 'platform_billing_admin', reason: 'Automated test onboarding' };
    assert.equal((await api('POST', '/api/platform/operators', { token: tokens['platform:billing'], body })).status, 403);
    assert.equal((await api('POST', '/api/platform/operators', { token: tokens['platform:auditor'], body })).status, 403);
    assert.equal((await api('POST', '/api/platform/operators', { token: tokens['a:owner'], body })).status, 403);
    const ok = await api('POST', '/api/platform/operators', { token: tokens['platform:super'], body });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.ok(ok.body.tempPassword);
    newId = ok.body.data.id;
    const [[row]] = await pool.query('SELECT tenant_id, must_change_password FROM users WHERE id = ?', [newId]);
    assert.equal(row.tenant_id, null, 'an operator must never be bound to a company');
    assert.ok(row.must_change_password, 'a temporary password must be changed at first login');
  });

  test('a tenant role cannot be assigned to an operator', async () => {
    const res = await api('POST', '/api/platform/operators', { token: tokens['platform:super'],
      body: { name: 'X', email: `x-${slug}@platform.local`, role: 'company_owner', reason: 'Automated test bad role' } });
    assert.equal(res.status, 400);
  });

  test('an operator cannot disable or demote themselves, and a reason is mandatory', async () => {
    const self = users['platform:super'];
    const res = await api('PATCH', `/api/platform/operators/${self}`, { token: tokens['platform:super'], body: { status: 'disabled', reason: 'Automated test self lock' } });
    assert.equal(res.status, 400);
    const noReason = await api('PATCH', `/api/platform/operators/${newId}`, { token: tokens['platform:super'], body: { status: 'disabled' } });
    assert.equal(noReason.status, 400);
  });

  test('disabling an operator revokes their sessions and is audited', async () => {
    const email = `newop-${slug}@platform.local`;
    await pool.query('UPDATE users SET password_hash = ? WHERE id = ?', [await bcrypt.hash(PASSWORD, 10), newId]);
    await login(email);
    const res = await api('PATCH', `/api/platform/operators/${newId}`, { token: tokens['platform:super'], body: { status: 'disabled', reason: 'Automated test offboarding' } });
    assert.equal(res.status, 200);
    const [[live]] = await pool.query('SELECT COUNT(*) AS n FROM refresh_tokens WHERE user_id = ? AND revoked_at IS NULL', [newId]);
    assert.equal(Number(live.n), 0);
    const refused = await api('POST', '/api/auth/login', { body: { email, password: PASSWORD } });
    assert.equal(refused.status, 403);
    const [a] = await pool.query(`SELECT * FROM platform_audit_logs WHERE action = 'security.operator_disabled' AND entity_id = ?`, [String(newId)]);
    assert.ok(a.length);
  });
});

// ============================================================ platform security
describe('platform security policy', () => {
  test('an auditor can read the security overview but not change policy', async () => {
    // auditor holds *.view only; security.view is included
    const view = await api('GET', '/api/platform/security', { token: tokens['platform:auditor'] });
    assert.equal(view.status, 200);
    assert.equal(view.body.data.sessions.every((s) => !('token_hash' in s)), true, 'token hashes must not be exposed');
    const put = await api('PUT', '/api/platform/security/policy', { token: tokens['platform:auditor'], body: { mfaRequired: false, reason: 'Automated test' } });
    assert.equal(put.status, 403);
  });

  test('an allowlist that would lock out the caller is refused', async () => {
    const res = await api('PUT', '/api/platform/security/policy', { token: tokens['platform:security'],
      body: { ipAllowlist: ['203.0.113.7'], reason: 'Automated test lockout guard' } });
    assert.equal(res.status, 400);
    assert.match(JSON.stringify(res.body), /lock you out/i);
  });

  test('mandatory MFA cannot be switched on by an operator who has not enrolled', async () => {
    const res = await api('PUT', '/api/platform/security/policy', { token: tokens['platform:security'],
      body: { mfaRequired: true, reason: 'Automated test mfa guard' } });
    assert.equal(res.status, 400);
  });

  test('the IP allowlist blocks the console and login, and clearing it restores access', async () => {
    await platformSecurity.setPolicy({ ipAllowlist: ['203.0.113.7'] }, users['platform:security']);
    try {
      const blocked = await api('GET', '/api/platform/dashboard', { token: tokens['platform:super'] });
      assert.equal(blocked.status, 403);
      const loginRes = await api('POST', '/api/auth/login', { body: { email: `super-${slug}@platform.local`, password: PASSWORD } });
      assert.equal(loginRes.status, 403, 'login from a disallowed network must not issue tokens');
      // Tenant users are unaffected: this is a platform-only policy.
      const tenantLogin = await api('POST', '/api/auth/login', { body: { email: `owner-a@${slug}.local`, password: PASSWORD } });
      assert.equal(tenantLogin.status, 200);
    } finally {
      await platformSecurity.setPolicy({ ipAllowlist: [] }, users['platform:security']);
    }
    assert.equal((await api('GET', '/api/platform/dashboard', { token: tokens['platform:super'] })).status, 200);
  });

  test('mandatory MFA stops an un-enrolled operator from using the console', async () => {
    await platformSecurity.setPolicy({ mfaRequired: true }, users['platform:security']);
    try {
      const res = await api('GET', '/api/platform/dashboard', { token: tokens['platform:super'] });
      assert.equal(res.status, 403);
      assert.equal(res.body.code || res.body.details?.code, 'PLATFORM_MFA_ENROLLMENT_REQUIRED');
    } finally {
      await platformSecurity.setPolicy({ mfaRequired: false }, users['platform:security']);
    }
  });

  test('CIDR matching is exact', () => {
    assert.equal(platformSecurity.ipInCidr('10.1.2.3', '10.1.2.0/24'), true);
    assert.equal(platformSecurity.ipInCidr('10.1.3.3', '10.1.2.0/24'), false);
    assert.equal(platformSecurity.ipInCidr('9.9.9.9', '0.0.0.0/0'), true);
    assert.equal(platformSecurity.normaliseCidr('999.1.1.1'), null);
  });

  test('a session can be revoked and the revocation is audited', async () => {
    const [ins] = await pool.query(
      `INSERT INTO refresh_tokens (user_id, token_hash, ip, expires_at) VALUES (?,?,?, DATE_ADD(NOW(), INTERVAL 1 DAY))`,
      [users['platform:billing'], crypto.randomBytes(16).toString('hex'), '127.0.0.1']
    );
    const res = await api('POST', `/api/platform/security/sessions/${ins.insertId}/revoke`, { token: tokens['platform:security'], body: { reason: 'Automated test revoke' } });
    assert.equal(res.status, 200);
    const [[row]] = await pool.query('SELECT revoked_at FROM refresh_tokens WHERE id = ?', [ins.insertId]);
    assert.ok(row.revoked_at);
    // A tenant user's refresh token is not reachable through this endpoint.
    const [t] = await pool.query(`INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES (?,?, DATE_ADD(NOW(), INTERVAL 1 DAY))`,
      [users['a:owner'], crypto.randomBytes(16).toString('hex')]);
    const cross = await api('POST', `/api/platform/security/sessions/${t.insertId}/revoke`, { token: tokens['platform:security'], body: { reason: 'Automated test cross' } });
    assert.equal(cross.status, 404);
  });
});

// ============================================================ audit export
describe('platform audit export', () => {
  test('exports as CSV, neutralises spreadsheet formulas, and is itself audited', async () => {
    const { logPlatformAudit } = require('../src/services/platformAudit');
    await logPlatformAudit({ tenantId: tenants.a, actor: { id: users['platform:super'], name: '=HYPERLINK("http://x","y")' },
      action: 'tenant.export_probe', reason: 'Automated test export row', req: { ip: '127.0.0.1', headers: {} } });
    const res = await api('GET', `/api/platform/audit/export?tenantId=${tenants.a}`, { token: tokens['platform:auditor'] });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/csv/);
    assert.ok(res.text.includes('tenant.export_probe'));
    assert.ok(!/(^|,)"=HYPERLINK/m.test(res.text), 'a leading = must be escaped');
    assert.ok(res.text.includes(`"'=HYPERLINK`));
    const [a] = await pool.query(`SELECT id FROM platform_audit_logs WHERE action = 'security.audit_exported' ORDER BY id DESC LIMIT 1`);
    assert.ok(a.length);
  });

  test('a billing admin cannot export the audit trail', async () => {
    assert.equal((await api('GET', '/api/platform/audit/export', { token: tokens['platform:billing'] })).status, 403);
  });
});

// ============================================================ company tabs
describe('company console tabs sit behind Support Access', () => {
  const tabs = ['users', 'roles', 'security', 'branding', 'domains', 'integrations', 'audit', 'support-access', 'configuration'];

  test('without a session every tab is refused and says why', async () => {
    for (const tab of tabs) {
      const res = await api('GET', `/api/platform/tenants/${tenants.a}/${tab}`, { token: tokens['platform:super'] });
      assert.equal(res.status, 403, `${tab} must require support access`);
      assert.equal(res.body.details?.requiresSupportAccess ?? res.body.requiresSupportAccess, true, tab);
    }
  });

  test('a company administrator cannot open any tab, even for their own company', async () => {
    for (const tab of tabs) {
      const res = await api('GET', `/api/platform/tenants/${tenants.a}/${tab}`, { token: tokens['a:owner'] });
      assert.equal(res.status, 403, `${tab} must be closed to a customer administrator`);
    }
  });

  test('a read-only session reads but cannot write; session for A does not reach B', async () => {
    const s = await session(tenants.a, 'read_only');
    for (const tab of tabs) {
      const res = await api('GET', `/api/platform/tenants/${tenants.a}/${tab}`, { token: tokens['platform:super'] });
      assert.equal(res.status, 200, `${tab}: ${JSON.stringify(res.body)}`);
    }
    const users_ = await api('GET', `/api/platform/tenants/${tenants.a}/users`, { token: tokens['platform:super'] });
    assert.ok(users_.body.data.every((u) => !('password_hash' in u) && !('mfa_secret' in u)), 'secrets must never be selected');
    const write = await api('PUT', `/api/platform/tenants/${tenants.a}/branding`, { token: tokens['platform:super'],
      body: { branding: { primaryColor: '#ff0000' }, reason: 'Automated test read-only write' } });
    assert.equal(write.status, 403);
    const other = await api('GET', `/api/platform/tenants/${tenants.b}/users`, { token: tokens['platform:super'] });
    assert.equal(other.status, 403, 'a session is scoped to one company');
    await supportAccess.revoke(s.id, { reason: 'Automated test done', actor: { id: users['platform:super'] }, req: { ip: '127.0.0.1', headers: {} } });
  });

  test('every tab read is logged under the session', async () => {
    const s = await session(tenants.a, 'read_only');
    await api('GET', `/api/platform/tenants/${tenants.a}/roles`, { token: tokens['platform:super'] });
    await new Promise((r) => setTimeout(r, 150));
    const [logs] = await pool.query('SELECT action FROM support_access_logs WHERE session_id = ?', [s.id]);
    assert.ok(logs.some((l) => /roles/.test(l.action)), 'the read was not recorded');
    await supportAccess.revoke(s.id, { reason: 'Automated test done', actor: { id: users['platform:super'] }, req: { ip: '127.0.0.1', headers: {} } });
  });

  test('branding: validated, versioned, audited — and rollback appends a new version', async () => {
    const s = await session(tenants.a, 'configuration');
    const T = tokens['platform:super'];
    const bad = await api('PUT', `/api/platform/tenants/${tenants.a}/branding`, { token: T, body: { branding: { primaryColor: 'red' }, reason: 'Automated test bad colour' } });
    assert.equal(bad.status, 400);
    const noReason = await api('PUT', `/api/platform/tenants/${tenants.a}/branding`, { token: T, body: { branding: { primaryColor: '#abcdef' } } });
    assert.equal(noReason.status, 400);
    const js = await api('PUT', `/api/platform/tenants/${tenants.a}/branding`, { token: T, body: { branding: { logoUrl: 'javascript:alert(1)' }, reason: 'Automated test bad logo' } });
    assert.equal(js.status, 400, 'a javascript: logo URL must be refused');

    const v1 = await api('PUT', `/api/platform/tenants/${tenants.a}/branding`, { token: T, body: { branding: { primaryColor: '#abcdef' }, reason: 'Automated test first change' } });
    assert.equal(v1.status, 200);
    const v2 = await api('PUT', `/api/platform/tenants/${tenants.a}/branding`, { token: T, body: { branding: { primaryColor: '#fedcba', loginTagline: 'Hello' }, reason: 'Automated test second change' } });
    assert.equal(v2.body.data.configVersion, v1.body.data.configVersion + 1);

    const list = await api('GET', `/api/platform/tenants/${tenants.a}/configuration`, { token: T });
    const rows = list.body.data.filter((c) => c.config_key === 'branding');
    assert.equal(rows.filter((c) => c.status === 'active').length, 1, 'exactly one active version');
    const first = rows.find((c) => c.version === v1.body.data.configVersion);

    const diff = await api('GET', `/api/platform/tenants/${tenants.a}/configuration/${rows.find((c) => c.status === 'active').id}`, { token: T });
    assert.ok(diff.body.data.diff.some((d) => d.path === 'primaryColor' && d.to === '#fedcba' && d.from === '#abcdef'));

    const rb = await api('POST', `/api/platform/tenants/${tenants.a}/configuration/${first.id}/rollback`, { token: T, body: { reason: 'Automated test rollback' } });
    assert.equal(rb.status, 200, JSON.stringify(rb.body));
    assert.equal(rb.body.data.newVersion, v2.body.data.configVersion + 1, 'rollback must append, not rewrite');
    assert.equal(rb.body.data.appliedLive, true);
    const [[live]] = await pool.query('SELECT branding FROM tenants WHERE id = ?', [tenants.a]);
    const b = typeof live.branding === 'string' ? JSON.parse(live.branding) : live.branding;
    assert.equal(b.primaryColor, '#abcdef');
    const [[old]] = await pool.query('SELECT version FROM config_versions WHERE id = ?', [first.id]);
    assert.equal(old.version, v1.body.data.configVersion, 'history is untouched');
    const [aud] = await pool.query(`SELECT before_json, after_json FROM platform_audit_logs WHERE tenant_id = ? AND action = 'config.rolled_back'`, [tenants.a]);
    assert.ok(aud.length);
    await supportAccess.revoke(s.id, { reason: 'Automated test done', actor: { id: users['platform:super'] }, req: { ip: '127.0.0.1', headers: {} } });
  });

  test('a rollback to a version of another company is a 404', async () => {
    const sa = await session(tenants.a, 'configuration');
    const [v] = await pool.query(
      `INSERT INTO config_versions (tenant_id, config_key, module, version, status, config) VALUES (?, 'branding','platform',1,'active','{}')`, [tenants.b]);
    const res = await api('POST', `/api/platform/tenants/${tenants.a}/configuration/${v.insertId}/rollback`, { token: tokens['platform:super'], body: { reason: 'Automated test cross rollback' } });
    assert.equal(res.status, 404);
    await supportAccess.revoke(sa.id, { reason: 'Automated test done', actor: { id: users['platform:super'] }, req: { ip: '127.0.0.1', headers: {} } });
  });

  test('domains: unique across companies, need DNS proof, primary only when verified', async () => {
    const s = await session(tenants.a, 'configuration');
    const sb = await session(tenants.b, 'configuration');
    const T = tokens['platform:super'];
    const host = `hr-${slug}.example.com`;
    assert.equal((await api('POST', `/api/platform/tenants/${tenants.a}/domains`, { token: T, body: { hostname: 'not a host', reason: 'Automated test bad host' } })).status, 400);
    const add = await api('POST', `/api/platform/tenants/${tenants.a}/domains`, { token: T, body: { hostname: host, reason: 'Automated test add domain' } });
    assert.equal(add.status, 201);
    assert.equal(add.body.data.txtRecord.name, `_arthvex-verify.${host}`);
    const dupe = await api('POST', `/api/platform/tenants/${tenants.b}/domains`, { token: T, body: { hostname: host, reason: 'Automated test dupe domain' } });
    assert.equal(dupe.status, 409);
    assert.ok(!JSON.stringify(dupe.body).includes('Ops a'), 'must not reveal the owning company');
    const verify = await api('POST', `/api/platform/tenants/${tenants.a}/domains/${add.body.data.id}/verify`, { token: T, body: {} });
    assert.equal(verify.status, 422, 'an unproven domain must not verify');
    const prim = await api('POST', `/api/platform/tenants/${tenants.a}/domains/${add.body.data.id}/primary`, { token: T, body: { reason: 'Automated test primary' } });
    assert.equal(prim.status, 400);
    // company B cannot touch company A's domain through its own path
    const cross = await api('DELETE', `/api/platform/tenants/${tenants.b}/domains/${add.body.data.id}`, { token: T, body: { reason: 'Automated test cross delete' } });
    assert.equal(cross.status, 404);
    const del = await api('DELETE', `/api/platform/tenants/${tenants.a}/domains/${add.body.data.id}`, { token: T, body: { reason: 'Automated test remove domain' } });
    assert.equal(del.status, 200);
    for (const x of [s, sb]) await supportAccess.revoke(x.id, { reason: 'Automated test done', actor: { id: users['platform:super'] }, req: { ip: '127.0.0.1', headers: {} } });
  });

  test('integrations: secrets never leave, and a leaked key can be revoked with a reason', async () => {
    const s = await session(tenants.a, 'read_only');
    const [k] = await pool.query(`INSERT INTO api_keys (tenant_id, name, key_prefix, key_hash, scopes) VALUES (?, 'ci', 'avx_test', ?, '["employee.read"]')`,
      [tenants.a, crypto.randomBytes(16).toString('hex')]);
    await pool.query(`INSERT INTO webhook_subscriptions (tenant_id, url, secret, events) VALUES (?, 'https://example.test/h', 'supersecret', '["employee.created"]')`, [tenants.a]);
    const res = await api('GET', `/api/platform/tenants/${tenants.a}/integrations`, { token: tokens['platform:super'] });
    assert.equal(res.status, 200);
    const flat = JSON.stringify(res.body);
    assert.ok(!flat.includes('supersecret') && !flat.includes('key_hash'), 'secrets must not be returned');
    const noReason = await api('POST', `/api/platform/tenants/${tenants.a}/integrations/api-keys/${k.insertId}/revoke`, { token: tokens['platform:super'], body: {} });
    assert.equal(noReason.status, 400);
    const ok = await api('POST', `/api/platform/tenants/${tenants.a}/integrations/api-keys/${k.insertId}/revoke`, { token: tokens['platform:super'], body: { reason: 'Automated test leaked key' } });
    assert.equal(ok.status, 200);
    // wrong company in the path
    const [k2] = await pool.query(`INSERT INTO api_keys (tenant_id, name, key_prefix, key_hash, scopes) VALUES (?, 'b', 'avx_b', ?, '[]')`, [tenants.b, crypto.randomBytes(16).toString('hex')]);
    const cross = await api('POST', `/api/platform/tenants/${tenants.a}/integrations/api-keys/${k2.insertId}/revoke`, { token: tokens['platform:super'], body: { reason: 'Automated test cross key' } });
    assert.equal(cross.status, 404);
    await supportAccess.revoke(s.id, { reason: 'Automated test done', actor: { id: users['platform:super'] }, req: { ip: '127.0.0.1', headers: {} } });
  });
});

// ============================================================ cross-surface isolation
describe('tenant isolation holds on every surface, not only the employee detail route', () => {
  let bEmp; let bFileName; let bFull;

  before(async () => {
    const [e] = await pool.query(
      `INSERT INTO employees (tenant_id, employee_code, first_name, last_name, email, joined_on, employment_type, status)
       VALUES (?, 'ISO-B1', 'Zebulon', 'Foreignname', ?, CURDATE(), 'full_time', 'active')`, [tenants.b, `zeb@${slug}.local`]);
    bEmp = e.insertId;
    fs.mkdirSync(path.join(env.uploadDir, 'documents'), { recursive: true });
    bFileName = `iso-${slug}.txt`;
    bFull = path.join(env.uploadDir, 'documents', bFileName);
    fs.writeFileSync(bFull, 'company b confidential', 'utf8');
    cleanupFiles.push(bFull);
    await pool.query(`INSERT INTO company_documents (tenant_id, title, category, file_path, file_size) VALUES (?, 'B secret', 'policy', ?, 22)`,
      [tenants.b, `documents/${bFileName}`]);
  });

  test('search never returns another company\'s people', async () => {
    const res = await api('GET', '/api/employees?q=Zebulon', { token: tokens['a:owner'] });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.length, 0);
    const own = await api('GET', '/api/employees?q=Zebulon', { token: tokens['b:owner'] });
    assert.equal(own.body.data.length, 1, 'sanity: its own company does see them');
  });

  test('a file belongs to one company: its owner reads it, another company\'s owner gets 404', async () => {
    const mine = await api('GET', `/api/files/documents/${bFileName}`, { token: tokens['b:owner'] });
    assert.equal(mine.status, 200);
    assert.equal(mine.text, 'company b confidential');
    const theirs = await api('GET', `/api/files/documents/${bFileName}`, { token: tokens['a:owner'] });
    assert.equal(theirs.status, 404, 'holding document.manage in another company must not open this file');
  });

  test('platform staff need a support session to read a customer file', async () => {
    const denied = await api('GET', `/api/files/documents/${bFileName}`, { token: tokens['platform:super'] });
    assert.equal(denied.status, 403, 'a platform super admin is not a standing route into customer files');
    const s = await session(tenants.b, 'read_only');
    const ok = await api('GET', `/api/files/documents/${bFileName}`, { token: tokens['platform:super'] });
    assert.equal(ok.status, 200);
    await new Promise((r) => setTimeout(r, 150));
    const [logs] = await pool.query('SELECT action FROM support_access_logs WHERE session_id = ?', [s.id]);
    assert.ok(logs.length, 'the file read must be recorded under the session');
    await supportAccess.revoke(s.id, { reason: 'Automated test done', actor: { id: users['platform:super'] }, req: { ip: '127.0.0.1', headers: {} } });
  });

  test('an unreferenced file is not served to anyone', async () => {
    const orphan = path.join(env.uploadDir, 'documents', `orphan-${slug}.txt`);
    fs.writeFileSync(orphan, 'x'); cleanupFiles.push(orphan);
    const res = await api('GET', `/api/files/documents/orphan-${slug}.txt`, { token: tokens['a:owner'] });
    assert.equal(res.status, 404);
  });

  test('CSV export contains only the caller\'s company', async () => {
    const res = await api('GET', '/api/administration/export/employees', { token: tokens['a:owner'] });
    assert.equal(res.status, 200);
    assert.ok(!res.text.includes('Zebulon') && !res.text.includes('ISO-B1'));
    const own = await api('GET', '/api/administration/export/employees', { token: tokens['b:owner'] });
    assert.ok(own.text.includes('Zebulon'));
  });

  test('bulk actions skip records that belong to another company', async () => {
    const res = await api('POST', '/api/administration/bulk/users', { token: tokens['a:owner'],
      body: { ids: [users['b:owner']], operation: 'set_status', value: 'disabled', dry_run: true } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.target, 0);
    assert.deepEqual(res.body.data.skipped, [users['b:owner']]);
    const real = await api('POST', '/api/administration/bulk/users', { token: tokens['a:owner'],
      body: { ids: [users['b:owner']], operation: 'set_status', value: 'disabled' } });
    assert.equal(real.status, 404);
    const [[still]] = await pool.query('SELECT status FROM users WHERE id = ?', [users['b:owner']]);
    assert.equal(still.status, 'active', "company B's owner must be untouched");
  });

  test('analytics and workflows are computed from the caller\'s company only', async () => {
    const a = await api('GET', '/api/analytics/hr', { token: tokens['a:owner'] });
    const b = await api('GET', '/api/analytics/hr', { token: tokens['b:owner'] });
    assert.equal(a.status, 200);
    assert.notEqual(JSON.stringify(a.body), JSON.stringify(b.body), 'different companies, different numbers');
    await pool.query(`INSERT INTO workflows (tenant_id, name, trigger_type, status) VALUES (?, 'B-only flow', 'manual', 'active')`, [tenants.b]).catch(() => {});
    const wf = await api('GET', '/api/workflows', { token: tokens['a:owner'] });
    assert.equal(wf.status, 200);
    assert.ok(!JSON.stringify(wf.body).includes('B-only flow'));
  });

  test('a foreign id on detail, update and delete routes never reaches the row', async () => {
    const get = await api('GET', `/api/employees/${bEmp}`, { token: tokens['a:owner'] });
    assert.equal(get.status, 404);
    const put = await api('PUT', `/api/employees/${bEmp}`, { token: tokens['a:owner'], body: { first_name: 'Hacked' } });
    assert.ok([403, 404].includes(put.status), `update returned ${put.status}`);
    const del = await api('DELETE', `/api/employees/${bEmp}`, { token: tokens['a:owner'] });
    assert.ok([403, 404, 405].includes(del.status), `delete returned ${del.status}`);
    const [[row]] = await pool.query('SELECT first_name, deleted_at FROM employees WHERE id = ?', [bEmp]);
    assert.equal(row.first_name, 'Zebulon');
    assert.equal(row.deleted_at, null);
  });
});
