/**
 * Commercial lifecycle, executed end to end against the real database and HTTP stack.
 *   node --test tests/commercial.test.js
 */
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');

process.env.BILLING_WEBHOOK_SECRET = 'whsec_test_' + crypto.randomBytes(6).toString('hex');
const env = require('../src/config/env');
const { pool } = require('../src/config/db');
const app = require('../src/app');
const rbac = require('../src/services/rbac');
const entitlements = require('../src/services/entitlements');
const payments = require('../src/services/payments');
const lifecycle = require('../src/services/lifecycle');

const PASSWORD = 'Password@123';
const tag = crypto.randomBytes(3).toString('hex');
let server; let base;
const tok = {}; const uid = []; const tenants = []; let addonId;

const call = async (method, path, { token, body, raw, headers = {} } = {}) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body && !raw ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    ...(raw ? { body: raw } : body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  return { status: res.status, body: json };
};
const login = async (email) => (await call('POST', '/api/auth/login', { body: { email, password: PASSWORD } })).body.accessToken;
const mkPlatform = async (key, role) => {
  const email = `${key}-${tag}@platform.local`;
  const [u] = await pool.query("INSERT INTO users (tenant_id,email,password_hash,name,role,status) VALUES (NULL,?,?,?,?, 'active')", [email, await bcrypt.hash(PASSWORD, 10), key, role]);
  uid.push(u.insertId); tok[key] = await login(email);
};
const hook = (id, type, data, { secret = process.env.BILLING_WEBHOOK_SECRET, t = Date.now() } = {}) => {
  const raw = JSON.stringify({ id, type, data });
  return call('POST', '/api/billing-webhooks/signed', { raw, headers: { 'Content-Type': 'application/json', 'x-arthvex-signature': payments.sign(secret, raw, t) } });
};

let tenantId; let subId; let ownerToken; let invoice;

before(async () => {
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  await mkPlatform('super', 'platform_super_admin');
  await mkPlatform('billing', 'platform_billing_admin');
  await mkPlatform('support', 'platform_support_admin');
  await mkPlatform('auditor', 'platform_auditor');
  await mkPlatform('security', 'platform_security_admin');
});

after(async () => {
  const [tables] = await pool.query("SELECT table_name FROM information_schema.columns WHERE table_schema = ? AND column_name = 'tenant_id'", [env.db.database]);
  for (const { table_name: t } of tables) if (tenants.length) await pool.query(`DELETE FROM \`${t}\` WHERE tenant_id IN (?)`, [tenants]).catch(() => {});
  if (addonId) await pool.query('DELETE FROM addons WHERE id = ?', [addonId]).catch(() => {});
  await pool.query("DELETE FROM payment_provider_events WHERE event_id LIKE ?", [`%${tag}%`]).catch(() => {});
  await pool.query("DELETE FROM platform_plans WHERE plan_key = ?", [`tiny_${tag}`]).catch(() => {});
  await pool.query("DELETE FROM platform_incidents WHERE title LIKE ?", [`%${tag}%`]).catch(() => {});
  await pool.query("DELETE FROM platform_notifications WHERE title LIKE ? OR tenant_id IN (?)", [`%${tag}%`, tenants.length ? tenants : [0]]).catch(() => {});
  await pool.query('DELETE FROM maintenance_windows WHERE message LIKE ?', [`%${tag}%`]).catch(() => {});
  await pool.query('DELETE FROM users WHERE tenant_id IS NULL AND email LIKE ?', [`%-${tag}@platform.local`]).catch(() => {});
  if (tenants.length) await pool.query('DELETE FROM platform_audit_logs WHERE tenant_id IN (?)', [tenants]).catch(() => {});
  await pool.query('DELETE FROM tenants WHERE slug LIKE ?', [`com-${tag}%`]).catch(() => {});
  rbac.invalidateAll(); entitlements.invalidateAll();
  await new Promise((r) => server.close(r));
  await pool.end();
});

