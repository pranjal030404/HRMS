const express = require('express');
const dayjs = require('dayjs');
const { pool } = require('../config/db');
const { asyncH, HttpError } = require('../utils/helpers');
const { authenticate, requirePermission, employeeScopeCondition, canActOnEmployee, scopeFor } = require('../middleware/auth');
const { logAudit } = require('../services/audit');
const { notifyEvent } = require('../services/notify');
const { fireTrigger } = require('../services/workflow');
const { emitEvent } = require('../services/webhooks');

const r = express.Router();
r.use(authenticate);

// ---- Travel requests ----
r.get('/', asyncH(async (req, res) => {
  const params = [req.user.tenant_id];
  let where = 't.tenant_id = ?';
  const scope = scopeFor(req.user, 'travel.view');
  if (scope === 'own' && !req.query.all) {
    where += ' AND t.employee_id = ?';
    params.push(req.user.employee_id || 0);
  } else {
    const empScope = employeeScopeCondition(req.user, 'travel.view', 'e');
    where += ` AND ${empScope.sql}`;
    params.push(...empScope.params);
  }
  if (req.query.status) { where += ' AND t.status = ?'; params.push(req.query.status); }
  const [rows] = await pool.query(
    `SELECT t.*, CONCAT(e.first_name, ' ', e.last_name) AS employee_name, e.employee_code,
            (SELECT SUM(amount) FROM travel_advances va WHERE va.request_id = t.id AND va.status = 'issued') AS advance_issued,
            (SELECT SUM(amount) FROM travel_bookings vb WHERE vb.request_id = t.id AND vb.status = 'booked') AS booked_total
     FROM travel_requests t JOIN employees e ON e.id = t.employee_id
     WHERE ${where} ORDER BY t.created_at DESC LIMIT 300`,
    params
  );
  res.json({ data: rows });
}));

