/**
 * Platform billing (spec §3 Billing Admin): commercial terms, invoices, payments.
 *
 * Payments reach an invoice two ways: an operator records a bank transfer / UPI / cheque, or a
 * verified provider webhook is applied by `services/payments.js` (idempotent on the provider's
 * own reference). No gateway adapter beyond the generic signed webhook ships with the product;
 * nothing here pretends otherwise.
 *
 * Money is held as DECIMAL and computed in integer paise so 0.1 + 0.2 never
 * decides what a customer owes.
 */
const { pool } = require('../config/db');
const { HttpError } = require('../utils/helpers');
const { logPlatformAudit } = require('./platformAudit');
const subscriptions = require('./subscriptions');
const entitlements = require('./entitlements');

const paise = (n) => Math.round(Number(n || 0) * 100);
const rupees = (p) => Math.round(p) / 100;
const needReason = (reason) => {
  const r = String(reason || '').trim();
  if (r.length < 5) throw new HttpError(400, 'A reason is required — billing changes are recorded against it');
  return r;
};

/** Edit commercial terms on a subscription: discount, price, trial end, renewal. */
async function updateTerms(subscriptionId, input, { actor, req, reason }) {
  needReason(reason);
  const [[sub]] = await pool.query('SELECT * FROM subscriptions WHERE id = ?', [subscriptionId]);
  if (!sub) throw new HttpError(404, 'Subscription not found');
  const sets = []; const params = []; const before = {}; const after = {};
  const set = (col, val) => { sets.push(`${col} = ?`); params.push(val); before[col] = sub[col]; after[col] = val; };

  if (input.discount_pct !== undefined) {
    const d = Number(input.discount_pct);
    if (!Number.isFinite(d) || d < 0 || d > 100) throw new HttpError(400, 'discount_pct must be between 0 and 100');
    set('discount_pct', d);
  }
  if (input.price_per_period !== undefined) {
    const p = Number(input.price_per_period);
    if (!Number.isFinite(p) || p < 0) throw new HttpError(400, 'price_per_period must be zero or more');
    set('price_per_period', p);
  }
  if (input.trial_ends_at !== undefined) {
    if (sub.status !== 'trialing') throw new HttpError(409, 'Only a subscription that is currently trialing has a trial to extend');
    const t = new Date(input.trial_ends_at);
    if (Number.isNaN(t.getTime())) throw new HttpError(400, 'trial_ends_at is not a valid date');
    if (t.getTime() < Date.now()) throw new HttpError(400, 'trial_ends_at must be in the future');
    if (t.getTime() > Date.now() + 120 * 86_400_000) throw new HttpError(400, 'A trial cannot run more than 120 days from now');
    set('trial_ends_at', t);
  }
  if (input.auto_renew !== undefined) set('auto_renew', input.auto_renew ? 1 : 0);
  if (input.notes !== undefined) set('notes', String(input.notes).slice(0, 500));
  if (!sets.length) throw new HttpError(400, 'Nothing to change');

  await pool.query(`UPDATE subscriptions SET ${sets.join(', ')} WHERE id = ?`, [...params, subscriptionId]);
  entitlements.invalidateTenant(sub.tenant_id);
  await logPlatformAudit({
    tenantId: sub.tenant_id, actor, action: 'subscription.terms_changed', category: 'subscription',
    entityType: 'subscription', entityId: subscriptionId, before, after, reason, req,
  });
  const [[row]] = await pool.query('SELECT * FROM subscriptions WHERE id = ?', [subscriptionId]);
  return row;
}

/**
 * Issue an invoice for one billing period. One invoice per (subscription, period):
 * issuing twice is refused rather than double-billing the customer.
 */
