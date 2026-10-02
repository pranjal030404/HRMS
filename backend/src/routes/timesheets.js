const express = require('express');
const dayjs = require('dayjs');
const { pool } = require('../config/db');
const { asyncH, HttpError } = require('../utils/helpers');
const { toCsv } = require('../utils/csv');
const { authenticate, requirePermission, employeeScopeCondition, canActOnEmployee, scopeFor } = require('../middleware/auth');
const { logAudit } = require('../services/audit');
const { notifyEvent } = require('../services/notify');
const ts = require('../services/timesheets');

const r = express.Router();
r.use(authenticate);

const { mondayOf } = ts;

/** Rows with the approval inbox + totals the list screens need. */
const LIST_COLUMNS = `t.id, t.week_start, t.status, t.locked, t.total_hours, t.billable_hours,
  t.non_billable_hours, t.approver_id, t.approver_comment, t.submitted_at, t.actioned_at,
  t.employee_id, e.employee_code, e.first_name, e.last_name, e.department_id,
  d.name AS department_name,
  CONCAT(e.first_name, ' ', e.last_name) AS employee_name,
  u.name AS approver_name`;

// ---------- Projects ----------
r.get('/projects', asyncH(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT p.*,
            (SELECT COUNT(*) FROM project_members pm WHERE pm.project_id = p.id AND pm.active = 1) AS member_count,
            (SELECT COALESCE(SUM(te.hours), 0) FROM timesheet_entries te WHERE te.project_id = p.id
               AND te.entry_date >= DATE_SUB(CURDATE(), INTERVAL 90 DAY)) AS hours_90d
     FROM projects p WHERE p.tenant_id = ? ORDER BY p.name LIMIT 300`,
    [req.user.tenant_id]
  );
  res.json({ data: rows });
}));

r.post('/projects', requirePermission('timesheet.manage'), asyncH(async (req, res) => {
  const { name, code, client, billable, billRate, costRate, departmentId, defaultProject } = req.body || {};
  if (!name) throw new HttpError(400, 'name required');
  const [ins] = await pool.query(
    `INSERT INTO projects (tenant_id, name, code, client, billable, bill_rate, cost_rate, department_id, default_project)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [req.user.tenant_id, name, code || null, client || null, billable ? 1 : 0,
      Number(billRate) || 0, Number(costRate) || 0, departmentId || null, defaultProject ? 1 : 0]
  );
  await logAudit({ tenantId: req.user.tenant_id, actor: req.user, action: 'timesheet.project_create', entityType: 'project', entityId: ins.insertId, after: { name }, req });
  res.status(201).json({ data: { id: ins.insertId } });
}));

r.put('/projects/:id', requirePermission('timesheet.manage'), asyncH(async (req, res) => {
  const { name, code, client, billable, billRate, costRate, departmentId, defaultProject, status } = req.body || {};
  const [existing] = await pool.query('SELECT id, name, bill_rate, cost_rate, status FROM projects WHERE id = ? AND tenant_id = ?', [req.params.id, req.user.tenant_id]);
  if (!existing[0]) throw new HttpError(404, 'Project not found');
  await pool.query(
    `UPDATE projects SET name = COALESCE(?, name), code = COALESCE(?, code), client = COALESCE(?, client),
            billable = COALESCE(?, billable), bill_rate = COALESCE(?, bill_rate), cost_rate = COALESCE(?, cost_rate),
            department_id = COALESCE(?, department_id), default_project = COALESCE(?, default_project),
            status = COALESCE(?, status)
     WHERE id = ? AND tenant_id = ?`,
    [name || null, code || null, client || null,
      billable === undefined ? null : (billable ? 1 : 0),
      billRate === undefined ? null : Number(billRate) || 0,
      costRate === undefined ? null : Number(costRate) || 0,
      departmentId === undefined ? null : departmentId,
      defaultProject === undefined ? null : (defaultProject ? 1 : 0),
      status || null, req.params.id, req.user.tenant_id]
  );
  await logAudit({
    tenantId: req.user.tenant_id, actor: req.user, action: 'timesheet.project_update', entityType: 'project', entityId: req.params.id,
    before: existing[0], after: { name, billRate, costRate, status }, req,
  });
  res.json({ ok: true });
}));

