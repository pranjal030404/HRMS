const express = require('express');
const dayjs = require('dayjs');
const { pool } = require('../config/db');
const { asyncH, HttpError } = require('../utils/helpers');
const { authenticate, requirePermission, employeeScopeCondition } = require('../middleware/auth');
const { logAudit } = require('../services/audit');
const { notifyEvent } = require('../services/notify');

const r = express.Router();
r.use(authenticate);

// ================= Onboarding =================
r.get('/onboarding', requirePermission('onboarding.view'), asyncH(async (req, res) => {
  const scope = employeeScopeCondition(req.user, 'employee.view', 'e');
  const params = [req.user.tenant_id, ...scope.params];
  const [rows] = await pool.query(
    `SELECT ot.*, e.employee_code, e.first_name, e.last_name, e.joined_on, e.status AS emp_status
     FROM onboarding_tasks ot JOIN employees e ON e.id = ot.employee_id
     WHERE ot.tenant_id = ? AND (${scope.sql})
     ORDER BY e.joined_on DESC, ot.id LIMIT 400`,
    params
  );
  // group by employee
  const grouped = {};
  for (const t of rows) {
    (grouped[t.employee_id] ||= { employeeId: t.employee_id, employeeCode: t.employee_code, name: `${t.first_name} ${t.last_name}`, joinedOn: t.joined_on, empStatus: t.emp_status, tasks: [] }).tasks.push(t);
  }
  res.json({ data: Object.values(grouped) });
}));

r.post('/onboarding/:id/complete', requirePermission('onboarding.view'), asyncH(async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM onboarding_tasks WHERE id = ? AND tenant_id = ?', [req.params.id, req.user.tenant_id]);
  if (!rows[0]) throw new HttpError(404, 'Task not found');
  const t = rows[0];
  const isOwn = Number(t.employee_id) === Number(req.user.employee_id);
  const canManage = req.user.permissions.includes('onboarding.manage');
  const isManager = t.assignee_role === 'manager' && req.user.permissions.includes('onboarding.view');
  if (!canManage && !(isOwn && ['employee', 'policy'].includes(t.assignee_role))) throw new HttpError(403, 'Not allowed to complete this task');
  const done = t.status === 'completed';
  await pool.query('UPDATE onboarding_tasks SET status = ?, completed_at = ?, completed_by = ? WHERE id = ?', [done ? 'pending' : 'completed', done ? null : dayjs().format('YYYY-MM-DD HH:mm:ss'), done ? null : req.user.id, req.params.id]);
  // auto-complete employee status when all tasks done
  if (!done) {
    const [[{ remaining }]] = await pool.query('SELECT COUNT(*) AS remaining FROM onboarding_tasks WHERE employee_id = ? AND status != "completed"', [t.employee_id]);
    if (remaining === 0) {
      await pool.query('UPDATE employees SET status = "active" WHERE id = ? AND status = "onboarding"', [t.employee_id]);
      await pool.query('INSERT INTO employee_timeline (tenant_id, employee_id, event_type, title, event_date, created_by) VALUES (?,?,?,?,CURDATE(),?)',
        [req.user.tenant_id, t.employee_id, 'onboarding_completed', 'Onboarding completed', req.user.id]);
    }
  }
  res.json({ ok: true });
}));

r.post('/onboarding/tasks', requirePermission('onboarding.manage'), asyncH(async (req, res) => {
  const { employeeId, title, description, category, assigneeRole, dueDate } = req.body || {};
  if (!employeeId || !title) throw new HttpError(400, 'employeeId and title required');
  const [ins] = await pool.query(
    'INSERT INTO onboarding_tasks (tenant_id, employee_id, title, description, category, assignee_role, due_date) VALUES (?,?,?,?,?,?,?)',
    [req.user.tenant_id, employeeId, title, description || null, category || 'general', assigneeRole || 'hr', dueDate || null]
  );
  res.status(201).json({ data: { id: ins.insertId } });
}));

