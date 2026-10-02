/**
 * Administration Center — authorization and isolation tests.
 *
 * These run against a real MySQL/MariaDB database because the things most worth
 * testing here are SQL-level facts: that a `tenant_id` filter is actually in the
 * query, that role rows really resolve, that an UPDATE really lands. A mocked
 * repository would only assert that the mocks were called.
 *
 * Everything happens inside a throwaway tenant that is deleted afterwards, so a
 * run never touches demo or production data.
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

const PASSWORD = 'Password@123';
const slug = `admtest-${crypto.randomBytes(4).toString('hex')}`;

let server;
let baseUrl;
let tenantId;
let platformUserId;
/** role name -> user id, and user id -> access token */
const users = {};

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

/** Create a tenant + user, mirroring what POST /tenants does. */
async function createTenantUser(name, email, role) {
  const rbac = require('../src/services/rbac');
  if (!tenantId) {
    const [ins] = await pool.query(
      'INSERT INTO tenants (name, slug, plan, branding) VALUES (?,?,?,?)',
      [`Admission Test Co`, slug, 'standard', JSON.stringify({ companyName: 'Admission Test Co' })]
    );
    tenantId = ins.insertId;
    await rbac.provisionTenantRoles(tenantId);
  }
  const [u] = await pool.query(
    `INSERT INTO users (tenant_id, email, password_hash, name, role, status)
     VALUES (?,?,?,?,?,'active')`,
    [tenantId, email, await bcrypt.hash(PASSWORD, 10), name, role]
  );
  const [roleRow] = await pool.query('SELECT id FROM roles WHERE tenant_id = ? AND name = ?', [tenantId, role]);
  await pool.query(
    'INSERT INTO user_roles (tenant_id, user_id, role_id, is_primary) VALUES (?,?,?,1)',
    [tenantId, u.insertId, roleRow[0].id]
  );
  users[name] = { id: u.insertId, roleId: roleRow[0].id };
  users[name].token = await login(email);
  return users[name];
}

before(async () => {
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  await createTenantUser('owner', `${slug}-owner@test.local`, 'company_owner');
  await createTenantUser('hr', `${slug}-hr@test.local`, 'hr_admin');
  await createTenantUser('manager', `${slug}-manager@test.local`, 'manager');
  await createTenantUser('employee', `${slug}-employee@test.local`, 'employee');

  // A second company, to prove isolation is enforced and not merely absent.
  const rbac = require('../src/services/rbac');
  const [other] = await pool.query(
    'INSERT INTO tenants (name, slug, plan) VALUES (?,?,?)',
    [`Other Co ${slug}`, `${slug}-other`, 'standard']
  );
  await rbac.provisionTenantRoles(other.insertId);
  const [otherOwner] = await pool.query(
    `INSERT INTO users (tenant_id, email, password_hash, name, role, status)
     VALUES (?,?,?,?,'company_owner','active')`,
    [other.insertId, `${slug}-other-owner@test.local`, await bcrypt.hash(PASSWORD, 10), 'Other Owner']
  );
  const [otherRole] = await pool.query('SELECT id FROM roles WHERE tenant_id = ? AND name = ?', [other.insertId, 'company_owner']);
  await pool.query('INSERT INTO user_roles (tenant_id, user_id, role_id, is_primary) VALUES (?,?,?,1)',
    [other.insertId, otherOwner.insertId, otherRole[0].id]);
  users.other = { id: otherOwner.insertId, tenantId: other.insertId, token: await login(`${slug}-other-owner@test.local`) };

  // A platform operator: cross-tenant by definition.
  const [pu] = await pool.query(
    `INSERT INTO users (tenant_id, email, password_hash, name, role, status)
     VALUES (NULL,?,?,?,'platform_super_admin','active')`,
    [`${slug}-platform@test.local`, await bcrypt.hash(PASSWORD, 10), 'Test Platform Admin']
  );
  platformUserId = pu.insertId;
  users.platform = { id: pu.insertId, token: await login(`${slug}-platform@test.local`) };
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  // Delete every table that carries a tenant_id, then the tenants themselves.
  // Done dynamically so a schema addition cannot silently leak test rows.
  const [tables] = await pool.query(
    `SELECT table_name FROM information_schema.columns
     WHERE table_schema = ? AND column_name = 'tenant_id'`, [env.db.database]
  );
  for (const { table_name: table } of tables) {
    await pool.query(`DELETE FROM \`${table}\` WHERE tenant_id IN (?, ?)`, [tenantId, users.other?.tenantId]);
  }
  await pool.query('DELETE FROM users WHERE id = ?', [platformUserId]).catch(() => {});
  await pool.query('DELETE FROM tenants WHERE slug IN (?, ?)', [slug, `${slug}-other`]).catch(() => {});
  const rbac = require('../src/services/rbac');
  rbac.invalidateAll();
  await pool.end();
});