// ---------- Project members / allocation ----------
r.get('/projects/:id/members', asyncH(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT pm.*, e.employee_code, CONCAT(e.first_name,' ',e.last_name) AS employee_name, d.name AS department
     FROM project_members pm JOIN employees e ON e.id = pm.employee_id
     LEFT JOIN departments d ON d.id = e.department_id
     WHERE pm.tenant_id = ? AND pm.project_id = ? ORDER BY e.employee_code`,
    [req.user.tenant_id, req.params.id]
  );
  res.json({ data: rows });
}));

r.post('/projects/:id/members', requirePermission('timesheet.manage'), asyncH(async (req, res) => {
  const { employeeId, allocationPct, fromDate, toDate } = req.body || {};
  if (!employeeId) throw new HttpError(400, 'employeeId required');
  const pct = Number(allocationPct) || 0;
  if (pct < 0 || pct > 100) throw new HttpError(400, 'allocationPct must be between 0 and 100');
  // Both the project and the employee must belong to the caller's tenant, otherwise a valid
  // id from another tenant could be used to attach membership rows.
  const [project] = await pool.query('SELECT id FROM projects WHERE id = ? AND tenant_id = ?', [req.params.id, req.user.tenant_id]);
  if (!project[0]) throw new HttpError(404, 'Project not found');
  const [emp] = await pool.query('SELECT id FROM employees WHERE id = ? AND tenant_id = ?', [employeeId, req.user.tenant_id]);
  if (!emp[0]) throw new HttpError(404, 'Employee not found');
  await pool.query(
    `INSERT INTO project_members (tenant_id, project_id, employee_id, allocation_pct, from_date, to_date, active)
     VALUES (?,?,?,?,?,?,1)
     ON DUPLICATE KEY UPDATE allocation_pct = VALUES(allocation_pct), from_date = VALUES(from_date),
                             to_date = VALUES(to_date), active = 1`,
    [req.user.tenant_id, req.params.id, employeeId, pct, fromDate || null, toDate || null]
  );
  await logAudit({ tenantId: req.user.tenant_id, actor: req.user, action: 'timesheet.project_member_add', entityType: 'project', entityId: req.params.id, after: { employeeId, allocationPct: pct }, req });
  res.status(201).json({ ok: true });
}));

r.delete('/projects/:id/members/:employeeId', requirePermission('timesheet.manage'), asyncH(async (req, res) => {
  await pool.query(
    `UPDATE project_members SET active = 0, to_date = COALESCE(to_date, CURDATE())
     WHERE tenant_id = ? AND project_id = ? AND employee_id = ?`,
    [req.user.tenant_id, req.params.id, req.params.employeeId]
  );
  res.json({ ok: true });
}));

// ---------- Weekly grid (self-service) ----------
r.get('/my', asyncH(async (req, res) => {
  if (!req.user.employee_id) throw new HttpError(400, 'No linked employee');
  const sheet = await ts.getWeekly(req.user.tenant_id, req.user.employee_id, req.query.week || dayjs());
  res.json({ data: sheet });
}));

r.post('/my', requirePermission('timesheet.create'), asyncH(async (req, res) => {
  if (!req.user.employee_id) throw new HttpError(400, 'No linked employee');
  const { week, entries } = req.body || {};
  const saved = await ts.saveWeekly(req.user.tenant_id, req.user.employee_id, week || dayjs(), entries, req.user);
  res.json({ data: saved, issues: saved.issues });
}));

r.post('/my/submit', requirePermission('timesheet.create'), asyncH(async (req, res) => {
  if (!req.user.employee_id) throw new HttpError(400, 'No linked employee');
  const week = req.query.week || req.body?.week || dayjs();
  const weekStart = mondayOf(week);
  const result = await ts.submitWeekly(req.user.tenant_id, req.user.employee_id, weekStart, req.user);
  // notify the reporting manager
  const [mgr] = await pool.query(
    `SELECT u.id FROM employees e JOIN users u ON u.employee_id = e.id AND u.status = 'active'
     WHERE e.id = (SELECT manager_id FROM employees WHERE id = ?)`,
    [req.user.employee_id]
  );
  if (mgr.length) {
    await notifyEvent({
      tenantId: req.user.tenant_id, eventKey: 'timesheet.submitted',
      vars: {
        title: 'Timesheet awaiting approval',
        body: `${req.user.name} submitted ${result.totalHours}h for the week of ${weekStart}.`,
      },
      recipients: mgr.map((m) => ({ userId: m.id })),
      link: '/timesheets',
    });
  }
  res.json({ data: result });
}));

// ---------- Listing ----------
r.get('/', asyncH(async (req, res) => {
  const params = [req.user.tenant_id];
  let where = 't.tenant_id = ?';
  const scope = scopeFor(req.user, 'timesheet.view');
  if (scope === 'own' && !req.query.all) {
    where += ' AND t.employee_id = ?';
    params.push(req.user.employee_id || 0);
  } else {
    const empScope = employeeScopeCondition(req.user, 'timesheet.view', 'e');
    where += ` AND ${empScope.sql}`;
    params.push(...empScope.params);
  }
  if (req.query.status) { where += ' AND t.status = ?'; params.push(req.query.status); }
  if (req.query.employee_id) { where += ' AND t.employee_id = ?'; params.push(req.query.employee_id); }
  if (req.query.from) { where += ' AND t.week_start >= ?'; params.push(req.query.from); }
  if (req.query.to) { where += ' AND t.week_start <= ?'; params.push(req.query.to); }
  if (req.query.locked === '1') where += ' AND t.locked = 1';

  const [rows] = await pool.query(
    `SELECT ${LIST_COLUMNS} FROM timesheets t
     JOIN employees e ON e.id = t.employee_id
     LEFT JOIN departments d ON d.id = e.department_id
     LEFT JOIN users u ON u.id = t.approver_id
     WHERE ${where} ORDER BY t.week_start DESC, e.employee_code LIMIT 500`,
    params
  );

  if (req.query.format === 'csv') {
    const csv = toCsv(rows, [
      { key: 'week_start', header: 'week_start' }, { key: 'employee_code', header: 'employee_code' },
      { key: 'employee_name', header: 'employee_name' }, { key: 'department_name', header: 'department' },
      { key: 'total_hours', header: 'total_hours' }, { key: 'billable_hours', header: 'billable_hours' },
      { key: 'non_billable_hours', header: 'non_billable_hours' }, { key: 'status', header: 'status' },
      { key: 'approver_name', header: 'approver' }, { key: 'approver_comment', header: 'comment' },
    ]);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=timesheets-${dayjs().format('YYYYMMDD')}.csv`);
    return res.send(csv);
  }
  res.json({ data: rows, summary: summarize(rows) });
}));

