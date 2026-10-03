/**
 * Company-owner self-service: plan, subscription, usage, invoices, billing contacts, setup health
 * and ARTHVEX support tickets. Everything is scoped to the caller's own company (`req.user.tenant_id`);
 * a tenant can ask for a cancellation at period end but cannot cancel immediately, change price or
 * touch another company — those stay with ARTHVEX.
 */
const express = require('express');
const { pool } = require('../config/db');
const { asyncH, HttpError } = require('../utils/helpers');
const { authenticate, requirePermission } = require('../middleware/auth');
const entitlements = require('../services/entitlements');
const subscriptions = require('../services/subscriptions');
const setupHealth = require('../services/setupHealth');

const r = express.Router();
r.use(authenticate);
r.use((req, res, next) => (req.user.tenant_id == null ? next(new HttpError(403, 'This is a company-side area')) : next()));

const VIEW = requirePermission('settings.manage', { anyOf: ['settings.manage', 'billing.view', 'administration.dashboard.view'] });
const MANAGE = requirePermission('settings.manage');
const T = (req) => req.user.tenant_id;

r.get('/subscription', VIEW, asyncH(async (req, res) => {
  const snap = await entitlements.resolveTenant(T(req), { bypassCache: true });
  const sub = snap.subscription ? (await pool.query('SELECT * FROM subscriptions WHERE id = ?', [snap.subscription.id]))[0][0] : null;
  const usage = Object.values(snap.entitlements)
    .filter((e) => e.kind !== 'boolean' && !e.unlimited && e.value > 0)
    .map((e) => ({ key: e.key, name: e.name, limit: e.value, unit: e.unit, source: e.source, addons: e.addons }));
  const usageSvc = require('../services/usage');
  for (const u of usage) u.current = await usageSvc.currentUsage(T(req), u.key).catch(() => null);
  const [invoices] = await pool.query(
    `SELECT invoice_number, period_start, period_end, total, amount_paid, status, due_at FROM subscription_invoices WHERE tenant_id = ? ORDER BY id DESC LIMIT 24`, [T(req)]);
  const [addons] = await pool.query(
    `SELECT a.addon_key, a.name, ta.quantity FROM tenant_addons ta JOIN addons a ON a.id = ta.addon_id WHERE ta.tenant_id = ? AND ta.status = 'active'`, [T(req)]);
  const trialDaysLeft = sub?.status === 'trialing' && sub.trial_ends_at ? Math.max(0, Math.ceil((new Date(sub.trial_ends_at) - Date.now()) / 86400000)) : null;
  res.json({
    data: {
      plan: snap.plan, status: sub?.status || null, tenantStatus: snap.tenant.status, readOnly: snap.readOnly,
      billingCycle: sub?.billing_cycle || null, currentPeriodEnd: sub?.current_period_end || null,
      trial: sub?.status === 'trialing' ? { endsAt: sub.trial_ends_at, daysLeft: trialDaysLeft, extensions: sub.trial_extensions } : null,
      cancellation: sub?.cancel_at_period_end ? { effectiveAt: sub.cancel_effective_at, requestedAt: sub.cancel_requested_at } : null,
      graceEndsAt: sub?.grace_ends_at || null,
      modules: Object.values(snap.entitlements).filter((e) => e.kind === 'boolean' && e.moduleKey && e.key.endsWith('.enabled')).map((e) => ({ key: e.key, name: e.name, enabled: e.enabled })),
      usage, addons, invoices,
    },
  });
}));

/** Ask for cancellation at the end of the paid period. Immediate cancellation is ARTHVEX-side. */
r.post('/subscription/cancel', MANAGE, asyncH(async (req, res) => {
  const [[sub]] = await pool.query("SELECT id FROM subscriptions WHERE tenant_id = ? AND status NOT IN ('cancelled','expired') ORDER BY id DESC LIMIT 1", [T(req)]);
  if (!sub) throw new HttpError(404, 'There is no live subscription to cancel');
  const out = await subscriptions.requestCancellation({ subscriptionId: sub.id, mode: 'period_end', reason: req.body?.reason, actor: req.user, req });
  res.json({ data: { cancelAtPeriodEnd: !!out.cancel_at_period_end, effectiveAt: out.cancel_effective_at } });
}));
r.post('/subscription/cancel/withdraw', MANAGE, asyncH(async (req, res) => {
  const [[sub]] = await pool.query("SELECT id FROM subscriptions WHERE tenant_id = ? AND cancel_at_period_end = 1 ORDER BY id DESC LIMIT 1", [T(req)]);
  if (!sub) throw new HttpError(404, 'No cancellation is scheduled');
  await subscriptions.withdrawCancellation({ subscriptionId: sub.id, actor: req.user, req, reason: 'Withdrawn by the company' });
  res.json({ ok: true });
}));

