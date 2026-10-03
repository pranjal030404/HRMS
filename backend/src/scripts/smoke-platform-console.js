/**
 * Console smoke check — a DIAGNOSTIC, not a test.
 *
 * The platform console was written against the route file by reading it, which
 * is not the same as having seen the responses. This drives every endpoint the
 * console calls and prints the real shape, so a mismatch shows up as data here
 * rather than as `undefined` in the browser. It has already earned its keep: it
 * caught that the error envelope puts context under `details` and not `extra`,
 * that overrides come back keyed by `entitlement_id`, and that usage status is
 * `hard_limit` and not `exceeded` — all three would have rendered blank.
 *
 * It deliberately does not live under tests/, because it has side effects: it
 * takes a real Support Access session and revokes it, writing audit rows.
 *
 *   npm run smoke:platform
 */
const env = require('../config/env');
const { pool } = require('../config/db');
const app = require('../app');

let server;
let baseUrl;
let token;

const call = async (method, path, body) => {
  const res = await fetch(`${baseUrl}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch (_) {}
  return { status: res.status, body: json };
};

const shape = (v, depth = 0) => {
  if (v === null || v === undefined) return String(v);
  if (Array.isArray(v)) return `[${v.length}] e.g. ${v.length ? JSON.stringify(shape(v[0], depth + 1)) : '—'}`;
  if (typeof v === 'object') {
    return '{' + Object.keys(v).slice(0, 14).join(', ') + (Object.keys(v).length > 14 ? ', …' : '') + '}';
  }
  return typeof v;
};

const show = (label, res) => {
  const ok = res.status < 400;
  console.log(`\n${ok ? '✓' : '✗'} ${label}  →  HTTP ${res.status}`);
  if (ok) {
    const d = res.body?.data;
    console.log(`   data: ${shape(d)}`);
    if (res.body?.meta) console.log(`   meta: ${shape(res.body.meta)}`);
  } else {
    console.log(`   ${JSON.stringify(res.body).slice(0, 300)}`);
  }
};

(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const login = await call('POST', '/auth/login', { email: 'super@platform.arthvex.com', password: 'Platform@123' });
  if (login.status !== 200) {
    console.error('Login failed:', JSON.stringify(login.body));
    console.error('Run `npm run db:reset` first to seed the platform accounts.');
    process.exit(1);
  }
  token = login.body.accessToken;
  console.log('Signed in as super@platform.arthvex.com\n' + '='.repeat(70));

  const me = await call('GET', '/auth/me');
  console.log('/auth/me →', shape(me.body?.data));
  console.log('   isPlatformAdmin:', me.body?.data?.isPlatformAdmin, '| isPlatformSuperAdmin:', me.body?.data?.isPlatformSuperAdmin);

  const dash = await call('GET', '/platform/dashboard');
  show('GET /platform/dashboard', dash);
  if (dash.status < 400) {
    const d = dash.body.data;
    console.log('   tenants:', JSON.stringify(d.tenants).slice(0, 160));
    console.log('   subscriptions:', JSON.stringify(d.subscriptions));
    console.log('   usage keys:', Object.keys(d.usage || {}).length);
    console.log('   recentTenants[0]:', JSON.stringify(d.recentTenants?.[0]));
    console.log('   recentSubscriptionEvents[0]:', JSON.stringify(d.recentSubscriptionEvents?.[0]));
    console.log('   limitBreaches[0]:', JSON.stringify(d.limitBreaches?.[0]));
    console.log('   securityAlerts[0]:', JSON.stringify(d.securityAlerts?.[0]));
    console.log('   integrationFailures[0]:', JSON.stringify(d.integrationFailures?.[0]));
  }

  show('GET /platform/catalog', await call('GET', '/platform/catalog'));
  const cat = await call('GET', '/platform/catalog');
  if (cat.status < 400) {
    console.log('   plans[0]:', JSON.stringify(cat.body.data.plans?.[0]));
    console.log('   modules[0]:', JSON.stringify(cat.body.data.modules?.[0]));
    console.log('   tenantStatuses:', JSON.stringify(cat.body.data.tenantStatuses));
    console.log('   subscriptionStatuses:', JSON.stringify(cat.body.data.subscriptionStatuses));
  }

  show('GET /platform/tenants', await call('GET', '/platform/tenants?limit=5'));
  const tl = await call('GET', '/platform/tenants?limit=5');
  if (tl.status < 400) console.log('   row[0]:', JSON.stringify(tl.body.data?.[0]));

  const tid = tl.body?.data?.[0]?.id;

  show('GET /platform/subscriptions', await call('GET', '/platform/subscriptions?limit=5'));
  const sl = await call('GET', '/platform/subscriptions?limit=5');
  if (sl.status < 400) console.log('   row[0]:', JSON.stringify(sl.body.data?.[0]));

  show('GET /platform/plans', await call('GET', '/platform/plans'));
  const pl = await call('GET', '/platform/plans');
  if (pl.status < 400) {
    console.log('   plan[0]:', JSON.stringify(pl.body.data?.[0]).slice(0, 400));
    console.log('   plan[0].entitlements[0]:', JSON.stringify(pl.body.data?.[0]?.entitlements?.[0]));
  }

  show('GET /platform/entitlements', await call('GET', '/platform/entitlements'));
  const el = await call('GET', '/platform/entitlements');
  if (el.status < 400) {
    console.log('   meta:', JSON.stringify(el.body.meta));
    console.log('   ent[0]:', JSON.stringify(el.body.data?.[0]).slice(0, 400));
  }

  show('GET /platform/usage/breaches', await call('GET', '/platform/usage/breaches'));
  show('GET /platform/support-access', await call('GET', '/platform/support-access?limit=5'));
  show('GET /platform/support-access/mine', await call('GET', '/platform/support-access/mine'));
  show('GET /platform/audit', await call('GET', '/platform/audit?limit=5'));
  const al = await call('GET', '/platform/audit?limit=5');
  if (al.status < 400) console.log('   row[0]:', JSON.stringify(al.body.data?.[0])?.slice(0, 500));

  if (tid) {
    console.log(`\n--- tenant ${tid} (support access required) ---`);
    const denied = await call('GET', `/platform/tenants/${tid}`);
    console.log(`GET /platform/tenants/${tid} without a session → HTTP ${denied.status}`);
    console.log('   ', JSON.stringify(denied.body).slice(0, 300));

    const grant = await call('POST', '/platform/support-access', {
      tenantId: tid, reason: 'console smoke test — verifying response shapes', accessType: 'read_only', durationMinutes: 15,
    });
    show(`POST /platform/support-access (tenant ${tid})`, grant);

    if (grant.status < 400) {
      const sid = grant.body.data.id;
      show('GET /platform/support-access/mine', await call('GET', '/platform/support-access/mine'));
      show(`GET /platform/tenants/${tid}`, await call('GET', `/platform/tenants/${tid}`));
      const td = await call('GET', `/platform/tenants/${tid}`);
      if (td.status < 400) {
        console.log('   modules[0]:', JSON.stringify(td.body.data?.modules?.[0]));
        console.log('   overrides[0]:', JSON.stringify(td.body.data?.overrides?.[0]));
        console.log('   statusHistory[0]:', JSON.stringify(td.body.data?.statusHistory?.[0]));
        console.log('   domains[0]:', JSON.stringify(td.body.data?.domains?.[0]));
        console.log('   subscription:', JSON.stringify(td.body.data?.subscription)?.slice(0, 260));
        console.log('   subscriptionEvents[0]:', JSON.stringify(td.body.data?.subscriptionEvents?.[0]));
        console.log('   entitlementSnapshot keys:', Object.keys(td.body.data?.entitlementSnapshot || {}));
        console.log('   counts:', JSON.stringify(td.body.data?.counts));
      }
      show(`GET /platform/tenants/${tid}/entitlements`, await call('GET', `/platform/tenants/${tid}/entitlements`));
      const te = await call('GET', `/platform/tenants/${tid}/entitlements`);
      if (te.status < 400) console.log('   entitlements[0]:', JSON.stringify(te.body.data?.entitlements?.[0]));
      show(`GET /platform/tenants/${tid}/usage`, await call('GET', `/platform/tenants/${tid}/usage`));
      const tu = await call('GET', `/platform/tenants/${tid}/usage`);
      if (tu.status < 400) console.log('   usage[0]:', JSON.stringify(tu.body.data?.usage?.[0]));
      show(`GET /platform/modules?tenantId=${tid}`, await call('GET', `/platform/modules?tenantId=${tid}`));
      const tm = await call('GET', `/platform/modules?tenantId=${tid}`);
      if (tm.status < 400) console.log('   module[0]:', JSON.stringify(tm.body.data?.[0]));
      const ex = await call('GET', `/platform/tenants/${tid}/entitlements/employees.max/explain`);
      show(`GET .../employees.max/explain`, ex);
      if (ex.status < 400) console.log('   ', JSON.stringify(ex.body.data)?.slice(0, 600));
      show(`GET /platform/support-access/${sid}/logs`, await call('GET', `/platform/support-access/${sid}/logs`));
      show(`POST /platform/support-access/${sid}/revoke`, await call('POST', `/platform/support-access/${sid}/revoke`, { reason: 'smoke test cleanup' }));
    }
  }

  console.log('\n' + '='.repeat(70));
  console.log('Done.');

  server.close();
  await pool.end();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
