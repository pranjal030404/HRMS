const express = require('express');
const dayjs = require('dayjs');
const { pool } = require('../config/db');
const { asyncH, HttpError } = require('../utils/helpers');
const { authenticate, requirePermission } = require('../middleware/auth');
const { logAudit } = require('../services/audit');
const { notifyEvent } = require('../services/notify');
const { fireTrigger } = require('../services/workflow');
const { emitEvent } = require('../services/webhooks');

const r = express.Router();
r.use(authenticate);

// Restricted-access module: every route requires relations.view or relations.manage.
r.get('/cases', requirePermission('relations.view'), asyncH(async (req, res) => {
  const params = [req.user.tenant_id];
  let where = 'c.tenant_id = ?';
  if (req.query.status) { where += ' AND c.status = ?'; params.push(req.query.status); }
  if (req.query.category) { where += ' AND c.category = ?'; params.push(req.query.category); }
  const [rows] = await pool.query(
    `SELECT c.*, CONCAT(e.first_name, ' ', e.last_name) AS employee_name, e.employee_code,
            d.name AS department, CONCAT(a.first_name, ' ', a.last_name) AS assigned_to_name,
            (SELECT COUNT(*) FROM hr_case_notes n WHERE n.case_id = c.id) AS note_count
     FROM hr_cases c
     JOIN employees e ON e.id = c.employee_id
     LEFT JOIN departments d ON d.id = e.department_id
     LEFT JOIN employees a ON a.id = c.assigned_to
     WHERE ${where} ORDER BY FIELD(c.status, 'open', 'investigating', 'resolved', 'closed'), c.created_at DESC LIMIT 300`,
    params
  );
  res.json({ data: rows });
}));

