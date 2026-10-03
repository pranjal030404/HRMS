/**
 * Payment-provider abstraction.
 *
 * The business layer never talks to a gateway. A provider is a small adapter that can
 *   - `verify(rawBody, headers)`  prove the request really came from the provider, and
 *   - `parse(body)`               turn its payload into one normalised event.
 * Everything after that — idempotency, applying money to an invoice, moving a subscription —
 * is provider-independent and lives here.
 *
 * The frontend is never a source of truth for a payment. The only way money is applied
 * automatically is a verified provider event; the manual `recordPayment` path stays for
 * bank transfers and is performed by an authorised operator.
 *
 * Shipped adapter: `signed` — a generic HMAC-SHA256 webhook (the shape most gateways use).
 * Gateway-specific adapters (Razorpay, Stripe, …) are added to PROVIDERS; no other code changes.
 */
const crypto = require('crypto');
const { pool } = require('../config/db');
const { HttpError } = require('../utils/helpers');
const billing = require('./billing');
const subscriptions = require('./subscriptions');
const { logPlatformAudit } = require('./platformAudit');

const REPLAY_WINDOW_MS = 5 * 60 * 1000;
const SYSTEM = { id: null, name: 'Payment provider', email: null, role: 'system' };

const timingSafe = (a, b) => {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

const PROVIDERS = {
  signed: {
    secret: () => process.env.BILLING_WEBHOOK_SECRET || '',
    /** Header `x-arthvex-signature: t=<unix ms>,v1=<hex hmac of "<t>.<raw body>">`. */
    verify(raw, headers) {
      const secret = this.secret();
      if (!secret) return { ok: false, reason: 'webhook secret is not configured' };
      const header = String(headers['x-arthvex-signature'] || '');
      const parts = Object.fromEntries(header.split(',').map((p) => p.trim().split('=')).filter((p) => p.length === 2));
      if (!parts.t || !parts.v1) return { ok: false, reason: 'missing signature' };
      if (Math.abs(Date.now() - Number(parts.t)) > REPLAY_WINDOW_MS) return { ok: false, reason: 'signature timestamp outside the replay window' };
      const expected = crypto.createHmac('sha256', secret).update(`${parts.t}.${raw}`).digest('hex');
      return timingSafe(expected, parts.v1) ? { ok: true } : { ok: false, reason: 'signature mismatch' };
    },
    /** { id, type, invoiceNumber, amount, reference, method } */
    parse(body) {
      return {
        id: String(body.id || ''), type: String(body.type || ''),
        invoiceNumber: body.data?.invoice_number ? String(body.data.invoice_number) : null,
        amount: Number(body.data?.amount), reference: body.data?.reference ? String(body.data.reference) : null,
        method: body.data?.method || 'card',
      };
    },
  },
};

const sign = (secret, raw, t = Date.now()) =>
  `t=${t},v1=${crypto.createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex')}`;

/**
 * Handle one webhook delivery. Returns { status, duplicate, outcome }.
 * Safe to call any number of times with the same event.
 */
async function handleWebhook(providerName, rawBody, headers, { requestId } = {}) {
  const provider = PROVIDERS[providerName];
  if (!provider) throw new HttpError(404, 'Unknown payment provider');
  const check = provider.verify(rawBody, headers);
  if (!check.ok) throw new HttpError(401, `Webhook rejected: ${check.reason}`);

  let body;
  try { body = JSON.parse(rawBody); } catch { throw new HttpError(400, 'Webhook body is not valid JSON'); }
  const ev = provider.parse(body);
  if (!ev.id || !ev.type) throw new HttpError(400, 'Webhook event needs an id and a type');
  const hash = crypto.createHash('sha256').update(rawBody).digest('hex');

  // Idempotency: the (provider, event id) key. A replay of a processed event changes nothing.
  try {
    await pool.query(
      `INSERT INTO payment_provider_events (provider, event_id, event_type, payload_hash, request_id) VALUES (?,?,?,?,?)`,
      [providerName, ev.id, ev.type, hash, requestId || null]);
  } catch (e) {
    if (e.code !== 'ER_DUP_ENTRY') throw e;
    const [[prior]] = await pool.query('SELECT status FROM payment_provider_events WHERE provider = ? AND event_id = ?', [providerName, ev.id]);
    if (prior.status !== 'failed') return { duplicate: true, outcome: prior.status };
    // A previous attempt failed part-way: allow exactly one retry path through the same event id.
    await pool.query('UPDATE payment_provider_events SET attempts = attempts + 1, status = \'received\' WHERE provider = ? AND event_id = ?', [providerName, ev.id]);
  }

  try {
    const outcome = await apply(providerName, ev);
    await pool.query(
      `UPDATE payment_provider_events SET status = ?, tenant_id = ?, invoice_id = ?, processed_at = NOW(), error = NULL WHERE provider = ? AND event_id = ?`,
      [outcome.ignored ? 'ignored' : 'processed', outcome.tenantId || null, outcome.invoiceId || null, providerName, ev.id]);
    return { duplicate: false, outcome: outcome.ignored ? 'ignored' : 'processed', detail: outcome.detail };
  } catch (e) {
    await pool.query(
      `UPDATE payment_provider_events SET status = 'failed', error = ? WHERE provider = ? AND event_id = ?`,
      [String(e.message).slice(0, 500), providerName, ev.id]);
    throw e;
  }
}

async function apply(providerName, ev) {
  if (!ev.invoiceNumber) return { ignored: true, detail: 'event carries no invoice' };
  const [[inv]] = await pool.query('SELECT * FROM subscription_invoices WHERE invoice_number = ?', [ev.invoiceNumber]);
  if (!inv) throw new HttpError(404, `No invoice ${ev.invoiceNumber}`);
  const ctx = { tenantId: inv.tenant_id, invoiceId: inv.id };

  if (ev.type === 'payment.succeeded') {
    if (!(ev.amount > 0)) throw new HttpError(400, 'Payment amount must be positive');
    try {
      const r = await billing.recordPayment(inv.id, {
        amount: ev.amount, method: ev.method, reference: ev.reference, provider: providerName,
        providerRef: ev.reference || ev.id,
      }, { actor: SYSTEM, reason: `${providerName} event ${ev.id}` });
      return { ...ctx, detail: { settled: r.invoice.status === 'paid', subscriptionRestored: r.subscriptionRestored } };
    } catch (e) {
      // The provider re-sent the same payment under a new event id: already applied, nothing to do.
      if (e.extra?.alreadyApplied) return { ...ctx, ignored: true, detail: 'payment already applied' };
      throw e;
    }
  }
  if (ev.type === 'payment.failed') {
    const [[sub]] = await pool.query('SELECT id, status FROM subscriptions WHERE id = ?', [inv.subscription_id]);
    if (sub && sub.status === 'active') {
      await subscriptions.transition(sub.id, 'past_due', { actor: SYSTEM, reason: `Payment failed (${providerName} event ${ev.id}) for ${inv.invoice_number}` });
    }
    await require('./platformNotifications').notify({
      event: 'payment_failed', severity: 'critical', tenantId: inv.tenant_id,
      title: `Payment failed for ${inv.invoice_number}`, body: ev.reference || null, dedupe: `pay-failed:${inv.id}:${ev.id}`,
    });
    return { ...ctx, detail: { subscription: sub?.status } };
  }
  if (ev.type === 'refund.succeeded') {
    try {
      const r = await billing.recordRefund(inv.id, {
        amount: ev.amount, reference: ev.reference, provider: providerName, providerRef: `refund:${ev.reference || ev.id}`,
      }, { actor: SYSTEM, reason: `${providerName} event ${ev.id}` });
      return { ...ctx, detail: { invoiceStatus: r.status } };
    } catch (e) {
      if (e.extra?.alreadyApplied) return { ...ctx, ignored: true, detail: 'refund already applied' };
      throw e;
    }
  }
  return { ...ctx, ignored: true, detail: `unhandled event type ${ev.type}` };
}

module.exports = { handleWebhook, sign, PROVIDERS };