describe('trial → paid', () => {
  test('provisioning on the trial plan starts a trialing subscription and an owner login', async () => {
    const res = await call('POST', '/api/platform/tenants', { token: tok.super, body: {
      tenant: { legalName: `Commercial Co ${tag}`, slug: `com-${tag}`, industry: 'Software', contactEmail: `c-${tag}@com.local` },
      legalEntities: [{ name: `Commercial Co ${tag} Pvt Ltd` }], planKey: 'trial', modules: [], billingCycle: 'monthly',
      owner: { email: `owner-${tag}@com.local`, name: 'Owner' }, branding: { companyName: 'Commercial Co' },
    } });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    tenantId = res.body.data.id; tenants.push(tenantId);
    const [[sub]] = await pool.query("SELECT * FROM subscriptions WHERE tenant_id = ? ORDER BY id DESC LIMIT 1", [tenantId]);
    subId = sub.id;
    assert.equal(sub.status, 'trialing');
    assert.ok(sub.trial_ends_at);
    await pool.query('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE email = ?', [await bcrypt.hash(PASSWORD, 10), `owner-${tag}@com.local`]);
    ownerToken = await login(`owner-${tag}@com.local`);
    assert.ok(ownerToken);
  });

  test('the database refuses a second live subscription for the same company', async () => {
    await assert.rejects(
      pool.query("INSERT INTO subscriptions (tenant_id, plan_key, status) VALUES (?, 'growth', 'active')", [tenantId]),
      (e) => e.code === 'ER_DUP_ENTRY');
  });

  test('a trial can be extended with a reason, at most twice, never by a billing-less role', async () => {
    assert.equal((await call('POST', `/api/platform/subscriptions/${subId}/trial/extend`, { token: tok.super, body: { days: 7 } })).status, 400, 'reason required');
    assert.equal((await call('POST', `/api/platform/subscriptions/${subId}/trial/extend`, { token: tok.support, body: { days: 7, reason: 'customer asked' } })).status, 403);
    const before = (await pool.query('SELECT trial_ends_at FROM subscriptions WHERE id = ?', [subId]))[0][0].trial_ends_at;
    const a = await call('POST', `/api/platform/subscriptions/${subId}/trial/extend`, { token: tok.billing, body: { days: 7, reason: 'evaluation in progress' } });
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.ok(new Date(a.body.data.trial_ends_at) > new Date(before));
    assert.equal(a.body.data.trial_extensions, 1);
    assert.equal((await call('POST', `/api/platform/subscriptions/${subId}/trial/extend`, { token: tok.billing, body: { days: 7, reason: 'second extension' } })).status, 200);
    assert.equal((await call('POST', `/api/platform/subscriptions/${subId}/trial/extend`, { token: tok.billing, body: { days: 7, reason: 'third extension' } })).status, 409);
  });

  test('converting the trial activates the subscription and is idempotent', async () => {
    const a = await call('POST', `/api/platform/subscriptions/${subId}/trial/convert`, { token: tok.billing, body: { planKey: 'growth', reason: 'signed the order form' } });
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.equal(a.body.data.status, 'active');
    assert.ok(a.body.data.converted_at);
    assert.equal(a.body.data.plan_key, 'growth');
    const b = await call('POST', `/api/platform/subscriptions/${subId}/trial/convert`, { token: tok.billing, body: { reason: 'again' } });
    assert.equal(b.status, 200);
    const [events] = await pool.query("SELECT COUNT(*) AS n FROM subscription_events WHERE subscription_id = ? AND to_status = 'active'", [subId]);
    assert.equal(Number(events[0].n), 1, 'a repeated conversion must not activate twice');
    const [[t]] = await pool.query('SELECT status, plan FROM tenants WHERE id = ?', [tenantId]);
    assert.equal(t.status, 'active'); assert.equal(t.plan, 'growth');
  });
});

describe('add-ons feed the entitlement engine', () => {
  test('an add-on raises a cap by increment × quantity, and removing it puts the cap back', async () => {
    const base0 = (await entitlements.resolveTenant(tenantId, { bypassCache: true })).entitlements['employees.max'];
    assert.ok(base0.value > 0);
    const made = await call('POST', '/api/platform/addons', { token: tok.super, body: {
      addonKey: `seats_${tag}`, name: 'Extra seats', grants: [{ key: 'employees.max', increment: 100 }], priceMonthly: 500, reason: 'catalogue entry for tests' } });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    addonId = made.body.data.id;
    assert.equal((await call('POST', '/api/platform/addons', { token: tok.super, body: { addonKey: `bad_${tag}`, name: 'x', grants: [{ key: 'nope.max', increment: 1 }], reason: 'bad key test' } })).status, 400);
    assert.equal((await call('POST', `/api/platform/tenants/${tenantId}/addons`, { token: tok.support, body: { addonKey: `seats_${tag}`, quantity: 2, reason: 'sales order' } })).status, 403);
    const att = await call('POST', `/api/platform/tenants/${tenantId}/addons`, { token: tok.super, body: { addonKey: `seats_${tag}`, quantity: 2, reason: 'sales order 1042' } });
    assert.equal(att.status, 201, JSON.stringify(att.body));
    const withAddon = (await entitlements.resolveTenant(tenantId, { bypassCache: true })).entitlements['employees.max'];
    if (!base0.unlimited) assert.equal(withAddon.value, base0.value + 200);
    assert.equal(withAddon.source, 'addon');
    assert.equal((await call('POST', `/api/platform/tenants/${tenantId}/addons`, { token: tok.super, body: { addonKey: `seats_${tag}`, quantity: 1, reason: 'attach twice' } })).status, 409);
    assert.equal((await call('DELETE', `/api/platform/tenants/${tenantId}/addons/seats_${tag}`, { token: tok.super, body: { reason: 'order cancelled' } })).status, 200);
    const back = (await entitlements.resolveTenant(tenantId, { bypassCache: true })).entitlements['employees.max'];
    assert.equal(back.value, base0.value);
  });
});