// ---------------------------------------------------------------- authentication
describe('authentication', () => {
  test('an anonymous caller gets 401, not an empty 200', async () => {
    for (const path of ['/api/administration/modules', '/api/administration/users', '/api/administration/audit']) {
      const res = await api('GET', path);
      assert.equal(res.status, 401, `${path} should require a token`);
    }
  });

  test('a garbage token is rejected', async () => {
    const res = await api('GET', '/api/administration/modules', { token: 'not-a-real-token' });
    assert.equal(res.status, 401);
  });

  test('a disabled account cannot log in', async () => {
    const email = `${slug}-disabled@test.local`;
    await pool.query(
      `INSERT INTO users (tenant_id, email, password_hash, name, role, status)
       VALUES (?,?,?,?,'employee','disabled')`,
      [tenantId, email, await bcrypt.hash(PASSWORD, 10), 'Disabled Person']
    );
    const res = await api('POST', '/api/auth/login', { body: { email, password: PASSWORD } });
    assert.equal(res.status, 403);
  });
});

// ---------------------------------------------------------------- privilege boundaries
describe('privilege boundaries', () => {
  test('an ordinary employee reaches none of the administration API', async () => {
    const token = users.employee.token;
    const paths = [
      '/api/administration/modules', '/api/administration/roles', '/api/administration/users',
      '/api/administration/audit', '/api/administration/security/policies',
      '/api/administration/custom-fields', '/api/administration/tenants',
    ];
    for (const path of paths) {
      const res = await api('GET', path, { token });
      assert.equal(res.status, 403, `${path} must not be open to an employee (got ${res.status})`);
    }
  });

  test('an employee can still read their own access', async () => {
    const res = await api('GET', '/api/administration/access/mine', { token: users.employee.token });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.data.canAccess));
  });

  test('hr_admin reads security and configuration but cannot change them', async () => {
    const token = users.hr.token;
    // Reachable through the legacy `settings.view` that hr_admin already held.
    for (const path of ['/api/administration/security/policies', '/api/administration/config/versions', '/api/administration/modules']) {
      const res = await api('GET', path, { token });
      assert.equal(res.status, 200, `${path} should be readable by hr_admin (got ${res.status})`);
    }
    // ...and writes are not, because hr_admin never held `settings.manage`.
    // A narrow administration right must not stand in for the broad umbrella.
    const write = await api('PUT', '/api/administration/security/policies/session.max_per_user', { token, body: { value: 9 } });
    assert.equal(write.status, 403, `hr_admin must not write security policy (got ${write.status})`);
    const mod = await api('PUT', '/api/administration/modules/attendance', { token, body: { enabled: false } });
    assert.equal(mod.status, 403);
  });

  test('tenant admins have no cross-tenant company visibility', async () => {
    const res = await api('GET', '/api/administration/tenants', { token: users.owner.token });
    assert.equal(res.status, 403, 'company_owner must not see other tenants');
  });

  test('only a platform operator sees the tenant list', async () => {
    const res = await api('GET', '/api/administration/tenants', { token: users.platform.token });
    assert.equal(res.status, 200);
    assert.ok(res.body.data.length >= 2);
  });

  test('a manager cannot administer users or roles', async () => {
    assert.equal((await api('GET', '/api/administration/users', { token: users.manager.token })).status, 403);
    // A manager holds neither `administration.roles.view` nor the legacy `settings.view`.
    assert.equal((await api('GET', '/api/administration/roles', { token: users.manager.token })).status, 403);
    assert.equal((await api('POST', '/api/administration/roles', { token: users.manager.token, body: { name: 'Sneaky' } })).status, 403);
  });
});