// ================= Separations / Offboarding =================
r.get('/separations', requirePermission('separation.view'), asyncH(async (req, res) => {
  const scope = employeeScopeCondition(req.user, 'employee.view', 'e');
  const params = [req.user.tenant_id, ...scope.params];
  const [rows] = await pool.query(
    `SELECT s.*, e.employee_code, e.first_name, e.last_name, e.department_id, d.name AS department_name,
            ap.name AS approver_name,
            (SELECT COUNT(*) FROM clearances c WHERE c.separation_id = s.id AND c.status = 'cleared') AS clearances_done,
            (SELECT COUNT(*) FROM clearances c WHERE c.separation_id = s.id) AS clearances_total
     FROM separations s JOIN employees e ON e.id = s.employee_id
     LEFT JOIN departments d ON d.id = e.department_id
     LEFT JOIN users ap ON ap.id = s.approver_id
     WHERE s.tenant_id = ? AND (${scope.sql}) ORDER BY s.created_at DESC LIMIT 100`,
    params
  );
  res.json({ data: rows });
}));

// Employee submits resignation
r.post('/separations', asyncH(async (req, res) => {
  const { lastWorkingDay, reason } = req.body || {};
  if (!lastWorkingDay) throw new HttpError(400, 'Last working day required');
  if (dayjs(lastWorkingDay).isBefore(dayjs().add(29, 'day'))) {
    throw new HttpError(400, 'Notice period of at least 30 days is required');
  }
  const [dupe] = await pool.query(
    `SELECT id FROM separations WHERE tenant_id = ? AND employee_id = ? AND status NOT IN ('completed','withdrawn','rejected')`,
    [req.user.tenant_id, req.user.employee_id]
  );
  if (dupe[0]) throw new HttpError(409, 'A separation request already exists');
  const noticeDays = dayjs(lastWorkingDay).diff(dayjs(), 'day');
  const [ins] = await pool.query(
    `INSERT INTO separations (tenant_id, employee_id, sep_type, requested_on, last_working_day, notice_days, reason) VALUES (?,?,?,?,?,?,?)`,
    [req.user.tenant_id, req.user.employee_id, 'resignation', dayjs().format('YYYY-MM-DD'), lastWorkingDay, noticeDays, reason || null]
  );
  const [mgrs] = await pool.query(`SELECT u.id, u.email FROM users u WHERE u.tenant_id = ? AND u.role IN ('hr_admin','company_owner') AND u.status = 'active'`, [req.user.tenant_id]);
  await notifyEvent({
    tenantId: req.user.tenant_id, eventKey: 'announcement.published',
    vars: { title: 'Resignation submitted', body: `${req.user.name} submitted resignation with LWD ${lastWorkingDay}.` },
    recipients: mgrs.map((u) => ({ userId: u.id, email: u.email })), link: '/separations',
  });
  await logAudit({ tenantId: req.user.tenant_id, actor: req.user, action: 'separation.request', entityType: 'separation', entityId: ins.insertId, after: { lastWorkingDay }, req });
  res.status(201).json({ data: { id: ins.insertId } });
}));

r.post('/separations/:id/action', requirePermission('separation.approve'), asyncH(async (req, res) => {
  const { action, comment, lastWorkingDay } = req.body || {};
  const [rows] = await pool.query('SELECT * FROM separations WHERE id = ? AND tenant_id = ?', [req.params.id, req.user.tenant_id]);
  const sep = rows[0];
  if (!sep) throw new HttpError(404, 'Not found');
  if (action === 'approve') {
    if (sep.status !== 'requested') throw new HttpError(400, `Cannot approve from status ${sep.status}`);
    const lwd = lastWorkingDay || dayjs(sep.last_working_day).format('YYYY-MM-DD');
    await pool.query(
      'UPDATE separations SET status = "in_notice", approver_id = ?, approver_comment = ?, actioned_at = NOW(), last_working_day = ? WHERE id = ?',
      [req.user.id, comment || null, lwd, sep.id]
    );
    await pool.query('UPDATE employees SET status = "on_notice", exit_date = ? WHERE id = ?', [lwd, sep.employee_id]);
    await pool.query(
      'INSERT IGNORE INTO clearances (tenant_id, separation_id, department) VALUES (?,?,?),(?,?,?),(?,?,?),(?,?,?)',
      [req.user.tenant_id, sep.id, 'IT', req.user.tenant_id, sep.id, 'Admin', req.user.tenant_id, sep.id, 'Finance', req.user.tenant_id, sep.id, 'HR']
    );
    const [empUser] = await pool.query('SELECT u.id, u.email FROM users u WHERE u.employee_id = ?', [sep.employee_id]);
    await notifyEvent({
      tenantId: req.user.tenant_id, eventKey: 'separation.approved',
      vars: { lastWorkingDay: lwd }, recipients: empUser[0] ? [{ userId: empUser[0].id, email: empUser[0].email }] : [], link: '/portal/profile',
    });
  } else if (action === 'reject') {
    await pool.query('UPDATE separations SET status = "rejected", approver_id = ?, approver_comment = ?, actioned_at = NOW() WHERE id = ?', [req.user.id, comment || null, sep.id]);
  } else {
    throw new HttpError(400, 'Unknown action');
  }
  await logAudit({ tenantId: req.user.tenant_id, actor: req.user, action: `separation.${action}`, entityType: 'separation', entityId: sep.id, before: { status: sep.status }, req });
  res.json({ ok: true });
}));

