const express = require('express');
const { pool } = require('../config/db');
const { asyncH, HttpError } = require('../utils/helpers');
const { authenticate, requirePermission, scopeFor } = require('../middleware/auth');
const { logAudit } = require('../services/audit');

const r = express.Router();
r.use(authenticate);

// ---------- Cycles ----------
r.get('/cycles', requirePermission('performance.view'), asyncH(async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM performance_cycles WHERE tenant_id = ? ORDER BY start_date DESC', [req.user.tenant_id]);
  res.json({ data: rows });
}));

r.post('/cycles', requirePermission('performance.manage'), asyncH(async (req, res) => {
  const { name, startDate, endDate, reviewType } = req.body || {};
  if (!name || !startDate || !endDate) throw new HttpError(400, 'name, startDate, endDate required');
  const [ins] = await pool.query(
    'INSERT INTO performance_cycles (tenant_id, name, start_date, end_date, review_type) VALUES (?,?,?,?,?)',
    [req.user.tenant_id, name, startDate, endDate, reviewType || 'annual']
  );
  res.status(201).json({ data: { id: ins.insertId } });
}));

r.post('/cycles/:id/status', requirePermission('performance.manage'), asyncH(async (req, res) => {
  const { status } = req.body || {};
  if (!['draft', 'active', 'closed'].includes(status)) throw new HttpError(400, 'Invalid status');
  await pool.query('UPDATE performance_cycles SET status = ? WHERE id = ? AND tenant_id = ?', [status, req.params.id, req.user.tenant_id]);
  res.json({ ok: true });
}));

// ---------- Goals ----------
r.get('/goals', requirePermission('performance.view'), asyncH(async (req, res) => {
  const params = [req.user.tenant_id];
  let where = 'g.tenant_id = ?';
  const viewScope = scopeFor(req.user, 'performance.view');
  if (!req.user.permissions.includes('performance.manage')) {
    where += ' AND (g.employee_id = ? OR g.employee_id IN (SELECT id FROM employees WHERE manager_id = ?))';
    params.push(req.user.employee_id, req.user.employee_id);
  } else if (viewScope === 'department') {
    where += ' AND (g.employee_id = ? OR g.employee_id IN (SELECT id FROM employees WHERE department_id IN (SELECT id FROM departments WHERE head_employee_id = ?)))';
    params.push(req.user.employee_id, req.user.employee_id);
  } else if (req.query.employee_id) { where += ' AND g.employee_id = ?'; params.push(req.query.employee_id); }
  if (req.query.cycle_id) { where += ' AND g.cycle_id = ?'; params.push(req.query.cycle_id); }
  const [rows] = await pool.query(
    `SELECT g.*, e.employee_code, e.first_name, e.last_name, c.name AS cycle_name
     FROM goals g JOIN employees e ON e.id = g.employee_id
     LEFT JOIN performance_cycles c ON c.id = g.cycle_id
     WHERE ${where} ORDER BY g.created_at DESC LIMIT 300`,
    params
  );
  res.json({ data: rows });
}));

r.post('/goals', requirePermission('performance.manage'), asyncH(async (req, res) => {
  const { employeeId, cycleId, title, description, kpi, weightage, target, dueDate } = req.body || {};
  if (!employeeId || !title) throw new HttpError(400, 'employeeId and title required');
  const [ins] = await pool.query(
    `INSERT INTO goals (tenant_id, employee_id, cycle_id, title, description, kpi, weightage, target, due_date, status, created_by)
     VALUES (?,?,?,?,?,?,?,?,?, 'active', ?)`,
    [req.user.tenant_id, employeeId, cycleId || null, title, description || null, kpi || null, weightage || 0, target || null, dueDate || null, req.user.id]
  );
  res.status(201).json({ data: { id: ins.insertId } });
}));

