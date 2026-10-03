/**
 * Commercial operations of the control plane: add-ons, trials, cancellation, refunds,
 * ARTHVEX support tickets, incidents, maintenance windows, notifications and retention.
 * Everything here is platform-owned data; none of it reads a customer's HR records.
 */
const express = require('express');
const { pool } = require('../../config/db');
const { asyncH, HttpError } = require('../../utils/helpers');
const { requirePermission } = require('../../middleware/auth');
const platformAudit = require('../../services/platformAudit');
const subscriptions = require('../../services/subscriptions');
const billing = require('../../services/billing');
const entitlements = require('../../services/entitlements');
const pn = require('../../services/platformNotifications');

const int = (v, d = null) => (v === undefined || v === null || v === '' || Number.isNaN(Number(v)) ? d : parseInt(v, 10));
const reasonOf = (v, min = 5) => {
  const r = String(v || '').trim();
  if (r.length < min) throw new HttpError(400, `A reason of at least ${min} characters is required — it is recorded in the audit trail`);
  return r;
};
const parse = (v, d) => { if (v == null) return d; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return d; } };

module.exports = function commercialRouter() {
  const r = express.Router();
  const SUBS_MANAGE = requirePermission('platform.subscriptions.manage');
  const SUBS_VIEW = requirePermission('platform.subscriptions.view');

  // =================================================================== trials / cancel
  r.post('/subscriptions/:id/trial/extend', SUBS_MANAGE, asyncH(async (req, res) => {
    const sub = await subscriptions.extendTrial({ subscriptionId: int(req.params.id), days: req.body?.days, actor: req.user, req, reason: req.body?.reason });
    res.json({ data: sub });
  }));
  r.post('/subscriptions/:id/trial/convert', SUBS_MANAGE, asyncH(async (req, res) => {
    const sub = await subscriptions.convertTrial({ subscriptionId: int(req.params.id), planKey: req.body?.planKey, actor: req.user, req, reason: req.body?.reason });
    res.json({ data: sub });
  }));
  r.post('/subscriptions/:id/cancel', SUBS_MANAGE, asyncH(async (req, res) => {
    const sub = await subscriptions.requestCancellation({ subscriptionId: int(req.params.id), mode: req.body?.mode, reason: req.body?.reason, actor: req.user, req });
    res.json({ data: sub });
  }));
  r.post('/subscriptions/:id/cancel/withdraw', SUBS_MANAGE, asyncH(async (req, res) => {
    const sub = await subscriptions.withdrawCancellation({ subscriptionId: int(req.params.id), actor: req.user, req, reason: req.body?.reason });
    res.json({ data: sub });
  }));
  r.post('/subscriptions/:id/plan-preview', SUBS_VIEW, asyncH(async (req, res) => {
    res.json({ data: await subscriptions.previewPlanChange({ subscriptionId: int(req.params.id), planKey: req.body?.planKey }) });
  }));
  r.post('/billing/invoices/:id/refunds', SUBS_MANAGE, asyncH(async (req, res) => {
    const inv = await billing.recordRefund(int(req.params.id), { amount: req.body?.amount, reference: req.body?.reference, note: req.body?.note },
      { actor: req.user, req, reason: req.body?.reason });
    res.json({ data: inv });
  }));

  // ====================================================================== add-ons
  r.get('/addons', requirePermission('platform.plans.view'), asyncH(async (req, res) => {
    const [rows] = await pool.query('SELECT * FROM addons ORDER BY name');
    res.json({ data: rows.map((a) => ({ ...a, grants: parse(a.grants, []) })) });
  }));

  r.post('/addons', requirePermission('platform.plans.manage'), asyncH(async (req, res) => {
    const { addonKey, name, description, grants, priceMonthly = 0, priceModel = 'flat' } = req.body || {};
    const reason = reasonOf(req.body?.reason);
    if (!/^[a-z0-9_]{3,60}$/.test(String(addonKey || ''))) throw new HttpError(400, 'addonKey must be 3–60 chars of a-z, 0-9, _');
    if (!name) throw new HttpError(400, 'name is required');
    if (!Array.isArray(grants) || !grants.length) throw new HttpError(400, 'grants must be a non-empty array');
    const [known] = await pool.query('SELECT entitlement_key, kind FROM entitlements');
    const kinds = new Map(known.map((k) => [k.entitlement_key, k.kind]));
    for (const g of grants) {
      if (!kinds.has(g.key)) throw new HttpError(400, `Unknown entitlement "${g.key}"`);
      if (kinds.get(g.key) === 'boolean' ? g.value === undefined : !(Number(g.increment) > 0)) {
        throw new HttpError(400, `${g.key}: boolean entitlements need a value, numeric ones a positive increment`);
      }
    }
    if (!['flat', 'per_unit'].includes(priceModel) || !(Number(priceMonthly) >= 0)) throw new HttpError(400, 'Invalid pricing');
    try {
      const [ins] = await pool.query(
        'INSERT INTO addons (addon_key, name, description, grants, price_monthly, price_model) VALUES (?,?,?,?,?,?)',
        [addonKey, name, description || null, JSON.stringify(grants), Number(priceMonthly), priceModel]);
      await platformAudit.logPlatformAudit({ actor: req.user, action: 'plan.addon_created', category: 'plan', entityType: 'addon', entityId: ins.insertId, after: { addonKey, grants }, reason, req });
      res.status(201).json({ data: { id: ins.insertId, addonKey } });
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') throw new HttpError(409, 'An add-on with that key already exists');
      throw e;
    }
  }));

  r.get('/tenants/:id/addons', requirePermission('platform.subscriptions.view'), asyncH(async (req, res) => {
    const [rows] = await pool.query(
      `SELECT ta.id, ta.quantity, ta.status, ta.starts_at, ta.ends_at, a.addon_key, a.name, a.grants, a.price_monthly, a.price_model
         FROM tenant_addons ta JOIN addons a ON a.id = ta.addon_id WHERE ta.tenant_id = ? ORDER BY ta.created_at DESC`, [int(req.params.id)]);
    res.json({ data: rows.map((a) => ({ ...a, grants: parse(a.grants, []) })) });
  }));

  r.post('/tenants/:id/addons', requirePermission('platform.entitlements.manage'), asyncH(async (req, res) => {
    const tenantId = int(req.params.id);
    const reason = reasonOf(req.body?.reason);
    const qty = int(req.body?.quantity, 1);
    if (!(qty >= 1 && qty <= 10000)) throw new HttpError(400, 'quantity must be between 1 and 10000');
    const [[addon]] = await pool.query('SELECT * FROM addons WHERE addon_key = ? AND active = 1', [req.body?.addonKey]);
    if (!addon) throw new HttpError(404, 'Unknown or inactive add-on');
    const [[t]] = await pool.query('SELECT id FROM tenants WHERE id = ?', [tenantId]);
    if (!t) throw new HttpError(404, 'Tenant not found');
    try {
      const [ins] = await pool.query(
        'INSERT INTO tenant_addons (tenant_id, addon_id, quantity, starts_at, ends_at, reason, created_by) VALUES (?,?,?,?,?,?,?)',
        [tenantId, addon.id, qty, req.body?.startsAt || null, req.body?.endsAt || null, reason, req.user.id]);
      entitlements.invalidateTenant(tenantId);
      await platformAudit.logPlatformAudit({ tenantId, actor: req.user, action: 'entitlement.addon_attached', category: 'entitlement',
        entityType: 'tenant_addon', entityId: ins.insertId, after: { addonKey: addon.addon_key, quantity: qty }, reason, req });
      res.status(201).json({ data: { id: ins.insertId } });
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') throw new HttpError(409, 'That add-on is already active for this company — change its quantity instead');
      throw e;
    }
  }));

  r.delete('/tenants/:id/addons/:addonKey', requirePermission('platform.entitlements.manage'), asyncH(async (req, res) => {
    const tenantId = int(req.params.id);
    const reason = reasonOf(req.body?.reason ?? req.query?.reason);
    const [u] = await pool.query(
      `UPDATE tenant_addons ta JOIN addons a ON a.id = ta.addon_id SET ta.status = 'cancelled', ta.ends_at = NOW()
        WHERE ta.tenant_id = ? AND a.addon_key = ? AND ta.status = 'active'`, [tenantId, req.params.addonKey]);
    if (!u.affectedRows) throw new HttpError(404, 'No active add-on with that key');
    entitlements.invalidateTenant(tenantId);
    await platformAudit.logPlatformAudit({ tenantId, actor: req.user, action: 'entitlement.addon_removed', category: 'entitlement',
      entityType: 'tenant_addon', after: { addonKey: req.params.addonKey }, reason, req });
    res.json({ ok: true });
  }));

  // ================================================================ support tickets
  const TICKET_VIEW = requirePermission('platform.support.view');
  const TICKET_WRITE = requirePermission('platform.support.grant');
  const PRIORITIES = ['low', 'normal', 'high', 'urgent'];
  const CATEGORIES = ['billing', 'technical', 'payroll', 'data', 'access', 'other'];
  const STATUSES = ['open', 'in_progress', 'waiting_customer', 'resolved', 'closed'];

  async function slaFor(tenantId, priority) {
    const [[row]] = await pool.query(
      `SELECT s.first_response_minutes, s.resolution_minutes FROM tenants t
         JOIN platform_plans p ON p.plan_key = t.plan
         JOIN support_sla_policies s ON s.support_level = p.support_level AND s.priority = ?
        WHERE t.id = ?`, [priority, tenantId]);
    return row || null; // no configured policy = no promise
  }

  r.get('/support-tickets', TICKET_VIEW, asyncH(async (req, res) => {
    const where = []; const params = [];
    for (const [q, col] of [['status', 't.status'], ['priority', 't.priority'], ['tenantId', 't.tenant_id'], ['assignee', 't.assignee_id']]) {
      if (req.query[q]) { where.push(`${col} = ?`); params.push(req.query[q]); }
    }
    const limit = Math.min(100, int(req.query.limit, 25)); const page = Math.max(1, int(req.query.page, 1));
    const [rows] = await pool.query(
      `SELECT t.*, tn.name AS tenant_name, (t.sla_due_at IS NOT NULL AND t.status NOT IN ('resolved','closed') AND t.sla_due_at < NOW()) AS sla_breached
         FROM support_tickets t JOIN tenants tn ON tn.id = t.tenant_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY FIELD(t.priority,'urgent','high','normal','low'), t.created_at DESC LIMIT ? OFFSET ?`, [...params, limit, (page - 1) * limit]);
    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM support_tickets t ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`, params);
    res.json({ data: rows.map((x) => ({ ...x, sla_breached: !!x.sla_breached })), meta: { total: Number(total), page, pages: Math.ceil(Number(total) / limit), limit } });
  }));

  r.post('/support-tickets', TICKET_WRITE, asyncH(async (req, res) => {
    const { tenantId, subject, body, category = 'other', priority = 'normal', supportAccessRequested = false } = req.body || {};
    if (!int(tenantId)) throw new HttpError(400, 'tenantId is required');
    if (String(subject || '').trim().length < 5) throw new HttpError(400, 'A subject of at least 5 characters is required');
    if (!CATEGORIES.includes(category) || !PRIORITIES.includes(priority)) throw new HttpError(400, 'Invalid category or priority');
    const [[t]] = await pool.query('SELECT id FROM tenants WHERE id = ?', [int(tenantId)]);
    if (!t) throw new HttpError(404, 'Tenant not found');
    const sla = await slaFor(int(tenantId), priority);
    const ticketNo = `SUP-${Date.now().toString().slice(-7)}${Math.floor(Math.random() * 90 + 10)}`;
    const [ins] = await pool.query(
      `INSERT INTO support_tickets (ticket_no, tenant_id, subject, body, category, priority, requester_user_id, requester_name, sla_due_at, support_access_requested)
       VALUES (?,?,?,?,?,?,?,?, ${sla ? 'DATE_ADD(NOW(), INTERVAL ? MINUTE)' : 'NULL'}, ?)`,
      [ticketNo, int(tenantId), String(subject).trim(), body || null, category, priority, req.user.id, req.user.name,
        ...(sla ? [sla.resolution_minutes] : []), supportAccessRequested ? 1 : 0]);
    await platformAudit.logPlatformAudit({ tenantId: int(tenantId), actor: req.user, action: 'support.ticket_created', category: 'support',
      entityType: 'support_ticket', entityId: ins.insertId, after: { ticketNo, priority, category }, req });
    res.status(201).json({ data: { id: ins.insertId, ticketNo, slaDueConfigured: !!sla } });
  }));

  r.get('/support-tickets/:id', TICKET_VIEW, asyncH(async (req, res) => {
    const [[t]] = await pool.query('SELECT t.*, tn.name AS tenant_name FROM support_tickets t JOIN tenants tn ON tn.id = t.tenant_id WHERE t.id = ?', [int(req.params.id)]);
    if (!t) throw new HttpError(404, 'Ticket not found');
    const [notes] = await pool.query('SELECT * FROM support_ticket_notes WHERE ticket_id = ? ORDER BY created_at', [t.id]);
    const [sessions] = await pool.query(
      'SELECT id, access_type, status, expires_at, created_at FROM support_access_sessions WHERE tenant_id = ? AND ticket_ref = ? ORDER BY id DESC', [t.tenant_id, t.ticket_no]);
    res.json({ data: { ...t, notes, supportSessions: sessions } });
  }));

  r.patch('/support-tickets/:id', TICKET_WRITE, asyncH(async (req, res) => {
    const id = int(req.params.id);
    const [[t]] = await pool.query('SELECT * FROM support_tickets WHERE id = ?', [id]);
    if (!t) throw new HttpError(404, 'Ticket not found');
    const sets = []; const vals = [];
    if (req.body.status !== undefined) {
      if (!STATUSES.includes(req.body.status)) throw new HttpError(400, 'Invalid status');
      sets.push('status = ?'); vals.push(req.body.status);
      if (['resolved', 'closed'].includes(req.body.status)) {
        if (String(req.body.resolution || t.resolution || '').trim().length < 5) throw new HttpError(400, 'A resolution is required to resolve or close a ticket');
        sets.push('resolved_at = COALESCE(resolved_at, NOW())');
      }
    }
    if (req.body.resolution !== undefined) { sets.push('resolution = ?'); vals.push(String(req.body.resolution).slice(0, 1000)); }
    if (req.body.priority !== undefined) { if (!PRIORITIES.includes(req.body.priority)) throw new HttpError(400, 'Invalid priority'); sets.push('priority = ?'); vals.push(req.body.priority); }
    if (req.body.assigneeId !== undefined) { sets.push('assignee_id = ?'); vals.push(int(req.body.assigneeId)); }
    if (!sets.length) throw new HttpError(400, 'Nothing to change');
    await pool.query(`UPDATE support_tickets SET ${sets.join(', ')} WHERE id = ?`, [...vals, id]);
    await platformAudit.logPlatformAudit({ tenantId: t.tenant_id, actor: req.user, action: 'support.ticket_updated', category: 'support',
      entityType: 'support_ticket', entityId: id, before: { status: t.status, priority: t.priority }, after: req.body, req });
    res.json({ ok: true });
  }));

  r.post('/support-tickets/:id/notes', TICKET_WRITE, asyncH(async (req, res) => {
    const id = int(req.params.id);
    const [[t]] = await pool.query('SELECT id, tenant_id, first_response_at FROM support_tickets WHERE id = ?', [id]);
    if (!t) throw new HttpError(404, 'Ticket not found');
    const visibility = req.body?.visibility === 'customer' ? 'customer' : 'internal';
    if (String(req.body?.body || '').trim().length < 2) throw new HttpError(400, 'A note body is required');
    await pool.query('INSERT INTO support_ticket_notes (ticket_id, author_user_id, author_name, visibility, body) VALUES (?,?,?,?,?)',
      [id, req.user.id, req.user.name, visibility, String(req.body.body).slice(0, 5000)]);
    // The first customer-visible reply is the SLA's "first response".
    if (visibility === 'customer' && !t.first_response_at) await pool.query('UPDATE support_tickets SET first_response_at = NOW() WHERE id = ?', [id]);
    res.status(201).json({ ok: true });
  }));

  r.get('/support-sla', TICKET_VIEW, asyncH(async (req, res) => {
    const [rows] = await pool.query('SELECT * FROM support_sla_policies ORDER BY support_level, FIELD(priority,\'urgent\',\'high\',\'normal\',\'low\')');
    res.json({ data: rows });
  }));
  r.put('/support-sla', requirePermission('platform.settings.manage'), asyncH(async (req, res) => {
    const { supportLevel, priority, firstResponseMinutes, resolutionMinutes } = req.body || {};
    const reason = reasonOf(req.body?.reason);
    if (!supportLevel || !PRIORITIES.includes(priority) || !(int(firstResponseMinutes) > 0) || !(int(resolutionMinutes) >= int(firstResponseMinutes))) {
      throw new HttpError(400, 'supportLevel, priority and positive minutes (resolution ≥ first response) are required');
    }
    await pool.query(
      `INSERT INTO support_sla_policies (support_level, priority, first_response_minutes, resolution_minutes) VALUES (?,?,?,?)
       ON DUPLICATE KEY UPDATE first_response_minutes = VALUES(first_response_minutes), resolution_minutes = VALUES(resolution_minutes)`,
      [supportLevel, priority, int(firstResponseMinutes), int(resolutionMinutes)]);
    await platformAudit.logPlatformAudit({ actor: req.user, action: 'platform.sla_changed', category: 'platform', after: req.body, reason, req });
    res.json({ ok: true });
  }));

  // ================================================================== incidents
  const INC_WRITE = requirePermission('platform.support.grant', { anyOf: ['platform.security.manage', 'platform.support.grant'] });
  r.get('/incidents', requirePermission('platform.dashboard.view'), asyncH(async (req, res) => {
    const [rows] = await pool.query('SELECT * FROM platform_incidents ORDER BY (status = \'resolved\'), created_at DESC LIMIT 100');
    res.json({ data: rows.map((i) => ({ ...i, affected_systems: parse(i.affected_systems, []), affected_tenant_ids: parse(i.affected_tenant_ids, []) })) });
  }));
  r.post('/incidents', INC_WRITE, asyncH(async (req, res) => {
    const { title, severity = 'sev3', affectedSystems = [], affectedTenantIds = [], message } = req.body || {};
    if (String(title || '').trim().length < 5) throw new HttpError(400, 'A title of at least 5 characters is required');
    if (!['sev1', 'sev2', 'sev3', 'sev4'].includes(severity)) throw new HttpError(400, 'Invalid severity');
    const [ins] = await pool.query('INSERT INTO platform_incidents (title, severity, affected_systems, affected_tenant_ids, created_by) VALUES (?,?,?,?,?)',
      [title.trim(), severity, JSON.stringify(affectedSystems), JSON.stringify(affectedTenantIds), req.user.id]);
    await pool.query('INSERT INTO platform_incident_updates (incident_id, status, message, author_user_id, author_name) VALUES (?,?,?,?,?)',
      [ins.insertId, 'investigating', String(message || 'Incident opened').slice(0, 2000), req.user.id, req.user.name]);
    await pn.notify({ event: 'incident_opened', severity: ['sev1', 'sev2'].includes(severity) ? 'critical' : 'warning', title: `Incident (${severity}): ${title.trim()}`, dedupe: `incident:${ins.insertId}` });
    await platformAudit.logPlatformAudit({ actor: req.user, action: 'platform.incident_opened', category: 'platform', entityType: 'incident', entityId: ins.insertId, after: { severity, title }, req });
    res.status(201).json({ data: { id: ins.insertId } });
  }));
  r.post('/incidents/:id/updates', INC_WRITE, asyncH(async (req, res) => {
    const id = int(req.params.id);
    const [[inc]] = await pool.query('SELECT * FROM platform_incidents WHERE id = ?', [id]);
    if (!inc) throw new HttpError(404, 'Incident not found');
    const { status, message, rootCause, resolution } = req.body || {};
    if (String(message || '').trim().length < 3) throw new HttpError(400, 'A message is required');
    if (status && !['investigating', 'identified', 'monitoring', 'resolved'].includes(status)) throw new HttpError(400, 'Invalid status');
    if (status === 'resolved' && (!String(rootCause || inc.root_cause || '').trim() || !String(resolution || inc.resolution || '').trim())) {
      throw new HttpError(400, 'Resolving an incident needs a root cause and a resolution');
    }
    await pool.query('INSERT INTO platform_incident_updates (incident_id, status, message, author_user_id, author_name) VALUES (?,?,?,?,?)',
      [id, status || inc.status, String(message).slice(0, 2000), req.user.id, req.user.name]);
    await pool.query(
      `UPDATE platform_incidents SET status = COALESCE(?, status), root_cause = COALESCE(?, root_cause), resolution = COALESCE(?, resolution),
              resolved_at = IF(? = 'resolved', NOW(), resolved_at) WHERE id = ?`, [status || null, rootCause || null, resolution || null, status || null, id]);
    res.json({ ok: true });
  }));
  r.get('/incidents/:id', requirePermission('platform.dashboard.view'), asyncH(async (req, res) => {
    const [[inc]] = await pool.query('SELECT * FROM platform_incidents WHERE id = ?', [int(req.params.id)]);
    if (!inc) throw new HttpError(404, 'Incident not found');
    const [updates] = await pool.query('SELECT * FROM platform_incident_updates WHERE incident_id = ? ORDER BY created_at', [inc.id]);
    res.json({ data: { ...inc, timeline: updates } });
  }));

  // ================================================================= maintenance
  r.get('/maintenance', requirePermission('platform.dashboard.view'), asyncH(async (req, res) => {
    const [rows] = await pool.query('SELECT m.*, t.name AS tenant_name FROM maintenance_windows m LEFT JOIN tenants t ON t.id = m.tenant_id ORDER BY m.starts_at DESC LIMIT 50');
    res.json({ data: rows });
  }));
  // Only the platform Super Admin can schedule maintenance; a Company Owner has no route here at all.
  r.post('/maintenance', requirePermission('platform.tenants.manage'), asyncH(async (req, res) => {
    const { tenantId = null, message, startsAt, endsAt } = req.body || {};
    const reason = reasonOf(req.body?.reason);
    const s = new Date(startsAt); const e = new Date(endsAt);
    if (String(message || '').trim().length < 5) throw new HttpError(400, 'A customer-facing message is required');
    if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime()) || e <= s) throw new HttpError(400, 'startsAt/endsAt must be valid and end after start');
    if (e.getTime() - s.getTime() > 24 * 3600 * 1000) throw new HttpError(400, 'A maintenance window is at most 24 hours');
    const [ins] = await pool.query('INSERT INTO maintenance_windows (tenant_id, message, starts_at, ends_at, created_by) VALUES (?,?,?,?,?)',
      [tenantId ? int(tenantId) : null, String(message).trim(), s, e, req.user.id]);
    require('../../services/maintenance').invalidate();
    await platformAudit.logPlatformAudit({ tenantId: tenantId ? int(tenantId) : null, actor: req.user, action: 'platform.maintenance_scheduled', category: 'platform',
      entityType: 'maintenance_window', entityId: ins.insertId, after: { startsAt: s, endsAt: e, scope: tenantId ? 'tenant' : 'platform' }, reason, req });
    res.status(201).json({ data: { id: ins.insertId } });
  }));
  r.delete('/maintenance/:id', requirePermission('platform.tenants.manage'), asyncH(async (req, res) => {
    const reason = reasonOf(req.body?.reason ?? req.query?.reason);
    const [u] = await pool.query("UPDATE maintenance_windows SET status = 'cancelled' WHERE id = ? AND status = 'scheduled'", [int(req.params.id)]);
    if (!u.affectedRows) throw new HttpError(404, 'No scheduled window with that id');
    require('../../services/maintenance').invalidate();
    await platformAudit.logPlatformAudit({ actor: req.user, action: 'platform.maintenance_cancelled', category: 'platform', entityType: 'maintenance_window', entityId: int(req.params.id), reason, req });
    res.json({ ok: true });
  }));

  // ============================================================== notifications
  r.get('/notifications', requirePermission('platform.dashboard.view'), asyncH(async (req, res) => {
    res.json({ data: await pn.list({ unreadOnly: req.query.unread === '1', limit: Math.min(100, int(req.query.limit, 50)) }) });
  }));
  r.post('/notifications/read', requirePermission('platform.dashboard.view'), asyncH(async (req, res) => {
    res.json({ marked: await pn.markRead((req.body?.ids || []).map(Number).filter(Boolean)) });
  }));

  // ================================================================== retention
  r.get('/retention', requirePermission('platform.settings.manage', { anyOf: ['platform.audit.view', 'platform.settings.manage'] }), asyncH(async (req, res) => {
    const [rows] = await pool.query('SELECT data_class, retain_days, updated_at FROM retention_policies ORDER BY data_class');
    res.json({ data: rows, note: 'These are retention targets. Nothing is deleted automatically; purging is a separate, audited action.' });
  }));
  r.put('/retention', requirePermission('platform.settings.manage'), asyncH(async (req, res) => {
    const reason = reasonOf(req.body?.reason);
    const CLASSES = ['audit_log', 'documents', 'deleted_records', 'tenant_archive', 'support_access_log', 'billing_records'];
    const { dataClass, retainDays } = req.body || {};
    if (!CLASSES.includes(dataClass)) throw new HttpError(400, `dataClass must be one of: ${CLASSES.join(', ')}`);
    const days = int(retainDays);
    // Billing and audit records have legal minimums this product should not silently undercut.
    const FLOOR = { billing_records: 2190, audit_log: 365, support_access_log: 365 };
    if (!(days >= 1) || days < (FLOOR[dataClass] || 1)) throw new HttpError(400, `${dataClass} must be retained for at least ${FLOOR[dataClass] || 1} days`);
    await pool.query(
      'INSERT INTO retention_policies (data_class, retain_days, updated_by) VALUES (?,?,?) ON DUPLICATE KEY UPDATE retain_days = VALUES(retain_days), updated_by = VALUES(updated_by)',
      [dataClass, days, req.user.id]);
    await platformAudit.logPlatformAudit({ actor: req.user, action: 'platform.retention_changed', category: 'platform', after: { dataClass, days }, reason, req });
    res.json({ ok: true });
  }));

  return r;
};