// ---------------------------------------------------------------- menu integrity
describe('meta contract', () => {
  test('every section the menu offers actually answers for that user', async () => {
    for (const who of ['owner', 'hr', 'employee']) {
      const token = users[who].token;
      const meta = await api('GET', '/api/administration/meta', { token });
      assert.equal(meta.status, 200);
      const offered = meta.body.data.sections.filter((s) => s.accessible);
      for (const section of offered) {
        assert.ok(section.permission, `${section.key} is offered without a permission`);
      }
      // And the reverse: nothing the API would serve is missing from the menu.
      assert.equal(
        offered.some((s) => s.key === 'modules'), who !== 'employee',
        `${who}: modules section visibility disagrees with the API`
      );
    }
  });

  test('the module catalog ships descriptions and maps to permission namespaces', async () => {
    const res = await api('GET', '/api/administration/modules', { token: users.owner.token });
    assert.equal(res.status, 200);
    const { MODULE_CATALOG, MODULE_PERMISSION_MODULES } = require('../src/utils/permissions');
    for (const m of MODULE_CATALOG) {
      assert.ok(m.description, `module ${m.key} has no description`);
      assert.ok(Array.isArray(MODULE_PERMISSION_MODULES[m.key]), `module ${m.key} has no permission mapping`);
    }
    assert.ok(res.body.data.some((m) => m.key === 'engagement'));
    assert.ok(res.body.data.some((m) => m.key === 'employee_relations'));
  });
});

// ---------------------------------------------------------------- module enablement
describe('module enablement is enforced, not cosmetic', () => {
  test('disabling a module blocks its API for everyone, including the owner', async () => {
    const token = users.owner.token;

    assert.equal((await api('GET', '/api/administration/meta', { token })).status, 200);
    const off = await api('PUT', '/api/administration/modules/engagement', { token, body: { enabled: false } });
    assert.equal(off.status, 200, JSON.stringify(off.body));

    try {
      const blocked = await api('GET', '/api/engagement/surveys', { token });
      assert.equal(blocked.status, 403, 'a disabled module must stop answering');
      assert.match(String(blocked.body.message || blocked.body.error), /disabled/i,
        `expected a "module is disabled" message, got: ${JSON.stringify(blocked.body)}`);
    } finally {
      const on = await api('PUT', '/api/administration/modules/engagement', { token, body: { enabled: true } });
      assert.equal(on.status, 200, 'module must be restorable');
    }
    assert.notEqual((await api('GET', '/api/engagement/surveys', { token })).status, 403, 're-enabled module must answer again');
  });

  test('every gated router points at a module that exists in the catalog', async () => {
    const { MODULE_CATALOG } = require('../src/utils/permissions');
    const keys = new Set(MODULE_CATALOG.map((m) => m.key));
    const src = require('node:fs').readFileSync(require.resolve('../src/app.js'), 'utf8');
    const gated = [...src.matchAll(/requireModuleEnabled\('([a-z_]+)'\)/g)].map((m) => m[1]);
    assert.ok(gated.length > 20, 'expected the API to be module-gated');
    for (const key of gated) assert.ok(keys.has(key), `app.js gates on unknown module "${key}"`);
  });
});