r.put('/goals/:id/progress', asyncH(async (req, res) => {
  const { progress, status, comment } = req.body || {};
  const [rows] = await pool.query('SELECT * FROM goals WHERE id = ? AND tenant_id = ?', [req.params.id, req.user.tenant_id]);
  if (!rows[0]) throw new HttpError(404, 'Goal not found');
  const g = rows[0];
  const isOwner = Number(g.employee_id) === Number(req.user.employee_id);
  const isManager = Number(req.user.employee_id) && req.user.permissions.includes('performance.manage');
  if (!isOwner && !isManager) throw new HttpError(403, 'Not allowed');
  if (progress !== undefined) await pool.query('UPDATE goals SET progress = ? WHERE id = ?', [Math.max(0, Math.min(100, Number(progress))), g.id]);
  if (status) await pool.query('UPDATE goals SET status = ? WHERE id = ?', [status, g.id]);
  if (comment && isManager) await pool.query('UPDATE goals SET manager_comment = ? WHERE id = ?', [comment, g.id]);
  res.json({ ok: true });
}));

// ---------- Reviews ----------
r.get('/reviews', requirePermission('performance.view'), asyncH(async (req, res) => {
  const params = [req.user.tenant_id];
  let where = 'rv.tenant_id = ?';
  const viewScope = scopeFor(req.user, 'performance.view');
  if (!req.user.permissions.includes('performance.manage')) {
    where += ' AND (rv.employee_id = ? OR rv.employee_id IN (SELECT id FROM employees WHERE manager_id = ?))';
    params.push(req.user.employee_id, req.user.employee_id);
  } else if (viewScope === 'department') {
    where += ' AND (rv.employee_id = ? OR rv.employee_id IN (SELECT id FROM employees WHERE department_id IN (SELECT id FROM departments WHERE head_employee_id = ?)))';
    params.push(req.user.employee_id, req.user.employee_id);
  } else if (req.query.cycle_id) {
    where += ' AND rv.cycle_id = ?';
    params.push(req.query.cycle_id);
  }
  const [rows] = await pool.query(
    `SELECT rv.*, e.employee_code, e.first_name, e.last_name, c.name AS cycle_name
     FROM reviews rv JOIN employees e ON e.id = rv.employee_id JOIN performance_cycles c ON c.id = rv.cycle_id
     WHERE ${where} ORDER BY rv.id DESC LIMIT 300`,
    params
  );
  res.json({ data: rows });
}));

r.post('/reviews', requirePermission('performance.manage'), asyncH(async (req, res) => {
  const { cycleId, employeeIds } = req.body || {};
  if (!cycleId || !Array.isArray(employeeIds) || !employeeIds.length) throw new HttpError(400, 'cycleId and employeeIds[] required');
  let created = 0;
  for (const eid of employeeIds) {
    const [ins] = await pool.query('INSERT IGNORE INTO reviews (tenant_id, cycle_id, employee_id) VALUES (?,?,?)', [req.user.tenant_id, cycleId, eid]);
    created += ins.affectedRows;
  }
  res.status(201).json({ data: { created } });
}));

r.post('/reviews/:id/self-review', asyncH(async (req, res) => {
  const { rating, comments } = req.body || {};
  const [rows] = await pool.query('SELECT * FROM reviews WHERE id = ? AND tenant_id = ?', [req.params.id, req.user.tenant_id]);
  if (!rows[0]) throw new HttpError(404, 'Review not found');
  if (Number(rows[0].employee_id) !== Number(req.user.employee_id)) throw new HttpError(403, 'Only the employee can submit self review');
  await pool.query('UPDATE reviews SET self_rating = ?, self_comments = ?, status = "self_review" WHERE id = ?', [rating || null, comments || null, rows[0].id]);
  res.json({ ok: true });
}));

r.post('/reviews/:id/manager-review', requirePermission('performance.review'), asyncH(async (req, res) => {
  const { rating, comments, finalRating } = req.body || {};
  const [rows] = await pool.query('SELECT * FROM reviews WHERE id = ? AND tenant_id = ?', [req.params.id, req.user.tenant_id]);
  if (!rows[0]) throw new HttpError(404, 'Review not found');
  await pool.query('UPDATE reviews SET manager_rating = ?, manager_comments = ?, final_rating = ?, status = ? WHERE id = ?', [
    rating || null, comments || null, finalRating || rating || null,
    finalRating || rating ? 'completed' : 'manager_review', rows[0].id,
  ]);
  await logAudit({ tenantId: req.user.tenant_id, actor: req.user, action: 'performance.manager_review', entityType: 'review', entityId: req.params.id, after: { rating }, req });
  res.json({ ok: true });
}));

module.exports = r;
