const express = require('express');
const dayjs = require('dayjs');
const { pool } = require('../config/db');
const { asyncH, HttpError } = require('../utils/helpers');
const { authenticate, requirePermission } = require('../middleware/auth');
const { logAudit } = require('../services/audit');
const { notifyEvent } = require('../services/notify');
const { upload, relPath } = require('../middleware/upload');

const r = express.Router();
r.use(authenticate);

r.get('/', asyncH(async (req, res) => {
  const params = [req.user.tenant_id];
  let where = 't.tenant_id = ?';
  const isHandler = req.user.permissions.includes('ticket.handle');
  if (!isHandler) { where += ' AND t.employee_id = ?'; params.push(req.user.employee_id); }
  else if (req.query.mine === '1') { where += ' AND t.assignee_id = ?'; params.push(req.user.id); }
  if (req.query.status) { where += ' AND t.status = ?'; params.push(req.query.status); }
  if (req.query.category) { where += ' AND t.category = ?'; params.push(req.query.category); }
  const [rows] = await pool.query(
    `SELECT t.*, e.employee_code, e.first_name, e.last_name, a.name AS assignee_name,
       (SELECT COUNT(*) FROM ticket_comments tc WHERE tc.ticket_id = t.id) AS comment_count
     FROM tickets t JOIN employees e ON e.id = t.employee_id
     LEFT JOIN users a ON a.id = t.assignee_id
     WHERE ${where} ORDER BY t.created_at DESC LIMIT 200`,
    params
  );
  res.json({ data: rows });
}));

r.post('/', requirePermission('ticket.create'), upload('documents'), asyncH(async (req, res) => {
  const { category, subject, description, priority } = req.body || {};
  if (!subject) throw new HttpError(400, 'Subject required');
  const [[{ n }]] = await pool.query('SELECT COUNT(*)+1 AS n FROM tickets WHERE tenant_id = ?', [req.user.tenant_id]);
  const ticketNo = `TKT-${String(n).padStart(5, '0')}`;
  const slaHours = category === 'payroll' ? 24 : 48;
  const [ins] = await pool.query(
    `INSERT INTO tickets (tenant_id, ticket_no, employee_id, category, subject, description, priority, sla_hours, sla_due_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [req.user.tenant_id, ticketNo, req.user.employee_id, category || 'general', subject, description || null, priority || 'medium', slaHours, dayjs().add(slaHours, 'hour').format('YYYY-MM-DD HH:mm:ss')]
  );
  const [handlers] = await pool.query(`SELECT id, email FROM users WHERE tenant_id = ? AND role IN ('hr_admin','company_owner','finance_admin') AND status = 'active'`, [req.user.tenant_id]);
  await notifyEvent({
    tenantId: req.user.tenant_id, eventKey: 'ticket.created',
    vars: { ticketNo, subject, category: category || 'general' },
    recipients: handlers.map((u) => ({ userId: u.id, email: u.email })), link: '/tickets',
  });
  res.status(201).json({ data: { id: ins.insertId, ticketNo } });
}));

r.get('/:id', asyncH(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT t.*, e.employee_code, e.first_name, e.last_name, a.name AS assignee_name
     FROM tickets t JOIN employees e ON e.id = t.employee_id
     LEFT JOIN users a ON a.id = t.assignee_id
     WHERE t.id = ? AND t.tenant_id = ?`,
    [req.params.id, req.user.tenant_id]
  );
  const t = rows[0];
  if (!t) throw new HttpError(404, 'Ticket not found');
  const isHandler = req.user.permissions.includes('ticket.handle');
  if (!isHandler && Number(t.employee_id) !== Number(req.user.employee_id)) throw new HttpError(403, 'Not allowed');
  const [comments] = await pool.query(
    `SELECT tc.*, u.name AS author_name FROM ticket_comments tc JOIN users u ON u.id = tc.author_id
     WHERE tc.ticket_id = ? ${isHandler ? '' : 'AND tc.is_internal = 0'} ORDER BY tc.created_at`,
    [req.params.id]
  );
  res.json({ data: t, comments });
}));

r.post('/:id/comment', asyncH(async (req, res) => {
  const { comment, isInternal } = req.body || {};
  if (!comment) throw new HttpError(400, 'Comment required');
  const [rows] = await pool.query('SELECT * FROM tickets WHERE id = ? AND tenant_id = ?', [req.params.id, req.user.tenant_id]);
  const t = rows[0];
  if (!t) throw new HttpError(404, 'Ticket not found');
  const isHandler = req.user.permissions.includes('ticket.handle');
  if (!isHandler && Number(t.employee_id) !== Number(req.user.employee_id)) throw new HttpError(403, 'Not allowed');
  await pool.query(
    'INSERT INTO ticket_comments (ticket_id, author_id, comment, is_internal) VALUES (?,?,?,?)',
    [t.id, req.user.id, comment, isHandler && isInternal ? 1 : 0]
  );
  res.status(201).json({ ok: true });
}));

r.post('/:id/status', requirePermission('ticket.handle'), asyncH(async (req, res) => {
  const { status, assigneeId } = req.body || {};
  if (!['open', 'in_progress', 'resolved', 'closed', 'reopened'].includes(status)) throw new HttpError(400, 'Invalid status');
  const [rows] = await pool.query('SELECT * FROM tickets WHERE id = ? AND tenant_id = ?', [req.params.id, req.user.tenant_id]);
  if (!rows[0]) throw new HttpError(404, 'Ticket not found');
  await pool.query(
    'UPDATE tickets SET status = ?, assignee_id = COALESCE(?, assignee_id), resolved_at = ? WHERE id = ?',
    [status, assigneeId || null, ['resolved', 'closed'].includes(status) ? dayjs().format('YYYY-MM-DD HH:mm:ss') : null, req.params.id]
  );
  const [empUser] = await pool.query('SELECT u.id, u.email FROM users u WHERE u.employee_id = ?', [rows[0].employee_id]);
  await notifyEvent({
    tenantId: req.user.tenant_id, eventKey: 'ticket.updated',
    vars: { ticketNo: rows[0].ticket_no, subject: rows[0].subject, status },
    recipients: empUser[0] ? [{ userId: empUser[0].id, email: empUser[0].email }] : [], link: '/portal/tickets',
  });
  res.json({ ok: true });
}));

module.exports = r;