describe('invoices, verified webhooks and idempotency', () => {
  test('an invoice is issued for the period', async () => {
    const res = await call('POST', `/api/platform/subscriptions/${subId}/invoices`, { token: tok.billing, body: { taxPct: 18, reason: 'monthly invoice' } });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    invoice = res.body.data;
    assert.ok(Number(invoice.total) > 0);
  });

  test('a webhook with a bad or stale signature is rejected and changes nothing', async () => {
    const data = { invoice_number: invoice.invoice_number, amount: 100, reference: `ref-${tag}-bad` };
    assert.equal((await hook(`evt-${tag}-1`, 'payment.succeeded', data, { secret: 'wrong' })).status, 401);
    assert.equal((await hook(`evt-${tag}-2`, 'payment.succeeded', data, { t: Date.now() - 3_600_000 })).status, 401);
    const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM subscription_payments WHERE invoice_id = ?', [invoice.id]);
    assert.equal(Number(n), 0);
  });

  test('a verified payment applies once; duplicates and re-sends under new event ids apply nothing', async () => {
    const half = Number(invoice.total) / 2;
    const data = { invoice_number: invoice.invoice_number, amount: half, reference: `ref-${tag}-A` };
    const first = await hook(`evt-${tag}-3`, 'payment.succeeded', data);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.outcome, 'processed');
    const dup = await hook(`evt-${tag}-3`, 'payment.succeeded', data);
    assert.equal(dup.status, 200); assert.equal(dup.body.duplicate, true);
    const resent = await hook(`evt-${tag}-4`, 'payment.succeeded', data); // same provider reference, new event id
    assert.equal(resent.body.outcome, 'ignored');
    const [[{ n, paid }]] = await pool.query("SELECT COUNT(*) AS n, SUM(amount) AS paid FROM subscription_payments WHERE invoice_id = ? AND kind = 'payment'", [invoice.id]);
    assert.equal(Number(n), 1);
    assert.equal(Number(paid), half);
    const [[inv]] = await pool.query('SELECT status, amount_paid FROM subscription_invoices WHERE id = ?', [invoice.id]);
    assert.equal(inv.status, 'open'); assert.equal(Number(inv.amount_paid), half);
  });

  test('over-payment is refused and the event is recorded as failed, then retryable', async () => {
    const res = await hook(`evt-${tag}-5`, 'payment.succeeded', { invoice_number: invoice.invoice_number, amount: 99999999, reference: `ref-${tag}-big` });
    assert.equal(res.status, 400);
    const [[ev]] = await pool.query('SELECT status FROM payment_provider_events WHERE event_id = ?', [`evt-${tag}-5`]);
    assert.equal(ev.status, 'failed');
  });

  test('the remaining balance settles the invoice; a failed payment moves the subscription to past due and a later one restores it', async () => {
    const [[inv]] = await pool.query('SELECT total, amount_paid FROM subscription_invoices WHERE id = ?', [invoice.id]);
    const rest = Number((Number(inv.total) - Number(inv.amount_paid)).toFixed(2));
    const ok = await hook(`evt-${tag}-6`, 'payment.succeeded', { invoice_number: invoice.invoice_number, amount: rest, reference: `ref-${tag}-B` });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal((await pool.query('SELECT status FROM subscription_invoices WHERE id = ?', [invoice.id]))[0][0].status, 'paid');

    // next period's invoice fails
    await pool.query('UPDATE subscriptions SET current_period_start = DATE_ADD(current_period_start, INTERVAL 1 MONTH), current_period_end = DATE_ADD(current_period_end, INTERVAL 1 MONTH) WHERE id = ?', [subId]);
    const inv2 = (await call('POST', `/api/platform/subscriptions/${subId}/invoices`, { token: tok.billing, body: { reason: 'next month invoice' } })).body.data;
    assert.ok(inv2, 'second invoice');
    const fail = await hook(`evt-${tag}-7`, 'payment.failed', { invoice_number: inv2.invoice_number, reference: 'card declined' });
    assert.equal(fail.status, 200, JSON.stringify(fail.body));
    assert.equal((await pool.query('SELECT status FROM subscriptions WHERE id = ?', [subId]))[0][0].status, 'past_due');
    assert.equal((await hook(`evt-${tag}-7`, 'payment.failed', { invoice_number: inv2.invoice_number })).body.duplicate, true);
    const [[notes]] = await pool.query("SELECT COUNT(*) AS n FROM platform_notifications WHERE tenant_id = ? AND event_key = 'payment_failed'", [tenantId]);
    assert.equal(Number(notes.n), 1, 'one alert, not one per delivery');

    // data stays intact and readable while past due
    assert.equal((await call('GET', '/api/employees?limit=1', { token: ownerToken })).status, 200);

    await pool.query('UPDATE subscription_invoices SET due_at = DATE_SUB(CURDATE(), INTERVAL 1 DAY) WHERE id = ?', [inv2.id]);
    const pay = await hook(`evt-${tag}-8`, 'payment.succeeded', { invoice_number: inv2.invoice_number, amount: inv2.total, reference: `ref-${tag}-C` });
    assert.equal(pay.status, 200, JSON.stringify(pay.body));
    assert.equal((await pool.query('SELECT status FROM subscriptions WHERE id = ?', [subId]))[0][0].status, 'active');
    invoice = inv2;
  });

  test('refunds: partial then over-refund; a refund re-opens a paid invoice and is idempotent', async () => {
    const ref = await hook(`evt-${tag}-9`, 'refund.succeeded', { invoice_number: invoice.invoice_number, amount: 10, reference: `rf-${tag}` });
    assert.equal(ref.status, 200, JSON.stringify(ref.body));
    const [[inv]] = await pool.query('SELECT status, amount_paid, total FROM subscription_invoices WHERE id = ?', [invoice.id]);
    assert.equal(inv.status, 'open');
    assert.equal(Number(inv.amount_paid), Number(inv.total) - 10);
    assert.equal((await hook(`evt-${tag}-9`, 'refund.succeeded', { invoice_number: invoice.invoice_number, amount: 10, reference: `rf-${tag}` })).body.duplicate, true);
    assert.equal(Number((await pool.query('SELECT amount_paid FROM subscription_invoices WHERE id = ?', [invoice.id]))[0][0].amount_paid), Number(inv.amount_paid));
    const over = await call('POST', `/api/platform/billing/invoices/${invoice.id}/refunds`, { token: tok.billing, body: { amount: 99999999, reason: 'bad refund' } });
    assert.equal(over.status, 400);
    assert.equal((await call('POST', `/api/platform/billing/invoices/${invoice.id}/refunds`, { token: tok.support, body: { amount: 1, reason: 'not allowed' } })).status, 403);
  });
});