// ------------------------------------------------------------- billing contacts
r.get('/contacts', VIEW, asyncH(async (req, res) => {
  const [rows] = await pool.query('SELECT id, contact_type, name, email, phone, gstin FROM tenant_contacts WHERE tenant_id = ? ORDER BY contact_type', [T(req)]);
  res.json({ data: rows });
}));
r.put('/contacts', MANAGE, asyncH(async (req, res) => {
  const { contactType, name, email, phone, gstin } = req.body || {};
  if (!['billing', 'finance', 'legal', 'technical'].includes(contactType)) throw new HttpError(400, 'Invalid contact type');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(email || ''))) throw new HttpError(400, 'A valid email is required');
  if (gstin && !/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(String(gstin).toUpperCase())) throw new HttpError(400, 'That GSTIN is not in a valid format');
  await pool.query(
    `INSERT INTO tenant_contacts (tenant_id, contact_type, name, email, phone, gstin) VALUES (?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE name = VALUES(name), phone = VALUES(phone), gstin = VALUES(gstin)`,
    [T(req), contactType, name || null, String(email).toLowerCase().trim(), phone || null, gstin ? String(gstin).toUpperCase() : null]);
  res.json({ ok: true });
}));

// --------------------------------------------------------------- setup health
r.get('/setup-health', VIEW, asyncH(async (req, res) => {
  res.json({ data: await setupHealth.setupChecks(T(req)) });
}));
r.get('/data-quality', VIEW, asyncH(async (req, res) => {
  res.json({ data: await setupHealth.dataQuality(T(req)) });
}));

// --------------------------------------------------------- ARTHVEX support tickets
r.get('/support-tickets', VIEW, asyncH(async (req, res) => {
  const [tickets] = await pool.query(
    'SELECT id, ticket_no, subject, category, priority, status, created_at, resolved_at, resolution FROM support_tickets WHERE tenant_id = ? ORDER BY id DESC LIMIT 100', [T(req)]);
  res.json({ data: tickets });
}));
r.post('/support-tickets', MANAGE, asyncH(async (req, res) => {
  const { subject, body, category = 'other', priority = 'normal' } = req.body || {};
  if (String(subject || '').trim().length < 5) throw new HttpError(400, 'A subject of at least 5 characters is required');
  if (!['billing', 'technical', 'payroll', 'data', 'access', 'other'].includes(category) || !['low', 'normal', 'high', 'urgent'].includes(priority)) throw new HttpError(400, 'Invalid category or priority');
  const ticketNo = `SUP-${Date.now().toString().slice(-7)}${Math.floor(Math.random() * 90 + 10)}`;
  const [ins] = await pool.query(
    'INSERT INTO support_tickets (ticket_no, tenant_id, subject, body, category, priority, requester_user_id, requester_name) VALUES (?,?,?,?,?,?,?,?)',
    [ticketNo, T(req), String(subject).trim(), body || null, category, priority, req.user.id, req.user.name]);
  res.status(201).json({ data: { id: ins.insertId, ticketNo } });
}));
r.get('/support-tickets/:id', VIEW, asyncH(async (req, res) => {
  const [[t]] = await pool.query('SELECT * FROM support_tickets WHERE id = ? AND tenant_id = ?', [req.params.id, T(req)]);
  if (!t) throw new HttpError(404, 'Ticket not found');
  // Customers only ever see notes explicitly marked customer-visible.
  const [notes] = await pool.query("SELECT author_name, body, created_at FROM support_ticket_notes WHERE ticket_id = ? AND visibility = 'customer' ORDER BY created_at", [t.id]);
  res.json({ data: { id: t.id, ticket_no: t.ticket_no, subject: t.subject, status: t.status, priority: t.priority, resolution: t.resolution, notes } });
}));

module.exports = r;