const summarize = (rows) => ({
  sheets: rows.length,
  employees: new Set(rows.map((x) => x.employee_id)).size,
  totalHours: Math.round(rows.reduce((s, x) => s + Number(x.total_hours || 0), 0) * 100) / 100,
  billableHours: Math.round(rows.reduce((s, x) => s + Number(x.billable_hours || 0), 0) * 100) / 100,
  pending: rows.filter((x) => x.status === 'submitted').length,
  approved: rows.filter((x) => x.status === 'approved').length,
  rejected: rows.filter((x) => x.status === 'rejected').length,
});

// ---------- Approval inbox ----------
r.get('/pending', requirePermission('timesheet.approve'), asyncH(async (req, res) => {
  const params = [req.user.tenant_id];
  let where = `t.tenant_id = ? AND t.status = 'submitted'`;
  const empScope = employeeScopeCondition(req.user, 'timesheet.view', 'e');
  where += ` AND ${empScope.sql}`;
  params.push(...empScope.params);
  const [rows] = await pool.query(
    `SELECT ${LIST_COLUMNS}, (t.submitted_by = ?) AS is_own_submission
     FROM timesheets t JOIN employees e ON e.id = t.employee_id
     LEFT JOIN departments d ON d.id = e.department_id
     LEFT JOIN users u ON u.id = t.approver_id
     WHERE ${where} ORDER BY t.submitted_at ASC LIMIT 200`,
    [req.user.id, ...params]
  );
  res.json({ data: rows });
}));