r.get('/cases/:id', requirePermission('relations.view'), asyncH(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT c.*, CONCAT(e.first_name, ' ', e.last_name) AS employee_name, e.employee_code, d.name AS department
     FROM hr_cases c JOIN employees e ON e.id = c.employee_id
     LEFT JOIN departments d ON d.id = e.department_id
     WHERE c.id = ? AND c.tenant_id = ?`,
    [req.params.id, req.user.tenant_id]
  );
  if (!rows[0]) throw new HttpError(404, 'Case not found');
  // hr_only notes are visible only to relations.manage holders
  const canSeeHrOnly = (req.user.permissions || []).some((p) => p === 'relations.manage');
  const [notes] = await pool.query(
    `SELECT n.*, CONCAT(u.name) AS author_name FROM hr_case_notes n
     JOIN users u ON u.id = n.author_id
     WHERE n.case_id = ? ${canSeeHrOnly ? '' : 'AND n.visibility = "internal"'} ORDER BY n.created_at`,
    [req.params.id]
  );
  const [actions] = await pool.query(
    `SELECT da.*, CONCAT(u.name) AS issued_by_name FROM disciplinary_actions da
     LEFT JOIN users u ON u.id = da.issued_by
     WHERE da.case_id = ? AND da.tenant_id = ? ORDER BY da.issued_on DESC`,
    [req.params.id, req.user.tenant_id]
  );
  res.json({ data: { ...rows[0], notes, actions } });
}));

r.post('/cases', requirePermission('relations.manage'), asyncH(async (req, res) => {
  const { employeeId, category, title, description, severity, assignedTo } = req.body || {};
  if (!employeeId || !title) throw new HttpError(400, 'employeeId and title required');
  const [{ n }] = (await pool.query(
    'SELECT COUNT(*) AS n FROM hr_cases WHERE tenant_id = ? AND YEAR(created_at) = ?',
    [req.user.tenant_id, dayjs().year()]
  ))[0];
  const caseNo = `HRC-${dayjs().format('YYYY')}-${String(n + 1).padStart(4, '0')}`;
  const [ins] = await pool.query(
    `INSERT INTO hr_cases (tenant_id, case_no, employee_id, raised_by, category, title, description, severity, status, assigned_to)
     VALUES (?,?,?,?,?,?,?,?,'open',?)`,
    [req.user.tenant_id, caseNo, employeeId, req.user.id, category || 'grievance', title, description || null, severity || 'medium', assignedTo || null]
  );
  if (assignedTo) {
    await notifyEvent({
      tenantId: req.user.tenant_id, eventKey: 'hr_case.assigned',
      vars: { title: `HR case ${caseNo} assigned to you`, body: `${category || 'Grievance'}: ${title}` },
      recipients: (await pool.query('SELECT id FROM users WHERE employee_id = ?', [assignedTo]))[0].map((u) => ({ userId: u.id })),
      link: '/relations',
    });
  }
  await fireTrigger({ tenantId: req.user.tenant_id, triggerEvent: 'hr_case.created', entityType: 'hr_case', entityId: ins.insertId, ctx: { employeeId, severity: severity || 'medium', category }, req });
  await emitEvent({ tenantId: req.user.tenant_id, eventType: 'hr_case.created', payload: { id: ins.insertId, caseNo, category } });
  await logAudit({ tenantId: req.user.tenant_id, actor: req.user, action: 'hr_case.create', entityType: 'hr_case', entityId: ins.insertId, after: req.body, req });
  res.status(201).json({ data: { id: ins.insertId, caseNo } });
}));

r.put('/cases/:id', requirePermission('relations.manage'), asyncH(async (req, res) => {
  const [before] = await pool.query('SELECT * FROM hr_cases WHERE id = ? AND tenant_id = ?', [req.params.id, req.user.tenant_id]);
  if (!before[0]) throw new HttpError(404, 'Case not found');
  const allowed = ['title', 'description', 'severity', 'status', 'assigned_to', 'resolution', 'category'];
  const sets = [], params = [];
  for (const k of allowed) if (req.body[k] !== undefined) { sets.push(`${k} = ?`); params.push(req.body[k]); }
  if (req.body.status === 'resolved' || req.body.status === 'closed') {
    sets.push('resolution_date = CURDATE()');
    if (!req.body.resolution) throw new HttpError(400, 'resolution is required when resolving/closing a case');
  }
  if (!sets.length) throw new HttpError(400, 'No fields to update');
  params.push(req.params.id, req.user.tenant_id);
  await pool.query(`UPDATE hr_cases SET ${sets.join(', ')} WHERE id = ? AND tenant_id = ?`, params);
  await logAudit({ tenantId: req.user.tenant_id, actor: req.user, action: 'hr_case.update', entityType: 'hr_case', entityId: req.params.id, before: before[0], after: req.body, req });
  res.json({ ok: true });
}));

r.post('/cases/:id/notes', requirePermission('relations.view'), asyncH(async (req, res) => {
  const { note, visibility } = req.body || {};
  if (!note) throw new HttpError(400, 'note required');
  const manage = (req.user.permissions || []).some((p) => p === 'relations.manage');
  if (!manage) throw new HttpError(403, 'Missing permission: relations.manage');
  const [cases] = await pool.query('SELECT id FROM hr_cases WHERE id = ? AND tenant_id = ?', [req.params.id, req.user.tenant_id]);
  if (!cases[0]) throw new HttpError(404, 'Case not found');
  const [ins] = await pool.query(
    'INSERT INTO hr_case_notes (tenant_id, case_id, author_id, note, visibility) VALUES (?,?,?,?,?)',
    [req.user.tenant_id, req.params.id, req.user.id, note, visibility === 'hr_only' ? 'hr_only' : 'internal']
  );
  res.status(201).json({ data: { id: ins.insertId } });
}));

// ---- Disciplinary actions ----
r.get('/disciplinary', requirePermission('relations.view'), asyncH(async (req, res) => {
  const params = [req.user.tenant_id];
  let where = 'da.tenant_id = ?';
  if (req.query.employee_id) { where += ' AND da.employee_id = ?'; params.push(req.query.employee_id); }
  const [rows] = await pool.query(
    `SELECT da.*, CONCAT(e.first_name, ' ', e.last_name) AS employee_name, e.employee_code,
            c.case_no, CONCAT(u.name) AS issued_by_name
     FROM disciplinary_actions da
     JOIN employees e ON e.id = da.employee_id
     LEFT JOIN hr_cases c ON c.id = da.case_id
     LEFT JOIN users u ON u.id = da.issued_by
     WHERE ${where} ORDER BY da.issued_on DESC LIMIT 300`,
    params
  );
  res.json({ data: rows });
}));

r.post('/disciplinary', requirePermission('relations.manage'), asyncH(async (req, res) => {
  const { caseId, employeeId, actionType, reason, effectiveFrom } = req.body || {};
  if (!employeeId) throw new HttpError(400, 'employeeId required');
  const [ins] = await pool.query(
    `INSERT INTO disciplinary_actions (tenant_id, case_id, employee_id, action_type, reason, issued_by, issued_on, effective_from)
     VALUES (?,?,?,?,?,?, CURDATE(), ?)`,
    [req.user.tenant_id, caseId || null, employeeId, actionType || 'written_warning', reason || null, req.user.id, effectiveFrom || null]
  );
  await notifyEvent({
    tenantId: req.user.tenant_id, eventKey: 'relations.disciplinary',
    vars: { title: 'Disciplinary action recorded', body: `A ${String(actionType || 'written_warning').replace(/_/g, ' ')} has been recorded. Please contact HR for details.` },
    recipients: (await pool.query('SELECT id FROM users WHERE employee_id = ?', [employeeId]))[0].map((u) => ({ userId: u.id })),
    link: '/portal',
  });
  await logAudit({ tenantId: req.user.tenant_id, actor: req.user, action: 'disciplinary.create', entityType: 'disciplinary_action', entityId: ins.insertId, after: req.body, req });
  res.status(201).json({ data: { id: ins.insertId } });
}));

r.put('/disciplinary/:id/acknowledge', requirePermission('relations.manage'), asyncH(async (req, res) => {
  await pool.query('UPDATE disciplinary_actions SET acknowledged = 1, acknowledged_at = NOW() WHERE id = ? AND tenant_id = ?', [req.params.id, req.user.tenant_id]);
  res.json({ ok: true });
}));

// ---- Relations overview ----
r.get('/overview', requirePermission('relations.view'), asyncH(async (req, res) => {
  const T = req.user.tenant_id;
  const [byStatus] = await pool.query('SELECT status, COUNT(*) AS n FROM hr_cases WHERE tenant_id = ? GROUP BY status', [T]);
  const [byCategory] = await pool.query('SELECT category, COUNT(*) AS n FROM hr_cases WHERE tenant_id = ? GROUP BY category', [T]);
  const [[{ openCases }]] = await pool.query('SELECT COUNT(*) AS openCases FROM hr_cases WHERE tenant_id = ? AND status IN ("open","investigating")', [T]);
  const [[{ actionsYtd }]] = await pool.query('SELECT COUNT(*) AS actionsYtd FROM disciplinary_actions WHERE tenant_id = ? AND YEAR(issued_on) = ?', [T, dayjs().year()]);
  res.json({ data: { openCases, actionsYtd, byStatus, byCategory } });
}));

module.exports = r;