r.get('/:id', asyncH(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT t.*, CONCAT(e.first_name, ' ', e.last_name) AS employee_name, e.employee_code
     FROM travel_requests t JOIN employees e ON e.id = t.employee_id
     WHERE t.id = ? AND t.tenant_id = ?`,
    [req.params.id, req.user.tenant_id]
  );
  if (!rows[0]) throw new HttpError(404, 'Travel request not found');
  const t = rows[0];
  const isOwner = t.employee_id === req.user.employee_id;
  if (!isOwner && !(req.user.permissions || []).some((p) => p.startsWith('travel.view'))) throw new HttpError(403, 'Missing permission: travel.view');
  const [advances] = await pool.query('SELECT * FROM travel_advances WHERE request_id = ?', [t.id]);
  const [bookings] = await pool.query('SELECT * FROM travel_bookings WHERE request_id = ?', [t.id]);
  const [settlements] = await pool.query('SELECT * FROM travel_settlements WHERE request_id = ?', [t.id]);
  res.json({ data: { ...t, advances, bookings, settlements } });
}));

r.post('/', requirePermission('travel.create'), asyncH(async (req, res) => {
  const { purpose, destination, startDate, endDate, estimatedCost, travelMode, advanceAmount } = req.body || {};
  if (!purpose) throw new HttpError(400, 'purpose required');
  if (!req.user.employee_id) throw new HttpError(400, 'Only linked employees can create travel requests');
  const [{ n }] = (await pool.query('SELECT COUNT(*) AS n FROM travel_requests WHERE tenant_id = ? AND YEAR(created_at) = ?', [req.user.tenant_id, dayjs().year()]))[0];
  const trno = `TRV-${dayjs().format('YYYY')}-${String(n + 1).padStart(4, '0')}`;
  const [ins] = await pool.query(
    `INSERT INTO travel_requests (tenant_id, trno, employee_id, purpose, destination, start_date, end_date, estimated_cost, travel_mode, status)
     VALUES (?,?,?,?,?,?,?,?,?, 'pending')`,
    [req.user.tenant_id, trno, req.user.employee_id, purpose, destination || null, startDate || null, endDate || null, estimatedCost || 0, travelMode || null]
  );
  if (advanceAmount && Number(advanceAmount) > 0) {
    await pool.query(
      'INSERT INTO travel_advances (tenant_id, request_id, employee_id, amount, status) VALUES (?,?,?,?,"requested")',
      [req.user.tenant_id, ins.insertId, req.user.employee_id, Number(advanceAmount)]
    );
  }
  // notify manager
  const [mgr] = await pool.query(
    `SELECT u.id FROM employees e JOIN users u ON u.employee_id = e.id AND u.status = "active" WHERE e.id = (SELECT manager_id FROM employees WHERE id = ?)`,
    [req.user.employee_id]
  );
  await notifyEvent({
    tenantId: req.user.tenant_id, eventKey: 'travel.submitted',
    vars: { title: `Travel request ${trno} needs approval`, body: `${purpose} → ${destination || '—'}` },
    recipients: mgr.map((m) => ({ userId: m.id })),
    link: '/travel',
  });
  await fireTrigger({ tenantId: req.user.tenant_id, triggerEvent: 'travel.submitted', entityType: 'travel_request', entityId: ins.insertId, ctx: { employeeId: req.user.employee_id, estimatedCost: estimatedCost || 0 }, req });
  await emitEvent({ tenantId: req.user.tenant_id, eventType: 'travel.submitted', payload: { id: ins.insertId, trno } });
  res.status(201).json({ data: { id: ins.insertId, trno } });
}));

r.put('/:id/approve', requirePermission('travel.approve'), asyncH(async (req, res) => {
  const { action, comment } = req.body || {}; // action: approved | rejected
  if (!['approved', 'rejected'].includes(action)) throw new HttpError(400, 'action must be approved or rejected');
  const [rows] = await pool.query('SELECT * FROM travel_requests WHERE id = ? AND tenant_id = ?', [req.params.id, req.user.tenant_id]);
  const t = rows[0];
  if (!t) throw new HttpError(404, 'Travel request not found');
  if (t.status !== 'pending') throw new HttpError(400, `Request is already ${t.status}`);
  if (!(await canActOnEmployee(req.user, 'travel.view', t.employee_id))) throw new HttpError(403, 'Outside your approval scope');
  await pool.query(
    'UPDATE travel_requests SET status = ?, approver_id = ?, approver_comment = ?, actioned_at = NOW() WHERE id = ?',
    [action, req.user.id, comment || null, req.params.id]
  );
  await notifyEvent({
    tenantId: req.user.tenant_id, eventKey: 'travel.actioned',
    vars: { title: `Travel request ${t.trno} ${action}`, body: comment || '' },
    recipients: (await pool.query('SELECT id FROM users WHERE employee_id = ?', [t.employee_id]))[0].map((u) => ({ userId: u.id })),
    link: '/travel',
  });
  await emitEvent({ tenantId: req.user.tenant_id, eventType: `travel.${action}`, payload: { id: t.id, trno: t.trno } });
  await logAudit({ tenantId: req.user.tenant_id, actor: req.user, action: `travel.${action}`, entityType: 'travel_request', entityId: req.params.id, before: t, after: { action, comment }, req });
  res.json({ ok: true });
}));

// ---- Advances ----
r.post('/:id/advances/:advanceId/issue', requirePermission('travel.manage'), asyncH(async (req, res) => {
  const { issuedOn } = req.body || {};
  await pool.query('UPDATE travel_advances SET status = "issued", issued_on = ? WHERE id = ? AND request_id = ? AND tenant_id = ?',
    [issuedOn || dayjs().format('YYYY-MM-DD'), req.params.advanceId, req.params.id, req.user.tenant_id]);
  res.json({ ok: true });
}));

// ---- Bookings ----
r.post('/:id/bookings', requirePermission('travel.manage'), asyncH(async (req, res) => {
  const { mode, provider, reference, bookedOn, amount } = req.body || {};
  const [rows] = await pool.query('SELECT id, employee_id FROM travel_requests WHERE id = ? AND tenant_id = ?', [req.params.id, req.user.tenant_id]);
  if (!rows[0]) throw new HttpError(404, 'Travel request not found');
  const [ins] = await pool.query(
    'INSERT INTO travel_bookings (tenant_id, request_id, mode, provider, reference, booked_on, amount) VALUES (?,?,?,?,?,?,?)',
    [req.user.tenant_id, req.params.id, mode || 'flight', provider || null, reference || null, bookedOn || null, amount || 0]
  );
  res.status(201).json({ data: { id: ins.insertId } });
}));

// ---- Settlement ----
r.post('/:id/settlement', requirePermission('travel.create'), asyncH(async (req, res) => {
  const { amountSpent } = req.body || {};
  const [rows] = await pool.query('SELECT * FROM travel_requests WHERE id = ? AND tenant_id = ?', [req.params.id, req.user.tenant_id]);
  const t = rows[0];
  if (!t) throw new HttpError(404, 'Travel request not found');
  if (t.employee_id !== req.user.employee_id) throw new HttpError(403, 'Only the traveller can submit settlement');
  if (t.status !== 'approved') throw new HttpError(400, 'Travel must be approved before settlement');
  const [adv] = await pool.query('SELECT COALESCE(SUM(amount),0) AS issued FROM travel_advances WHERE request_id = ? AND status = "issued"', [t.id]);
  const advance = Number(adv[0].issued) || 0;
  const spent = Number(amountSpent) || 0;
  const payable = spent - advance;
  await pool.query(
    `INSERT INTO travel_settlements (tenant_id, request_id, employee_id, amount_spent, advance_adjusted, payable, status)
     VALUES (?,?,?,?,?,?,'submitted')`,
    [req.user.tenant_id, t.id, t.employee_id, spent, advance, payable]
  );
  await pool.query('UPDATE travel_requests SET settlement_status = "pending" WHERE id = ?', [t.id]);
  res.status(201).json({ data: { payable } });
}));

r.put('/:id/settlement/:settlementId/approve', requirePermission('travel.manage'), asyncH(async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM travel_settlements WHERE id = ? AND request_id = ? AND tenant_id = ?', [req.params.settlementId, req.params.id, req.user.tenant_id]);
  if (!rows[0]) throw new HttpError(404, 'Settlement not found');
  await pool.query('UPDATE travel_settlements SET status = "paid", approved_by = ?, settled_on = CURDATE() WHERE id = ?', [req.user.id, req.params.settlementId]);
  await pool.query('UPDATE travel_requests SET settlement_status = "settled", status = "completed" WHERE id = ?', [req.params.id]);
  await logAudit({ tenantId: req.user.tenant_id, actor: req.user, action: 'travel.settlement', entityType: 'travel_settlement', entityId: req.params.settlementId, req });
  res.json({ ok: true });
}));

// ---- Travel analytics ----
r.get('/analytics/summary', requirePermission('analytics.view'), asyncH(async (req, res) => {
  const T = req.user.tenant_id;
  const [byStatus] = await pool.query('SELECT status, COUNT(*) AS n FROM travel_requests WHERE tenant_id = ? GROUP BY status', [T]);
  const [[{ totalSpend }]] = await pool.query('SELECT COALESCE(SUM(amount_spent),0) AS totalSpend FROM travel_settlements WHERE tenant_id = ?', [T]);
  const [[{ pendingApprovals }]] = await pool.query('SELECT COUNT(*) AS pendingApprovals FROM travel_requests WHERE tenant_id = ? AND status = "pending"', [T]);
  const [topDestinations] = await pool.query(
    `SELECT destination, COUNT(*) AS trips FROM travel_requests WHERE tenant_id = ? AND destination IS NOT NULL GROUP BY destination ORDER BY trips DESC LIMIT 5`,
    [T]
  );
  res.json({ data: { byStatus, totalSpend, pendingApprovals, topDestinations } });
}));

module.exports = r;