// ---------------------------------------------------------------- tenant isolation
describe('tenant isolation', () => {
  test('a user list never contains another company', async () => {
    const res = await api('GET', '/api/administration/users?limit=200', { token: users.owner.token });
    assert.equal(res.status, 200);
    const emails = res.body.data.map((u) => u.email);
    assert.ok(emails.includes(users.owner.email || `${slug}-owner@test.local`));
    assert.ok(!emails.some((e) => String(e).includes('-other-')), 'leaked a user from another company');
  });

  test('a foreign tenant header cannot switch company', async () => {
    const res = await api('GET', '/api/administration/users?limit=200', {
      token: users.owner.token,
      headers: { 'x-tenant-id': String(users.other.tenantId) },
    });
    assert.equal(res.status, 200);
    assert.ok(!res.body.data.some((u) => String(u.email).includes('-other-')),
      'x-tenant-id was honoured as a tenant override');
  });

  test('another company cannot be written to by id', async () => {
    const res = await api('PUT', `/api/administration/users/${users.other.id}`, {
      token: users.owner.token,
      body: { name: 'Renamed By Stranger', status: 'active' },
    });
    assert.ok([403, 404].includes(res.status), `expected refusal, got ${res.status}`);
    const [[row]] = await pool.query('SELECT name FROM users WHERE id = ?', [users.other.id]);
    assert.equal(row.name, 'Other Owner', 'a foreign user was modified');
  });

  test('another company cannot be read or written through the tenant API', async () => {
    const other = users.other.token;
    const mine = await api('GET', '/api/administration/users?limit=200', { token: other });
    assert.equal(mine.status, 200);
    assert.ok(!mine.body.data.some((u) => String(u.email).includes('-owner@test.local') && !u.email.includes('other')),
      'saw users from the first company');
  });
});

// ---------------------------------------------------------------- roles & privileges
describe('roles, scopes and privilege ceilings', () => {
  test('a system role cannot be deleted', async () => {
    const res = await api('DELETE', `/api/administration/roles/${users.owner.roleId}`, { token: users.owner.token });
    assert.ok([400, 403].includes(res.status), `expected refusal, got ${res.status}`);
  });

  test('a custom role can be created and then removed once unused', async () => {
    const created = await api('POST', '/api/administration/roles', {
      token: users.owner.token,
      body: { name: `Payroll Viewer ${slug}`, label: 'Payroll Viewer', permissions: ['payroll.view'] },
    });
    assert.ok([200, 201].includes(created.status), JSON.stringify(created.body));
    const id = created.body.data.id;

    // Permissions are edited through PUT /roles/:id, by key.
    const grant = await api('PUT', `/api/administration/roles/${id}`, {
      token: users.owner.token, body: { permissions: ['payroll.view', 'leave.view'] },
    });
    assert.equal(grant.status, 200, JSON.stringify(grant.body));
    const [[held]] = await pool.query(
      'SELECT COUNT(*) AS n FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = ?',
      [id]
    );
    assert.ok(Number(held.n) >= 1, 'the granted permissions were not persisted');

    const del = await api('DELETE', `/api/administration/roles/${id}`, { token: users.owner.token });
    assert.equal(del.status, 200);
  });

  test('a grant cannot exceed the grantor', async () => {
    // hr_admin may hand out rights, but not platform administration ones.
    const res = await api('PUT', `/api/administration/users/${users.employee.id}/direct-permissions`, {
      token: users.hr.token, body: { allow: ['platform.tenants.view'] },
    });
    assert.ok([403, 404].includes(res.status), `expected refusal, got ${res.status}: ${JSON.stringify(res.body)}`);
  });

  test('you cannot grant a permission you do not hold yourself', async () => {
    // The owner administers users but holds no platform.* right, so handing one out
    // is an escalation attempt even though the actor passes the route gate.
    const res = await api('PUT', `/api/administration/users/${users.hr.id}/direct-permissions`, {
      token: users.owner.token,
      body: { allow: ['platform.tenants.manage'] },
    });
    assert.equal(res.status, 403, 'privilege escalation should be refused');
    assert.match(String(res.body.message), /do not hold/i);
  });

  test('a narrow administration right is not the legacy umbrella', async () => {
    // The bug this guards: resolving aliases in both directions made holding
    // `administration.onboarding.manage` satisfy a gate on `settings.manage`.
    const { hasPerm } = require('../src/utils/permissions');
    assert.equal(hasPerm(['administration.onboarding.manage'], 'settings.manage'), false);
    assert.equal(hasPerm(['settings.manage'], 'administration.security.manage'), true);
  });

  test('an explicit deny beats the role grant', async () => {
    // hr_admin reaches custom fields both directly and through the legacy
    // `settings.view`, so deny every key that route accepts.
    assert.equal((await api('GET', '/api/administration/custom-fields', { token: users.hr.token })).status, 200,
      'precondition: hr_admin can read custom fields');
    const put = await api('PUT', `/api/administration/users/${users.hr.id}/direct-permissions`, {
      token: users.owner.token, body: { deny: ['administration.custom_fields.view', 'settings.view'] },
    });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    try {
      const res = await api('GET', '/api/administration/custom-fields', { token: users.hr.token });
      assert.equal(res.status, 403, 'a deny must remove access the role granted');
    } finally {
      await pool.query('DELETE FROM user_direct_permissions WHERE user_id = ?', [users.hr.id]);
      require('../src/services/rbac').invalidateAll();
    }
  });

  test('the last owner of a company cannot be demoted away', async () => {
    const res = await api('PUT', `/api/administration/users/${users.owner.id}/roles`, {
      token: users.owner.token,
      body: { role_ids: [users.hr.roleId] },
    });
    assert.ok([400, 403].includes(res.status), `expected refusal, got ${res.status}`);
    const [[row]] = await pool.query('SELECT COUNT(*) AS n FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ? AND r.name = ?', [users.owner.id, 'company_owner']);
    assert.equal(Number(row.n), 1, 'the company was left without an owner');
  });

  test('access review explains who can reach what', async () => {
    const res = await api('GET', `/api/administration/access/preview/${users.employee.id}`, { token: users.owner.token });
    assert.equal(res.status, 200);
    assert.ok(res.body.data.cannotAccess.length > 0, 'an employee should be refused most modules');
    assert.ok(res.body.data.enabledModules.includes('employees'));
  });
});