describe('downgrade keeps data and tells the admin', () => {
  test('moving to a smaller plan lists the overage, keeps every record and blocks new additions', async () => {
    const [[ent]] = await pool.query("SELECT id FROM entitlements WHERE entitlement_key = 'employees.max'");
    const [pl] = await pool.query("INSERT INTO platform_plans (plan_key, name, plan_type, price_monthly, is_public) VALUES (?,?,?,?, 0)", [`tiny_${tag}`, 'Tiny', 'custom', 1]);
    await pool.query('INSERT INTO plan_entitlements (plan_id, entitlement_id, value) VALUES (?,?,?)', [pl.insertId, ent.id, '1']);
    for (let i = 0; i < 3; i++) {
      await pool.query("INSERT INTO employees (tenant_id, employee_code, first_name, last_name, email, joined_on, status) VALUES (?,?,?,?,?, '2025-01-01', 'active')", [tenantId, `D${tag}${i}`, 'D', `${i}`, `d${i}-${tag}@com.local`]);
    }
    const prev = await call('POST', `/api/platform/subscriptions/${subId}/plan-preview`, { token: tok.billing, body: { planKey: `tiny_${tag}` } });
    assert.equal(prev.status, 200, JSON.stringify(prev.body));
    assert.equal(prev.body.data.direction, 'downgrade');
    const over = prev.body.data.overages.find((o) => o.key === 'employees.max');
    assert.ok(over && over.current >= 3 && over.newLimit === 1, JSON.stringify(prev.body.data));
    const chg = await call('POST', `/api/platform/subscriptions/${subId}/plan`, { token: tok.billing, body: { planKey: `tiny_${tag}`, reason: 'customer downgrade' } });
    assert.equal(chg.status, 200, JSON.stringify(chg.body));
    const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM employees WHERE tenant_id = ? AND deleted_at IS NULL', [tenantId]);
    assert.ok(Number(n) >= 3, 'no employee was deleted');
    const add = await call('POST', '/api/employees', { token: ownerToken, body: { first_name: 'New', last_name: 'Hire', email: `new-${tag}@com.local`, joined_on: '2026-01-01' } });
    assert.equal(add.status, 402, `new additions must be blocked, got ${add.status}`);
    assert.equal((await call('GET', '/api/employees?limit=5', { token: ownerToken })).status, 200, 'existing records stay readable');
    // upgrade again → additions work
    assert.equal((await call('POST', `/api/platform/subscriptions/${subId}/plan`, { token: tok.billing, body: { planKey: 'business', reason: 'customer upgraded again' } })).status, 200);
    const again = await call('POST', '/api/employees', { token: ownerToken, body: { first_name: 'New', last_name: 'Hire', email: `new-${tag}@com.local`, joined_on: '2026-01-01', createLogin: false } });
    assert.equal(again.status, 201, JSON.stringify(again.body));
  });
});

