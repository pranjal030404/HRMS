/**
 * Notification center (spec §8): template management with variables & preview,
 * per-user preferences, delivery logs with retry/dead-letter visibility.
 */
const express = require('express');
const { pool } = require('../config/db');
const { asyncH, HttpError } = require('../utils/helpers');
const { authenticate, requirePermission } = require('../middleware/auth');
const { EMAIL_TEMPLATES, fillTemplate } = require('../services/notify');

const r = express.Router();
r.use(authenticate);

// Known event keys = built-in defaults + any template rows
const BUILTIN_EVENTS = Object.keys(EMAIL_TEMPLATES);

// ---- Templates (admin) ----
r.get('/templates', requirePermission('notification.manage'), asyncH(async (req, res) => {
  const [rows] = await pool.query(
    'SELECT * FROM notification_templates WHERE tenant_id = ? ORDER BY event_key, channel LIMIT 300',
    [req.user.tenant_id]
  );
  const custom = new Set(rows.map((x) => x.event_key));
  const defaults = BUILTIN_EVENTS.filter((e) => !custom.has(e)).map((eventKey) => ({
    id: null, event_key: eventKey, channel: 'email', subject: EMAIL_TEMPLATES[eventKey].subject,
    body: EMAIL_TEMPLATES[eventKey].body, active: 1, is_default: true,
  }));
  res.json({ data: [...rows.map((x) => ({ ...x, is_default: false })), ...defaults] });
}));

r.post('/templates', requirePermission('notification.manage'), asyncH(async (req, res) => {
  const { eventKey, channel, subject, body, locale } = req.body || {};
  if (!eventKey || !subject || !body) throw new HttpError(400, 'eventKey, subject and body required');
  const [ins] = await pool.query(
    `INSERT INTO notification_templates (tenant_id, event_key, channel, subject, body, locale, active)
     VALUES (?,?,?,?,?,?,1)
     ON DUPLICATE KEY UPDATE subject = VALUES(subject), body = VALUES(body), active = 1`,
    [req.user.tenant_id, eventKey, channel || 'email', subject, body, locale || 'en']
  );
  res.status(201).json({ data: { id: ins.insertId } });
}));

r.put('/templates/:id', requirePermission('notification.manage'), asyncH(async (req, res) => {
  const { subject, body, active } = req.body || {};
  await pool.query(
    'UPDATE notification_templates SET subject = COALESCE(?, subject), body = COALESCE(?, body), active = COALESCE(?, active) WHERE id = ? AND tenant_id = ?',
    [subject || null, body || null, active === undefined ? null : (active ? 1 : 0), req.params.id, req.user.tenant_id]
  );
  res.json({ ok: true });
}));

r.delete('/templates/:id', requirePermission('notification.manage'), asyncH(async (req, res) => {
  await pool.query('DELETE FROM notification_templates WHERE id = ? AND tenant_id = ?', [req.params.id, req.user.tenant_id]);
  res.json({ ok: true });
}));

// Template variables & preview
r.get('/template-variables', requirePermission('notification.manage'), (req, res) => {
  res.json({
    data: {
      common: ['employeeName', 'companyName', 'startDate', 'endDate', 'days', 'comment', 'status', 'period', 'netPay', 'title', 'body', 'dueDate', 'lastWorkingDay'],
      events: BUILTIN_EVENTS,
    },
  });
});

r.post('/templates/preview', requirePermission('notification.manage'), asyncH(async (req, res) => {
  const { subject, body } = req.body || {};
  const vars = {
    employeeName: 'Diya Patel', companyName: 'Arthvex Technologies', startDate: '2026-10-05',
    endDate: '2026-10-07', days: 3, comment: 'Approved, enjoy!', status: 'approved',
    period: '2026-09', netPay: '84,250.00', title: 'Sample title', body: 'Sample body',
    dueDate: '2026-10-01', lastWorkingDay: '2026-12-01', leaveTypeName: 'Earned Leave', ticketNo: 'TKT-00001',
  };
  res.json({ data: { subject: fillTemplate(subject || '', vars), body: fillTemplate(body || '', vars) } });
}));

// ---- Delivery logs ----
r.get('/delivery-logs', requirePermission('notification.manage'), asyncH(async (req, res) => {
  const params = [req.user.tenant_id];
  let where = 'tenant_id = ?';
  if (req.query.status) { where += ' AND status = ?'; params.push(req.query.status); }
  if (req.query.channel) { where += ' AND channel = ?'; params.push(req.query.channel); }
  const [rows] = await pool.query(
    `SELECT * FROM delivery_logs WHERE ${where} ORDER BY created_at DESC LIMIT 200`,
    params
  );
  res.json({ data: rows });
}));

// ---- My notification preferences ----
r.get('/my/prefs', asyncH(async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM notification_prefs WHERE user_id = ?', [req.user.id]);
  res.json({ data: rows, events: BUILTIN_EVENTS });
}));

r.put('/my/prefs', asyncH(async (req, res) => {
  const { eventKey, inappEnabled, emailEnabled } = req.body || {};
  if (!eventKey) throw new HttpError(400, 'eventKey required');
  await pool.query(
    `INSERT INTO notification_prefs (user_id, event_key, inapp_enabled, email_enabled) VALUES (?,?,?,?)
     ON DUPLICATE KEY UPDATE inapp_enabled = VALUES(inapp_enabled), email_enabled = VALUES(email_enabled)`,
    [req.user.id, eventKey, inappEnabled ? 1 : 0, emailEnabled ? 1 : 0]
  );
  res.json({ ok: true });
}));

module.exports = r;