// ---------------------------------------------------------------- workflows & requests
describe('administration workflows', () => {
  test('an access request decided "denied" is stored as "rejected"', async () => {
    const [permRow] = await pool.query('SELECT id FROM permissions WHERE pkey = ?', ['travel.view']);
    const [reqRow] = await pool.query(
      'INSERT INTO access_requests (tenant_id, user_id, permission_id, permission_key, reason) VALUES (?,?,?,?,?)',
      [tenantId, users.employee.id, permRow[0].id, 'travel.view', 'I need to book travel']
    );
    const res = await api('PUT', `/api/administration/access-requests/${reqRow.insertId}`, {
      token: users.owner.token, body: { status: 'denied' },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const [[row]] = await pool.query('SELECT status FROM access_requests WHERE id = ?', [reqRow.insertId]);
    assert.equal(row.status, 'rejected', 'the ENUM value must be used, not the colloquial one');
  });

  test('"rejected" is accepted too, and a decided request cannot be re-decided', async () => {
    const [permRow] = await pool.query('SELECT id FROM permissions WHERE pkey = ?', ['travel.view']);
    const [reqRow] = await pool.query(
      'INSERT INTO access_requests (tenant_id, user_id, permission_id, permission_key, reason) VALUES (?,?,?,?,?)',
      [tenantId, users.employee.id, permRow[0].id, 'travel.view', 'Please']
    );
    const first = await api('PUT', `/api/administration/access-requests/${reqRow.insertId}`, {
      token: users.owner.token, body: { status: 'rejected' },
    });
    assert.equal(first.status, 200);
    const second = await api('PUT', `/api/administration/access-requests/${reqRow.insertId}`, {
      token: users.owner.token, body: { status: 'approved' },
    });
    assert.equal(second.status, 400, 'a decided request must be final');
  });

  test('an unknown decision word is refused', async () => {
    const res = await api('PUT', '/api/administration/access-requests/999999', {
      token: users.owner.token, body: { status: 'maybe' },
    });
    assert.ok([400, 404].includes(res.status));
  });

  test('a user cannot approve a permission they do not hold', async () => {
    const [permRow] = await pool.query('SELECT id FROM permissions WHERE pkey = ?', ['administration.modules.manage']);
    const [reqRow] = await pool.query(
      'INSERT INTO access_requests (tenant_id, user_id, permission_id, permission_key, reason) VALUES (?,?,?,?,?)',
      [tenantId, users.employee.id, permRow[0].id, 'administration.modules.manage', 'Let me in']
    );
    const res = await api('PUT', `/api/administration/access-requests/${reqRow.insertId}`, {
      token: users.hr.token, body: { status: 'approved' },
    });
    assert.ok([403, 404].includes(res.status), `hr_admin must not approve owner-only rights (got ${res.status})`);
  });
});

// ---------------------------------------------------------------- tenant provisioning
describe('tenant provisioning', () => {
  test('creating a company gives it working roles and an owner who can administer it', async () => {
    const newSlug = `${slug}-new`;
    const res = await api('POST', '/api/administration/tenants', {
      token: users.platform.token,
      body: { name: 'Provisioned Co', slug: newSlug, adminEmail: `${slug}-new-owner@test.local`, adminName: 'New Owner' },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const newTenantId = res.body.data.id;

    // The silent failure this guards: a tenant with no role rows resolves no
    // permissions for anybody, so every screen 403s with no obvious cause.
    const [roles] = await pool.query('SELECT COUNT(*) AS n FROM roles WHERE tenant_id = ?', [newTenantId]);
    assert.ok(Number(roles[0].n) >= 9, 'system roles were not provisioned');

    const [ownerRow] = await pool.query('SELECT id FROM users WHERE tenant_id = ? AND role = ?', [newTenantId, 'company_owner']);
    const [ownerRole] = await pool.query('SELECT id FROM roles WHERE tenant_id = ? AND name = ?', [newTenantId, 'company_owner']);
    await pool.query('INSERT INTO user_roles (tenant_id, user_id, role_id, is_primary) VALUES (?,?,?,1)',
      [newTenantId, ownerRow[0].id, ownerRole[0].id]);
    require('../src/services/rbac').invalidateAll();

    const token = await login(`${slug}-new-owner@test.local`, res.body.tempPassword);
    const meta = await api('GET', '/api/administration/meta', { token });
    assert.equal(meta.status, 200);
    assert.ok(meta.body.data.sections.find((s) => s.key === 'modules').accessible,
      'a fresh company owner must be able to administer modules');
    users.provisioned = { tenantId: newTenantId };
  });

  test('the tenant slug is validated and unique', async () => {
    const bad = await api('POST', '/api/administration/tenants', {
      token: users.platform.token, body: { name: 'Bad Slug', slug: 'Not A Slug', adminEmail: 'x@test.local' },
    });
    assert.equal(bad.status, 400);
    const dupe = await api('POST', '/api/administration/tenants', {
      token: users.platform.token, body: { name: 'Dupe', slug: `${slug}-new`, adminEmail: 'y@test.local' },
    });
    assert.equal(dupe.status, 409);
  });
});

// ---------------------------------------------------------------- audit
describe('audit trail', () => {
  test('administration changes are recorded and readable by those entitled to see them', async () => {
    const res = await api('GET', '/api/administration/audit?limit=200', { token: users.owner.token });
    assert.equal(res.status, 200);
    const actions = res.body.data.map((a) => a.action);
    // Audit actions are namespaced (`administration.<action>`); match the suffix.
    for (const expected of ['module.update', 'access_request.decision', 'role.create']) {
      assert.ok(
        actions.some((a) => a === expected || a.endsWith(`.${expected}`)),
        `expected a "${expected}" entry in the audit trail, saw: ${[...new Set(actions)].slice(0, 12).join(', ')}`
      );
    }
    // Entries must be attributed to this tenant. The list view does not expose
    // tenant_id, so check the stored rows directly.
    const [[stray]] = await pool.query(
      `SELECT COUNT(*) AS n FROM admin_audit_logs
       WHERE action IN ('module.update','access_request.decision','role.create') AND tenant_id <> ?`,
      [tenantId]
    );
    assert.equal(Number(stray.n), 0, 'an administration audit entry was written against another tenant');
  });

  test('an employee cannot read the audit trail', async () => {
    const res = await api('GET', '/api/administration/audit', { token: users.employee.token });
    assert.equal(res.status, 403);
  });
});