r.post('/separations/:id/clearance/:department', requirePermission('separation.manage'), asyncH(async (req, res) => {
  const { remarks } = req.body || {};
  await pool.query(
    'UPDATE clearances SET status = "cleared", remarks = ?, signoff_by = ?, signed_at = NOW() WHERE separation_id = ? AND department = ?',
    [remarks || null, req.user.id, req.params.id, req.params.department]
  );
  const [[{ remaining }]] = await pool.query('SELECT COUNT(*) AS remaining FROM clearances WHERE separation_id = ? AND status = "pending"', [req.params.id]);
  if (remaining === 0) await pool.query('UPDATE separations SET status = "fnf_pending" WHERE id = ? AND status = "in_notice"', [req.params.id]);
  res.json({ ok: true });
}));

// Full & Final
r.get('/separations/:id/fnf', requirePermission('separation.view'), asyncH(async (req, res) => {
  const [items] = await pool.query('SELECT * FROM fnf_items WHERE separation_id = ? ORDER BY id', [req.params.id]);
  const [seps] = await pool.query('SELECT * FROM separations WHERE id = ? AND tenant_id = ?', [req.params.id, req.user.tenant_id]);
  if (!seps[0]) throw new HttpError(404, 'Not found');
  res.json({ data: items, separation: seps[0], total: items.reduce((s, i) => s + (i.ftype === 'payment' ? Number(i.amount) : -Number(i.amount)), 0) });
}));

r.post('/separations/:id/fnf', requirePermission('separation.manage'), asyncH(async (req, res) => {
  const { component, ftype, amount, remarks } = req.body || {};
  if (!component || !amount) throw new HttpError(400, 'component and amount required');
  await pool.query('INSERT INTO fnf_items (separation_id, component, ftype, amount, remarks) VALUES (?,?,?,?,?)', [req.params.id, component, ftype || 'payment', amount, remarks || null]);
  await pool.query('UPDATE separations SET fnf_status = "calculated" WHERE id = ?', [req.params.id]);
  res.status(201).json({ ok: true });
}));

r.post('/separations/:id/complete', requirePermission('separation.manage'), asyncH(async (req, res) => {
  const [seps] = await pool.query('SELECT * FROM separations WHERE id = ? AND tenant_id = ?', [req.params.id, req.user.tenant_id]);
  const sep = seps[0];
  if (!sep) throw new HttpError(404, 'Not found');
  await pool.query('UPDATE separations SET status = "completed", fnf_status = "paid" WHERE id = ?', [sep.id]);
  await pool.query('UPDATE employees SET status = "exited" WHERE id = ?', [sep.employee_id]);
  await pool.query('UPDATE users SET status = "disabled" WHERE employee_id = ?', [sep.employee_id]);
  await logAudit({ tenantId: req.user.tenant_id, actor: req.user, action: 'separation.complete', entityType: 'separation', entityId: sep.id, req });
  res.json({ ok: true });
}));

module.exports = r;