describe('customer self-service', () => {
  test('the company sees its own subscription, usage and invoices — and only its own', async () => {
    const res = await call('GET', '/api/account/subscription', { token: ownerToken });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.status, 'active');
    assert.ok(Array.isArray(res.body.data.invoices) && res.body.data.invoices.length >= 1);
    assert.equal((await call('GET', '/api/account/subscription', { token: tok.super })).status, 403, 'platform accounts have no company here');
  });

  test('setup health reports concrete checks and says why payroll cannot run', async () => {
    const res = await call('GET', '/api/account/setup-health', { token: ownerToken });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(res.body.data.setup.every((c) => typeof c.ok === 'boolean' && c.label), JSON.stringify(res.body.data.setup));
    assert.equal(res.body.data.payroll.ready, false);
    assert.match(res.body.data.payroll.message, /cannot run until/);
    const dq = await call('GET', '/api/account/data-quality', { token: ownerToken });
    assert.equal(dq.status, 200, JSON.stringify(dq.body));
    assert.ok(dq.body.data.employeesMissingDepartment.length >= 1);
    assert.doesNotMatch(JSON.stringify(dq.body), /ctc|gross|bank|"pan|aadhaar|amount/i, 'record ids and codes only — no pay or identity data');
  });

  test('billing contacts are validated', async () => {
    assert.equal((await call('PUT', '/api/account/contacts', { token: ownerToken, body: { contactType: 'billing', email: 'nope' } })).status, 400);
    assert.equal((await call('PUT', '/api/account/contacts', { token: ownerToken, body: { contactType: 'billing', email: `fin-${tag}@com.local`, gstin: 'BADGST' } })).status, 400);
    assert.equal((await call('PUT', '/api/account/contacts', { token: ownerToken, body: { contactType: 'billing', email: `fin-${tag}@com.local`, gstin: '27AAPFU0939F1ZV' } })).status, 200);
  });
});

describe('support tickets and support access', () => {
  let ticket;
  test('a ticket can be raised by the company and by ARTHVEX; the customer sees only customer-visible notes', async () => {
    const mine = await call('POST', '/api/account/support-tickets', { token: ownerToken, body: { subject: 'Payroll configuration help', category: 'payroll', priority: 'high' } });
    assert.equal(mine.status, 201, JSON.stringify(mine.body));
    ticket = mine.body.data;
    assert.equal((await call('POST', `/api/platform/support-tickets/${ticket.id}/notes`, { token: tok.support, body: { body: 'Internal: check the PF rule', visibility: 'internal' } })).status, 201);
    assert.equal((await call('POST', `/api/platform/support-tickets/${ticket.id}/notes`, { token: tok.support, body: { body: 'We are looking into it.', visibility: 'customer' } })).status, 201);
    const seen = await call('GET', `/api/account/support-tickets/${ticket.id}`, { token: ownerToken });
    assert.equal(seen.status, 200);
    assert.equal(seen.body.data.notes.length, 1);
    assert.doesNotMatch(JSON.stringify(seen.body), /Internal: check the PF rule/);
    const [[row]] = await pool.query('SELECT first_response_at FROM support_tickets WHERE id = ?', [ticket.id]);
    assert.ok(row.first_response_at, 'the first customer-visible reply stamps first response');
  });

  test('the SLA is only set when a policy is configured — nothing is promised by default', async () => {
    const [[t]] = await pool.query('SELECT sla_due_at FROM support_tickets WHERE id = ?', [ticket.id]);
    assert.equal(t.sla_due_at, null);
    assert.equal((await call('PUT', '/api/platform/support-sla', { token: tok.support, body: { supportLevel: 'standard', priority: 'high', firstResponseMinutes: 60, resolutionMinutes: 480, reason: 'try' } })).status, 403);
  });

  test('support access is tied to the ticket, and resolving needs a resolution', async () => {
    const grant = await call('POST', '/api/platform/support-access', { token: tok.support, body: {
      tenantId, reason: 'Investigate the payroll configuration', accessType: 'read_only', durationMinutes: 15, ticketRef: ticket.ticketNo } });
    assert.equal(grant.status, 201, JSON.stringify(grant.body));
    const detail = await call('GET', `/api/platform/support-tickets/${ticket.id}`, { token: tok.support });
    assert.equal(detail.body.data.supportSessions.length, 1);
    assert.equal((await call('PATCH', `/api/platform/support-tickets/${ticket.id}`, { token: tok.support, body: { status: 'resolved' } })).status, 400);
    assert.equal((await call('PATCH', `/api/platform/support-tickets/${ticket.id}`, { token: tok.support, body: { status: 'resolved', resolution: 'Configuration corrected' } })).status, 200);
    // the company's own admin can never see another company's tickets
    const [otherIns] = await pool.query("INSERT INTO tenants (name, slug, plan, status) VALUES (?,?, 'starter','active')", [`Other ${tag}`, `com-${tag}-other`]);
    const other = { id: otherIns.insertId };
    tenants.push(other.id);
    const [o] = await pool.query("INSERT INTO support_tickets (ticket_no, tenant_id, subject) VALUES (?,?,?)", [`SUP-X${tag}`, other.id, 'Other tenant ticket']);
    assert.equal((await call('GET', `/api/account/support-tickets/${o.insertId}`, { token: ownerToken })).status, 404);
  });
});