// ---------- Period locking ----------
// Deliberately requires timesheet.manage rather than timesheet.approve: locking a week is a
// company-wide, payroll-affecting action, and managers hold approve at team scope.
r.get('/locks', requirePermission('timesheet.manage'), asyncH(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT week_start, SUM(locked) AS locked_sheets, COUNT(*) AS total_sheets,
            SUM(status = 'approved') AS approved_sheets
     FROM timesheets WHERE tenant_id = ?
     GROUP BY week_start ORDER BY week_start DESC LIMIT 60`,
    [req.user.tenant_id]
  );
  res.json({ data: rows });
}));

r.post('/locks', requirePermission('timesheet.manage'), asyncH(async (req, res) => {
  const { from, to, locked } = req.body || {};
  const result = await ts.setPeriodLock(req.user.tenant_id, from, to, locked !== false, req.user);
  res.json({ data: result });
}));

// ---------- Analytics ----------
// Declared before `/:id` so the literal path is not captured as an id.
r.get('/analytics', requirePermission('timesheet.view'), asyncH(async (req, res) => {
  // Resolve the caller's employee scope so a manager only ever aggregates their own team.
  const scope = scopeFor(req.user, 'timesheet.view');
  let employeeIds = null;
  if (scope === 'own') {
    employeeIds = [req.user.employee_id].filter(Boolean);
  } else if (scope === 'team' || scope === 'department') {
    const cond = employeeScopeCondition(req.user, 'timesheet.view', 'e');
    const [rows] = await pool.query(
      `SELECT e.id FROM employees e WHERE e.tenant_id = ? AND ${cond.sql} AND e.deleted_at IS NULL`,
      [req.user.tenant_id, ...cond.params]
    );
    employeeIds = rows.map((x) => x.id);
  }

  const data = await ts.analytics(req.user.tenant_id, {
    from: req.query.from,
    to: req.query.to,
    employeeId: req.query.employee_id,
    employeeIds,
    projectId: req.query.project_id,
    groupBy: req.query.group_by || 'employee',
    includeDraft: req.query.include_draft === '1' && req.user.permissions.includes('timesheet.manage'),
  });
  if (req.query.format === 'csv') {
    const csv = toCsv(data.buckets, [
      { key: 'label', header: req.query.group_by || 'employee' }, { key: 'hours', header: 'hours' },
      { key: 'billableHours', header: 'billable_hours' }, { key: 'nonBillableHours', header: 'non_billable_hours' },
      { key: 'billablePct', header: 'billable_pct' }, { key: 'billableValue', header: 'billable_value' },
      { key: 'costValue', header: 'cost_value' }, { key: 'margin', header: 'margin' },
    ]);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=timesheet-analytics-${dayjs().format('YYYYMMDD')}.csv`);
    return res.send(csv);
  }
  res.json({ data });
}));

// ---------- Single sheet ----------
r.get('/:id', requirePermission('timesheet.view'), asyncH(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT ${LIST_COLUMNS} FROM timesheets t JOIN employees e ON e.id = t.employee_id
     LEFT JOIN departments d ON d.id = e.department_id LEFT JOIN users u ON u.id = t.approver_id
     WHERE t.id = ? AND t.tenant_id = ?`,
    [req.params.id, req.user.tenant_id]
  );
  if (!rows[0]) throw new HttpError(404, 'Timesheet not found');
  // Viewing a sheet is scope-restricted exactly like listing: own sheets always, wider scopes
  // only for employees the caller is allowed to act on.
  if (!(await canActOnEmployee(req.user, 'timesheet.view', rows[0].employee_id))) {
    throw new HttpError(403, 'Outside your timesheet scope');
  }
  const sheet = await ts.getWeekly(req.user.tenant_id, rows[0].employee_id, rows[0].week_start);
  res.json({ data: { ...sheet, ...rows[0] } });
}));

r.put('/:id/action', requirePermission('timesheet.approve'), asyncH(async (req, res) => {
  const { action, comment } = req.body || {}; // approved | rejected
  if (!['approved', 'rejected'].includes(action)) throw new HttpError(400, 'action must be approved or rejected');
  const [rows] = await pool.query('SELECT id, employee_id, status, locked, week_start FROM timesheets WHERE id = ? AND tenant_id = ?', [req.params.id, req.user.tenant_id]);
  const t = rows[0];
  if (!t) throw new HttpError(404, 'Timesheet not found');
  if (!(await canActOnEmployee(req.user, 'timesheet.view', t.employee_id))) throw new HttpError(403, 'Outside your approval scope');

  const result = await ts.actionTimesheet(req.user.tenant_id, t.id, action, comment, req.user);
  const [empUsers] = await pool.query('SELECT id FROM users WHERE employee_id = ?', [t.employee_id]);
  await notifyEvent({
    tenantId: req.user.tenant_id, eventKey: 'timesheet.actioned',
    vars: {
      title: `Timesheet ${action}`,
      body: comment || `Week of ${dayjs(t.week_start || '').format('D MMM')} — ${action} by ${req.user.name}`,
    },
    recipients: empUsers.map((u) => ({ userId: u.id })),
    link: '/timesheets',
  });
  res.json({ data: result });
}));

module.exports = r;