async function createInvoice(subscriptionId, { periodStart, periodEnd, taxPct = 0, dueDays = 15, notes } = {}, { actor, req, reason }) {
  needReason(reason);
  const [[sub]] = await pool.query('SELECT * FROM subscriptions WHERE id = ?', [subscriptionId]);
  if (!sub) throw new HttpError(404, 'Subscription not found');
  if (['cancelled', 'expired'].includes(sub.status)) throw new HttpError(409, `A ${sub.status} subscription cannot be invoiced`);
  const start = new Date(periodStart || sub.current_period_start || Date.now());
  const end = new Date(periodEnd || sub.current_period_end || Date.now() + 30 * 86_400_000);
  if ([start, end].some((d) => Number.isNaN(d.getTime())) || end <= start) throw new HttpError(400, 'The billing period is not valid');
  const tax = Number(taxPct);
  if (!Number.isFinite(tax) || tax < 0 || tax > 100) throw new HttpError(400, 'taxPct must be between 0 and 100');

  const subtotal = paise(sub.price_per_period);
  const discount = Math.round(subtotal * (Number(sub.discount_pct || 0) / 100));
  const taxable = subtotal - discount;
  const taxAmt = Math.round(taxable * (tax / 100));
  const total = taxable + taxAmt;
  const ymd = (d) => d.toISOString().slice(0, 10);
  const number = `AV-${String(sub.tenant_id).padStart(4, '0')}-${ymd(start).replace(/-/g, '').slice(0, 6)}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  const due = new Date(Date.now() + Number(dueDays) * 86_400_000);

  let id;
  try {
    const [ins] = await pool.query(
      `INSERT INTO subscription_invoices
         (tenant_id, subscription_id, invoice_number, period_start, period_end, currency, subtotal, discount, tax_pct, tax, total, due_at, notes, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [sub.tenant_id, sub.id, number, ymd(start), ymd(end), sub.currency || 'INR', rupees(subtotal), rupees(discount), tax,
        rupees(taxAmt), rupees(total), ymd(due), notes ? String(notes).slice(0, 500) : null, actor?.id ?? null]
    );
    id = ins.insertId;
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') throw new HttpError(409, 'An invoice already exists for this subscription and period');
    throw e;
  }
  await logPlatformAudit({
    tenantId: sub.tenant_id, actor, action: 'subscription.invoice_issued', category: 'subscription',
    entityType: 'subscription_invoice', entityId: id, after: { number, total: rupees(total), period: [ymd(start), ymd(end)] }, reason, req,
  });
  return getInvoice(id);
}

async function getInvoice(id) {
  const [[inv]] = await pool.query(
    `SELECT i.*, t.name AS tenant_name,
            (i.status = 'open' AND i.due_at IS NOT NULL AND i.due_at < CURDATE()) AS overdue
       FROM subscription_invoices i JOIN tenants t ON t.id = i.tenant_id WHERE i.id = ?`, [id]
  );
  if (!inv) throw new HttpError(404, 'Invoice not found');
  const [payments] = await pool.query('SELECT * FROM subscription_payments WHERE invoice_id = ? ORDER BY received_at', [id]);
  return { ...inv, overdue: !!inv.overdue, outstanding: rupees(paise(inv.total) - paise(inv.amount_paid)), payments };
}

/**
 * Record money received. Over-payment is refused; a payment that settles the
 * invoice moves a past-due/grace subscription back to active — but never
 * un-suspends one, because a suspension is a deliberate human decision.
 */