describe('maintenance and incidents', () => {
  test('a maintenance window blocks the company with a message, never platform staff, and can be cancelled', async () => {
    assert.equal((await call('POST', '/api/platform/maintenance', { token: tok.support, body: { message: `Upgrading ${tag}`, startsAt: new Date(Date.now() - 1000), endsAt: new Date(Date.now() + 600000), reason: 'not allowed' } })).status, 403);
    assert.equal((await call('POST', '/api/platform/maintenance', { token: ownerToken, body: { message: 'x'.repeat(10), startsAt: new Date(), endsAt: new Date(Date.now() + 1000), reason: 'owner tries' } })).status, 403, 'a company owner cannot schedule maintenance');
    const made = await call('POST', '/api/platform/maintenance', { token: tok.super, body: { tenantId, message: `Scheduled upgrade ${tag}`, startsAt: new Date(Date.now() - 1000), endsAt: new Date(Date.now() + 600000), reason: 'database upgrade' } });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const blocked = await call('GET', '/api/employees?limit=1', { token: ownerToken });
    assert.equal(blocked.status, 503);
    assert.match(blocked.body.message, /Scheduled upgrade/);
    assert.equal((await call('GET', '/api/platform/tenants?limit=1', { token: tok.super })).status, 200);
    assert.equal((await call('DELETE', `/api/platform/maintenance/${made.body.data.id}`, { token: tok.super, body: { reason: 'finished early' } })).status, 200);
    assert.equal((await call('GET', '/api/employees?limit=1', { token: ownerToken })).status, 200);
  });

  test('incidents need a root cause and resolution before they can be resolved', async () => {
    const inc = await call('POST', '/api/platform/incidents', { token: tok.security, body: { title: `Slow API ${tag}`, severity: 'sev2', affectedSystems: ['api'] } });
    assert.equal(inc.status, 201, JSON.stringify(inc.body));
    assert.equal((await call('POST', `/api/platform/incidents/${inc.body.data.id}/updates`, { token: tok.security, body: { status: 'resolved', message: 'fixed' } })).status, 400);
    assert.equal((await call('POST', `/api/platform/incidents/${inc.body.data.id}/updates`, { token: tok.security, body: { status: 'resolved', message: 'fixed', rootCause: 'bad index', resolution: 'added the index' } })).status, 200);
    assert.equal((await call('POST', '/api/platform/incidents', { token: tok.auditor, body: { title: `Auditor ${tag}` } })).status, 403);
  });
});

