/**
 * Platform billing: terms, invoices, payments, and the dunning they drive.
 */
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');

const env = require('../src/config/env');
const { pool } = require('../src/config/db');
const app = require('../src/app');
const lifecycle = require('../src/services/lifecycle');
const rbac = require('../src/services/rbac');
const entitlements = require('../src/services/entitlements');

const PASSWORD = 'Password@123';
const slug = `bl-${crypto.randomBytes(4).toString('hex')}`;
let server; let baseUrl; let tenantId; let subId; let supportTok; let billingTok; let ownerTok;

const api = async (method, p, { token, body } = {}) => {
  const res = await fetch(`${baseUrl}${p}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const t = await res.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch { j = { raw: t }; }
  return { status: res.status, body: j };
};
const login = async (email) => (await api('POST', '/api/auth/login', { body: { email, password: PASSWORD } })).body.accessToken;
const mkPlatform = async (key, role) => {
  await pool.query(`INSERT INTO users (tenant_id,email,password_hash,name,role,status) VALUES (NULL,?,?,?,?, 'active')`,
    [`${key}-${slug}@platform.local`, await bcrypt.hash(PASSWORD, 10), key, role]);
  return login(`${key}-${slug}@platform.local`);
};

before(async () => {
  await new Promise((r) => { server = app.listen(0, r); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  const [t] = await pool.query(
    `INSERT INTO tenants (name, slug, plan, status, country, timezone, currency, employee_limit, onboarded_at)
     VALUES ('Billing Co', ?, 'growth', 'active', 'IN','Asia/Kolkata','INR', 100, NOW())`, [`${slug}-a`]);
  tenantId = t.insertId;
  const [[plan]] = await pool.query(`SELECT * FROM platform_plans WHERE plan_key = 'growth'`);
  const [s] = await pool.query(
    `INSERT INTO subscriptions (tenant_id, plan_id, plan_key, status, billing_cycle, quantity, price_per_period, discount_pct, current_period_start, current_period_end)
     VALUES (?,?,?, 'active','monthly',0, 10000, 10, NOW(), DATE_ADD(NOW(), INTERVAL 1 MONTH))`, [tenantId, plan.id, plan.plan_key]);
  subId = s.insertId;
  const [u] = await pool.query(`INSERT INTO users (tenant_id,email,password_hash,name,role,status) VALUES (?,?,?,?, 'company_owner','active')`,
    [tenantId, `owner@${slug}.local`, await bcrypt.hash(PASSWORD, 10), 'owner']);
  void u;
  rbac.invalidateAll(); entitlements.invalidateAll();
  billingTok = await mkPlatform('billing', 'platform_billing_admin');
  supportTok = await mkPlatform('support', 'platform_support_admin');
  ownerTok = await login(`owner@${slug}.local`);
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  await pool.query('DELETE FROM subscription_payments WHERE tenant_id = ?', [tenantId]).catch(() => {});
  await pool.query('DELETE FROM subscription_invoices WHERE tenant_id = ?', [tenantId]).catch(() => {});
  for (const tb of ['subscription_events', 'subscriptions', 'tenant_status_history', 'users']) {
    await pool.query(`DELETE FROM ${tb} WHERE tenant_id = ?`, [tenantId]).catch(() => {});
  }
  await pool.query('DELETE FROM users WHERE email LIKE ?', [`%${slug}%`]).catch(() => {});
  await pool.query('DELETE FROM platform_audit_logs WHERE tenant_id = ?', [tenantId]).catch(() => {});
  await pool.query('DELETE FROM tenants WHERE id = ?', [tenantId]).catch(() => {});
  void env;
  await pool.end();
});

describe('commercial terms', () => {
  test('discount and trial edits need billing rights and a reason, and are audited with before/after', async () => {
    const p = `/api/platform/subscriptions/${subId}/terms`;
    assert.equal((await api('PATCH', p, { token: supportTok, body: { discount_pct: 20, reason: 'support tries' } })).status, 403);
    assert.equal((await api('PATCH', p, { token: ownerTok, body: { discount_pct: 20, reason: 'owner tries' } })).status, 403);
    assert.equal((await api('PATCH', p, { token: billingTok, body: { discount_pct: 20 } })).status, 400);
    assert.equal((await api('PATCH', p, { token: billingTok, body: { discount_pct: 140, reason: 'too much' } })).status, 400);
    const ok = await api('PATCH', p, { token: billingTok, body: { discount_pct: 20, reason: 'Negotiated annual deal' } });
    assert.equal(ok.status, 200);
    assert.equal(Number(ok.body.data.discount_pct), 20);
    const [[a]] = await pool.query(`SELECT before_json, after_json FROM platform_audit_logs WHERE tenant_id = ? AND action = 'subscription.terms_changed'`, [tenantId]);
    assert.equal(Number((typeof a.before_json === 'string' ? JSON.parse(a.before_json) : a.before_json).discount_pct), 10);
    assert.equal(Number((typeof a.after_json === 'string' ? JSON.parse(a.after_json) : a.after_json).discount_pct), 20);
  });

  test('a trial can only be extended while trialing', async () => {
    const res = await api('PATCH', `/api/platform/subscriptions/${subId}/terms`, { token: billingTok,
      body: { trial_ends_at: new Date(Date.now() + 5 * 86400000).toISOString(), reason: 'extend trial' } });
    assert.equal(res.status, 409);
  });
});

describe('invoices and payments', () => {
  let invId;
  test('an invoice applies the discount and tax in exact money, once per period', async () => {
    const body = { periodStart: '2026-10-01', periodEnd: '2026-10-31', taxPct: 18, reason: 'October invoice' };
    const res = await api('POST', `/api/platform/subscriptions/${subId}/invoices`, { token: billingTok, body });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const inv = res.body.data; invId = inv.id;
    assert.equal(Number(inv.subtotal), 10000);
    assert.equal(Number(inv.discount), 2000);   // 20%
    assert.equal(Number(inv.tax), 1440);         // 18% of 8000
    assert.equal(Number(inv.total), 9440);
    const dupe = await api('POST', `/api/platform/subscriptions/${subId}/invoices`, { token: billingTok, body });
    assert.equal(dupe.status, 409, 'the same period must not be billed twice');
  });

  test('payments are bounded by the outstanding amount and settle the invoice exactly', async () => {
    const pay = (b) => api('POST', `/api/platform/billing/invoices/${invId}/payments`, { token: billingTok, body: { reason: 'Bank credit', ...b } });
    assert.equal((await pay({ amount: 0 })).status, 400);
    assert.equal((await pay({ amount: 99999 })).status, 400, 'over-payment refused');
    assert.equal((await pay({ amount: 440.5, method: 'bitcoin' })).status, 400);
    const part = await pay({ amount: 440.5, method: 'upi', reference: 'UTR1' });
    assert.equal(part.status, 201);
    assert.equal(part.body.data.invoice.status, 'open');
    assert.equal(part.body.data.invoice.outstanding, 8999.5);
    const rest = await pay({ amount: 8999.5, method: 'bank_transfer' });
    assert.equal(rest.body.data.invoice.status, 'paid');
    assert.equal((await pay({ amount: 1 })).status, 409, 'a paid invoice takes no more money');
  });

  test('a settled invoice cannot be voided, and a billing admin cannot read as a company owner', async () => {
    assert.equal((await api('POST', `/api/platform/billing/invoices/${invId}/void`, { token: billingTok, body: { reason: 'Voiding by mistake' } })).status, 409);
    assert.equal((await api('GET', '/api/platform/billing/invoices', { token: ownerTok })).status, 403);
  });

  test('concurrent payments cannot over-collect', async () => {
    const r = await api('POST', `/api/platform/subscriptions/${subId}/invoices`, { token: billingTok,
      body: { periodStart: '2026-11-01', periodEnd: '2026-11-30', reason: 'November invoice' } });
    const id = r.body.data.id; const total = Number(r.body.data.total);
    const results = await Promise.all([1, 2, 3].map(() =>
      api('POST', `/api/platform/billing/invoices/${id}/payments`, { token: billingTok, body: { amount: total, reason: 'Racing payments' } })));
    assert.equal(results.filter((x) => x.status === 201).length, 1, JSON.stringify(results.map((x) => x.status)));
    const [[row]] = await pool.query('SELECT amount_paid, total FROM subscription_invoices WHERE id = ?', [id]);
    assert.equal(Number(row.amount_paid), Number(row.total));
  });
});

describe('an unpaid invoice drives the dunning chain, and payment unwinds it', () => {
  test('overdue invoice → past_due; paying it → active again', async () => {
    const r = await api('POST', `/api/platform/subscriptions/${subId}/invoices`, { token: billingTok,
      body: { periodStart: '2026-12-01', periodEnd: '2026-12-31', dueDays: 0, reason: 'December invoice' } });
    const id = r.body.data.id;
    await pool.query(`UPDATE subscription_invoices SET due_at = DATE_SUB(CURDATE(), INTERVAL 3 DAY) WHERE id = ?`, [id]);
    const report = await lifecycle.sweep({ reason: 'billing test sweep' });
    assert.ok(report.escalated.some((e) => e.subscriptionId === subId && e.to === 'past_due'), JSON.stringify(report.escalated));
    const [[s1]] = await pool.query('SELECT status FROM subscriptions WHERE id = ?', [subId]);
    assert.ok(['past_due', 'grace_period'].includes(s1.status));

    const total = Number(r.body.data.total);
    const paid = await api('POST', `/api/platform/billing/invoices/${id}/payments`, { token: billingTok, body: { amount: total, reason: 'Cleared dues' } });
    assert.equal(paid.status, 201);
    assert.equal(paid.body.data.subscriptionRestored, true);
    const [[s2]] = await pool.query('SELECT status FROM subscriptions WHERE id = ?', [subId]);
    assert.equal(s2.status, 'active');
  });
});