async function recordPayment(invoiceId, { amount, method = 'bank_transfer', reference, receivedAt, note, provider, providerRef }, { actor, req, reason }) {
  needReason(reason);
  const pay = paise(amount);
  if (!(pay > 0)) throw new HttpError(400, 'amount must be greater than zero');
  if (!['bank_transfer', 'card', 'upi', 'cheque', 'cash', 'other'].includes(method)) throw new HttpError(400, 'Unknown payment method');
  const when = receivedAt ? new Date(receivedAt) : new Date();
  if (Number.isNaN(when.getTime()) || when.getTime() > Date.now() + 86_400_000) throw new HttpError(400, 'receivedAt is not a valid past date');

  const conn = await pool.getConnection();
  let inv; let settled = false;
  try {
    await conn.beginTransaction();
    // Lock the row so two concurrent payments cannot both pass the over-payment check.
    const [[row]] = await conn.query('SELECT * FROM subscription_invoices WHERE id = ? FOR UPDATE', [invoiceId]);
    if (!row) throw new HttpError(404, 'Invoice not found');
    if (row.status !== 'open') throw new HttpError(409, `A ${row.status} invoice cannot take a payment`);
    const outstanding = paise(row.total) - paise(row.amount_paid);
    if (pay > outstanding) throw new HttpError(400, `That exceeds the amount outstanding (${rupees(outstanding)})`);
    await conn.query(
      `INSERT INTO subscription_payments (tenant_id, invoice_id, amount, method, provider, provider_ref, reference, received_at, note, recorded_by)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [row.tenant_id, invoiceId, rupees(pay), method, provider || null, providerRef ? String(providerRef).slice(0, 120) : null,
        reference ? String(reference).slice(0, 120) : null, when,
        note ? String(note).slice(0, 500) : null, actor?.id ?? null]
    );
    settled = pay === outstanding;
    await conn.query(
      `UPDATE subscription_invoices SET amount_paid = ?, status = ?, paid_at = ? WHERE id = ?`,
      [rupees(paise(row.amount_paid) + pay), settled ? 'paid' : 'open', settled ? new Date() : null, invoiceId]
    );
    inv = row;
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    // The same provider reference can never be applied twice, whatever event id carried it.
    if (e.code === 'ER_DUP_ENTRY' && provider) throw new HttpError(409, 'That provider payment was already applied', { alreadyApplied: true });
    throw e;
  } finally {
    conn.release();
  }

  let restored = false;
  if (settled) {
    const [[open]] = await pool.query(
      `SELECT COUNT(*) AS n FROM subscription_invoices WHERE subscription_id = ? AND status = 'open' AND due_at < CURDATE()`, [inv.subscription_id]
    );
    const [[sub]] = await pool.query('SELECT status FROM subscriptions WHERE id = ?', [inv.subscription_id]);
    if (['past_due', 'grace_period'].includes(sub.status) && !Number(open.n)) {
      await subscriptions.transition(inv.subscription_id, 'active', { actor, req, reason: `Payment received for ${inv.invoice_number}` });
      restored = true;
    }
  }
  await logPlatformAudit({
    tenantId: inv.tenant_id, actor, action: 'subscription.payment_recorded', category: 'subscription',
    entityType: 'subscription_invoice', entityId: invoiceId,
    after: { amount: rupees(pay), method, reference: reference || null, settled, subscriptionRestored: restored }, reason, req,
  });
  return { invoice: await getInvoice(invoiceId), subscriptionRestored: restored };
}

/**
 * Refund (full or partial) money previously received. Reduces `amount_paid`, re-opens an invoice
 * that is no longer fully paid, and keeps the original payment rows untouched — a refund is its
 * own row, so the ledger can always be re-added up.
 */
async function recordRefund(invoiceId, { amount, reference, provider, providerRef, note }, { actor, req, reason }) {
  needReason(reason);
  const back = paise(amount);
  if (!(back > 0)) throw new HttpError(400, 'amount must be greater than zero');
  const conn = await pool.getConnection();
  let row;
  try {
    await conn.beginTransaction();
    [[row]] = await conn.query('SELECT * FROM subscription_invoices WHERE id = ? FOR UPDATE', [invoiceId]);
    if (!row) throw new HttpError(404, 'Invoice not found');
    if (row.status === 'void') throw new HttpError(409, 'A void invoice cannot be refunded');
    if (back > paise(row.amount_paid)) throw new HttpError(400, `That exceeds what was paid (${rupees(paise(row.amount_paid))})`);
    await conn.query(
      `INSERT INTO subscription_payments (tenant_id, invoice_id, kind, amount, method, provider, provider_ref, reference, received_at, note, recorded_by)
       VALUES (?,?, 'refund', ?, 'other', ?,?,?, NOW(), ?, ?)`,
      [row.tenant_id, invoiceId, rupees(back), provider || null, providerRef ? String(providerRef).slice(0, 120) : null,
        reference ? String(reference).slice(0, 120) : null, note ? String(note).slice(0, 500) : null, actor?.id ?? null]);
    const paidAfter = paise(row.amount_paid) - back;
    const status = paidAfter >= paise(row.total) ? 'paid' : 'open';
    await conn.query('UPDATE subscription_invoices SET amount_paid = ?, status = ?, paid_at = ? WHERE id = ?',
      [rupees(paidAfter), status, status === 'paid' ? row.paid_at : null, invoiceId]);
    await conn.commit();
    row = { ...row, status, amount_paid: rupees(paidAfter) };
  } catch (e) {
    await conn.rollback();
    if (e.code === 'ER_DUP_ENTRY' && provider) throw new HttpError(409, 'That provider refund was already applied', { alreadyApplied: true });
    throw e;
  } finally {
    conn.release();
  }
  await logPlatformAudit({
    tenantId: row.tenant_id, actor, action: 'subscription.refund_recorded', category: 'subscription',
    entityType: 'subscription_invoice', entityId: invoiceId, after: { amount: rupees(back), status: row.status, provider: provider || null }, reason, req,
  });
  return row;
}

async function voidInvoice(invoiceId, { actor, req, reason }) {
  needReason(reason);
  const [[inv]] = await pool.query('SELECT * FROM subscription_invoices WHERE id = ?', [invoiceId]);
  if (!inv) throw new HttpError(404, 'Invoice not found');
  if (inv.status !== 'open') throw new HttpError(409, `A ${inv.status} invoice cannot be voided`);
  if (paise(inv.amount_paid) > 0) throw new HttpError(409, 'An invoice with payments recorded cannot be voided');
  await pool.query(`UPDATE subscription_invoices SET status = 'void', voided_at = NOW(), void_reason = ? WHERE id = ?`, [reason, invoiceId]);
  await logPlatformAudit({
    tenantId: inv.tenant_id, actor, action: 'subscription.invoice_voided', category: 'subscription',
    entityType: 'subscription_invoice', entityId: invoiceId, before: { status: 'open', total: inv.total }, after: { status: 'void' }, reason, req,
  });
  return getInvoice(invoiceId);
}

async function listInvoices({ tenantId, status, overdueOnly, limit = 50, offset = 0 } = {}) {
  const where = []; const params = [];
  if (tenantId) { where.push('i.tenant_id = ?'); params.push(tenantId); }
  if (status) { where.push('i.status = ?'); params.push(status); }
  if (overdueOnly) where.push(`i.status = 'open' AND i.due_at < CURDATE()`);
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM subscription_invoices i ${clause}`, params);
  const [rows] = await pool.query(
    `SELECT i.*, t.name AS tenant_name, (i.status = 'open' AND i.due_at < CURDATE()) AS overdue
       FROM subscription_invoices i JOIN tenants t ON t.id = i.tenant_id ${clause}
      ORDER BY i.id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]
  );
  const [[sum]] = await pool.query(
    `SELECT COALESCE(SUM(CASE WHEN status='open' THEN total - amount_paid END),0) AS outstanding,
            COALESCE(SUM(CASE WHEN status='open' AND due_at < CURDATE() THEN total - amount_paid END),0) AS overdue,
            COALESCE(SUM(amount_paid),0) AS collected
       FROM subscription_invoices ${tenantId ? 'WHERE tenant_id = ?' : ''}`, tenantId ? [tenantId] : []
  );
  return {
    rows: rows.map((r) => ({ ...r, overdue: !!r.overdue })), total: Number(total),
    summary: { outstanding: Number(sum.outstanding), overdue: Number(sum.overdue), collected: Number(sum.collected) },
  };
}

module.exports = { updateTerms, createInvoice, recordPayment, recordRefund, voidInvoice, getInvoice, listInvoices };