describe('cancellation never deletes', () => {
  test('cancel at period end keeps the company running, then the sweeper ends it without touching data', async () => {
    const ask = await call('POST', '/api/account/subscription/cancel', { token: ownerToken, body: { reason: 'moving to another product' } });
    assert.equal(ask.status, 200, JSON.stringify(ask.body));
    let [[sub]] = await pool.query('SELECT status, cancel_at_period_end, cancel_reason FROM subscriptions WHERE id = ?', [subId]);
    assert.equal(sub.status, 'active'); assert.ok(sub.cancel_at_period_end);
    assert.equal((await call('GET', '/api/employees?limit=1', { token: ownerToken })).status, 200);

    assert.equal((await call('POST', '/api/account/subscription/cancel/withdraw', { token: ownerToken })).status, 200, 'the company can change its mind');
    assert.equal((await call('POST', '/api/account/subscription/cancel', { token: ownerToken, body: { reason: 'final decision' } })).status, 200);

    await pool.query('UPDATE subscriptions SET current_period_end = DATE_SUB(NOW(), INTERVAL 1 HOUR) WHERE id = ?', [subId]);
    const [[{ c0 }]] = await pool.query('SELECT COUNT(*) AS c0 FROM employees WHERE tenant_id = ?', [tenantId]);
    await lifecycle.renewPeriods({ actor: lifecycle.SYSTEM_ACTOR, why: 'test', report: { renewed: [], escalated: [], errors: [] } });
    [[sub]] = await pool.query('SELECT status FROM subscriptions WHERE id = ?', [subId]);
    assert.equal(sub.status, 'cancelled');
    const [[{ c1 }]] = await pool.query('SELECT COUNT(*) AS c1 FROM employees WHERE tenant_id = ?', [tenantId]);
    assert.equal(Number(c1), Number(c0), 'cancellation deletes nothing');
    assert.equal((await call('GET', '/api/employees?limit=1', { token: ownerToken })).status, 200, 'history stays readable');
    const w = await call('POST', '/api/employees', { token: ownerToken, body: { first_name: 'No', last_name: 'Way', email: `no-${tag}@com.local`, joined_on: '2026-01-01' } });
    assert.ok([402, 403].includes(w.status), `a cancelled company cannot add records, got ${w.status}`);
    // an owner of a cancelled company can still reach support
    assert.equal((await call('POST', '/api/account/support-tickets', { token: ownerToken, body: { subject: 'Please reactivate us', category: 'billing' } })).status, 201);
  });
});

describe('platform role separation', () => {
  test('each platform role can do exactly what it should', async () => {
    const can = async (who, method, path, body) => (await call(method, path, { token: tok[who], body })).status;
    assert.equal(await can('billing', 'GET', '/api/platform/subscriptions'), 200);
    assert.equal(await can('billing', 'POST', '/api/platform/support-tickets', { tenantId, subject: 'Billing should not' }), 403);
    assert.equal(await can('support', 'POST', '/api/platform/addons', { addonKey: 'zzz_abc', name: 'x', grants: [{ key: 'employees.max', increment: 1 }], reason: 'nope nope' }), 403);
    assert.equal(await can('auditor', 'GET', '/api/platform/audit'), 200);
    assert.equal(await can('auditor', 'POST', `/api/platform/subscriptions/${subId}/cancel`, { mode: 'immediate', reason: 'auditor cannot' }), 403);
    assert.equal(await can('security', 'POST', `/api/platform/subscriptions/${subId}/trial/extend`, { days: 3, reason: 'not mine' }), 403);
    assert.equal((await call('GET', '/api/platform/subscriptions', { token: ownerToken })).status, 403, 'a company owner has no platform access');
    // none of the commercial roles can read a company's HR data without support access
    assert.equal((await call('GET', `/api/platform/tenants/${tenantId}`, { token: tok.billing })).status, 403);
  });
});

describe('identity lifecycle reacts immediately', () => {
  let hrToken; let hrId; let roleIds;
  test('disable, re-enable, role change and password reset all take effect on an already-issued token', async () => {
    // the cancelled company from the previous scenario is read-only; use a fresh active one
    const mk = await call('POST', '/api/platform/tenants', { token: tok.super, body: {
      tenant: { legalName: `Identity Co ${tag}`, slug: `com-${tag}-id`, industry: 'Software', contactEmail: `i-${tag}@com.local` },
      legalEntities: [{ name: 'Identity Pvt Ltd' }], planKey: 'business', modules: [], billingCycle: 'monthly', owner: { email: `idowner-${tag}@com.local`, name: 'Id Owner' } } });
    assert.equal(mk.status, 201, JSON.stringify(mk.body));
    const tid = mk.body.data.id; tenants.push(tid);
    await pool.query('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE email = ?', [await bcrypt.hash(PASSWORD, 10), `idowner-${tag}@com.local`]);
    const owner = await login(`idowner-${tag}@com.local`);

    roleIds = Object.fromEntries((await pool.query('SELECT id, name FROM roles WHERE tenant_id = ?', [tid]))[0].map((r) => [r.name, r.id]));
    assert.ok(roleIds.hr_admin && roleIds.employee, `tenant roles: ${Object.keys(roleIds)}`);
    const [u] = await pool.query("INSERT INTO users (tenant_id,email,password_hash,name,role,status) VALUES (?,?,?,?,'hr_admin','active')", [tid, `hr-${tag}@com.local`, await bcrypt.hash(PASSWORD, 10), 'HR']);
    hrId = u.insertId;
    await pool.query('INSERT INTO user_roles (tenant_id,user_id,role_id,is_primary) VALUES (?,?,?,1)', [tid, hrId, roleIds.hr_admin]);
    rbac.invalidateAll();
    hrToken = await login(`hr-${tag}@com.local`);
    assert.equal((await call('GET', '/api/employees?limit=1', { token: hrToken })).status, 200);

    // disabled → the same access token stops working on the next request
    assert.equal((await call('PUT', `/api/administration/users/${hrId}`, { token: owner, body: { status: 'disabled' } })).status, 200);
    assert.equal((await call('GET', '/api/employees?limit=1', { token: hrToken })).status, 401);
    assert.equal((await call('PUT', `/api/administration/users/${hrId}`, { token: owner, body: { status: 'active' } })).status, 200);
    assert.equal((await call('GET', '/api/employees?limit=1', { token: hrToken })).status, 200);

    // role change → the same token loses the permission immediately
    assert.equal((await call('PUT', `/api/administration/users/${hrId}/roles`, { token: owner, body: { role_ids: [roleIds.employee], primary_role_id: roleIds.employee } })).status, 200);
    assert.equal((await call('GET', '/api/payroll/runs', { token: hrToken })).status, 403);

    // (disabling already revoked the refresh tokens; sign in again so there is a live session to revoke)
    await login(`hr-${tag}@com.local`);
    // password reset revokes the refresh tokens
    const [[{ live }]] = await pool.query('SELECT COUNT(*) AS live FROM refresh_tokens WHERE user_id = ? AND revoked_at IS NULL', [hrId]);
    assert.ok(Number(live) >= 1);
    assert.equal((await call('POST', `/api/administration/users/${hrId}/reset-password`, { token: owner })).status, 200);
    const [[{ after }]] = await pool.query('SELECT COUNT(*) AS after FROM refresh_tokens WHERE user_id = ? AND revoked_at IS NULL', [hrId]);
    assert.equal(Number(after), 0);

    // an expired support session no longer reaches the company
    const g = await call('POST', '/api/platform/support-access', { token: tok.support, body: { tenantId: tid, reason: 'Checking the identity lifecycle', accessType: 'read_only', durationMinutes: 15 } });
    assert.equal(g.status, 201);
    assert.equal((await call('GET', `/api/platform/tenants/${tid}`, { token: tok.support })).status, 200);
    await pool.query("UPDATE support_access_sessions SET expires_at = DATE_SUB(NOW(), INTERVAL 1 MINUTE) WHERE tenant_id = ?", [tid]);
    assert.equal((await call('GET', `/api/platform/tenants/${tid}`, { token: tok.support })).status, 403);

    // a suspended company cannot write; reactivation restores it
    const [[sub]] = await pool.query("SELECT id FROM subscriptions WHERE tenant_id = ? ORDER BY id DESC LIMIT 1", [tid]);
    assert.equal((await call('POST', `/api/platform/subscriptions/${sub.id}/transition`, { token: tok.billing, body: { status: 'suspended', reason: 'Non-payment: invoice overdue' } })).status, 200);
    assert.equal((await call('POST', '/api/org/holidays', { token: owner, body: { name: 'Blocked', hdate: '2026-12-25' } })).status, 402);
    assert.equal((await call('GET', '/api/employees?limit=1', { token: owner })).status, 200);
    assert.equal((await call('POST', `/api/platform/subscriptions/${sub.id}/transition`, { token: tok.billing, body: { status: 'active', reason: 'Payment received' } })).status, 200);
    assert.equal((await call('POST', '/api/org/holidays', { token: owner, body: { name: 'Allowed', hdate: '2026-12-26' } })).status, 201);
  });
});

describe('usage alerts do not spam', () => {
  test('crossing a threshold notifies operators once per month and severity', async () => {
    const [[ent]] = await pool.query("SELECT id FROM entitlements WHERE entitlement_key = 'employees.max'");
    const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM employees WHERE tenant_id = ? AND deleted_at IS NULL', [tenantId]);
    await pool.query('DELETE FROM tenant_entitlement_overrides WHERE tenant_id = ?', [tenantId]);
    await pool.query("INSERT INTO tenant_entitlement_overrides (tenant_id, entitlement_id, value, reason, status) VALUES (?,?,?,?, 'active')", [tenantId, ent.id, String(Math.ceil(Number(n) / 0.9)), 'alert test']);
    entitlements.invalidateAll();
    const first = await lifecycle.usageAlerts({ report: {}, force: true });
    const second = await lifecycle.usageAlerts({ report: {}, force: true });
    assert.ok(first >= 1, 'the first pass notifies');
    assert.equal(second, 0, 'the second pass sends nothing new');
    const [[{ k }]] = await pool.query("SELECT COUNT(*) AS k FROM notifications WHERE tenant_id = ? AND ntype = 'usage.limit'", [tenantId]);
    assert.ok(Number(k) >= 1, 'the company owner is told in-app');
  });
});
