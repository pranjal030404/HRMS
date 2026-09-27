const express = require('express');
const dayjs = require('dayjs');
const { pool } = require('../config/db');
const { asyncH, HttpError, monthRange } = require('../utils/helpers');
const { authenticate, requirePermission, employeeScopeCondition, scopeFor, departmentRowCondition } = require('../middleware/auth');
const { punch, resolveDay, getShiftForEmployee, isHoliday } = require('../services/attendance');
const { logAudit } = require('../services/audit');
const { upload } = require('../middleware/upload');
const { parseCsv } = require('../utils/csv');

const r = express.Router();
r.use(authenticate);

const EMP_LITE = 'e.id, e.employee_code, e.first_name, e.last_name, e.email, e.location_id, e.department_id';

async function getEmployee(tenantId, employeeId) {
  const [rows] = await pool.query(`SELECT e.*, l.state AS loc_state FROM employees e LEFT JOIN locations l ON l.id = e.location_id WHERE e.id = ? AND e.tenant_id = ?`, [employeeId, tenantId]);
  return rows[0] || null;
}

// ---------- Self punch ----------
r.post('/punch', requirePermission('attendance.punch'), asyncH(async (req, res) => {
  const emp = await getEmployee(req.user.tenant_id, req.user.employee_id);
  if (!emp) throw new HttpError(400, 'No employee profile linked to this account');
  const result = await punch({ tenantId: req.user.tenant_id, employee: emp, source: req.body.source || 'web' });
  res.json({ data: result });
}));

r.get('/today', requirePermission('attendance.view'), asyncH(async (req, res) => {
  const emp = await getEmployee(req.user.tenant_id, req.user.employee_id);
  if (!emp) return res.json({ data: null });
  const today = dayjs().format('YYYY-MM-DD');
  const [recs] = await pool.query('SELECT * FROM attendance_records WHERE tenant_id = ? AND employee_id = ? AND adate = ?', [req.user.tenant_id, emp.id, today]);
  const resolved = await resolveDay({ tenantId: req.user.tenant_id, employee: emp, date: today, record: recs[0] || null });
  res.json({ data: resolved });
}));

// ---------- My month register ----------
r.get('/my', requirePermission('attendance.view'), asyncH(async (req, res) => {
  const emp = await getEmployee(req.user.tenant_id, req.user.employee_id);
  if (!emp) return res.json({ data: [] });
  const y = parseInt(req.query.year || dayjs().year(), 10);
  const m = parseInt(req.query.month || dayjs().month() + 1, 10);
  const { start, end } = monthRange(y, m);
  const [recs] = await pool.query('SELECT * FROM attendance_records WHERE tenant_id = ? AND employee_id = ? AND adate BETWEEN ? AND ?', [req.user.tenant_id, emp.id, start, end]);
  const byDate = Object.fromEntries(recs.map((x) => [dayjs(x.adate).format('YYYY-MM-DD'), x]));
  const out = [];
  for (let d = dayjs(start); d.isBefore(dayjs(end)) || d.isSame(dayjs(end)); d = d.add(1, 'day')) {
    if (d.isAfter(dayjs(), 'day')) break;
    const date = d.format('YYYY-MM-DD');
    out.push(await resolveDay({ tenantId: req.user.tenant_id, employee: emp, date, record: byDate[date] || null }));
  }
  res.json({ data: out });
}));

// ---------- Daily register (company) ----------
r.get('/register', requirePermission('attendance.view'), asyncH(async (req, res) => {
  const scope = employeeScopeCondition(req.user, 'attendance.view', 'e');
  const date = req.query.date || dayjs().format('YYYY-MM-DD');
  const params = [req.user.tenant_id, ...scope.params];
  let where = `e.tenant_id = ? AND e.deleted_at IS NULL AND e.status IN ('active','on_probation','on_notice') AND (${scope.sql})`;
  if (req.query.department_id) { where += ' AND e.department_id = ?'; params.push(req.query.department_id); }
  const [emps] = await pool.query(
    `SELECT ${EMP_LITE} FROM employees e WHERE ${where} ORDER BY e.employee_code`, params
  );
  const [recs] = await pool.query('SELECT * FROM attendance_records WHERE tenant_id = ? AND adate = ?', [req.user.tenant_id, date]);
  const byEmp = Object.fromEntries(recs.map((x) => [x.employee_id, x]));
  const rows = [];
  for (const emp of emps) {
    const resolved = await resolveDay({ tenantId: req.user.tenant_id, employee: emp, date, record: byEmp[emp.id] || null });
    rows.push({ ...resolved, employee: emp });
  }
  res.json({ data: rows, date });
}));

// ---------- Monthly grid (company) ----------
r.get('/monthly', requirePermission('attendance.view'), asyncH(async (req, res) => {
  const scope = employeeScopeCondition(req.user, 'attendance.view', 'e');
  const y = parseInt(req.query.year || dayjs().year(), 10);
  const m = parseInt(req.query.month || dayjs().month() + 1, 10);
  const { start, end } = monthRange(y, m);
  const params = [req.user.tenant_id, ...scope.params];
  let where = `e.tenant_id = ? AND e.deleted_at IS NULL AND e.status IN ('active','on_probation','on_notice') AND (${scope.sql})`;
  if (req.query.department_id) { where += ' AND e.department_id = ?'; params.push(req.query.department_id); }
  const [emps] = await pool.query(`SELECT ${EMP_LITE} FROM employees e WHERE ${where} ORDER BY e.employee_code`, params);
  const [recs] = await pool.query('SELECT * FROM attendance_records WHERE tenant_id = ? AND adate BETWEEN ? AND ?', [req.user.tenant_id, start, end]);
  const byKey = Object.fromEntries(recs.map((x) => [`${x.employee_id}|${dayjs(x.adate).format('YYYY-MM-DD')}`, x]));
  const days = [];
  for (let d = dayjs(start); d.isBefore(dayjs(end)) || d.isSame(dayjs(end)); d = d.add(1, 'day')) days.push(d.format('YYYY-MM-DD'));

  const rows = [];
  for (const emp of emps) {
    const cells = [];
    for (const date of days) {
      if (dayjs(date).isAfter(dayjs(), 'day')) { cells.push(null); continue; }
      const rec = byKey[`${emp.id}|${date}`];
      const resolved = await resolveDay({ tenantId: req.user.tenant_id, employee: emp, date, record: rec || null });
      cells.push({ status: resolved.status, lateMinutes: resolved.lateMinutes });
    }
    rows.push({ employee: emp, cells });
  }
  const [locks] = await pool.query('SELECT * FROM attendance_locks WHERE tenant_id = ? AND period_year = ? AND period_month = ?', [req.user.tenant_id, y, m]);
  res.json({ data: rows, days, locked: !!locks[0] });
}));

// ---------- Regularization ----------
r.get('/regularizations', requirePermission('attendance.view'), asyncH(async (req, res) => {
  const params = [req.user.tenant_id];
  let where = 'ar.tenant_id = ?';
  const regScope = scopeFor(req.user, 'attendance.view');
  const mine = req.query.mine === '1' || regScope === 'own';
  if (mine) {
    where += ' AND ar.employee_id = ?';
    params.push(req.user.employee_id);
  } else if (regScope === 'team') {
    where += ' AND ar.employee_id IN (SELECT id FROM employees WHERE manager_id = ?)';
    params.push(req.user.employee_id);
  } else if (regScope === 'department') {
    const cond = departmentRowCondition(req.user, 'ar.employee_id');
    where += ` AND ${cond.sql}`;
    params.push(...cond.params);
  }
  if (req.query.status) { where += ' AND ar.status = ?'; params.push(req.query.status); }
  const [rows] = await pool.query(
    `SELECT ar.*, e.employee_code, e.first_name, e.last_name FROM attendance_regularizations ar
     JOIN employees e ON e.id = ar.employee_id WHERE ${where} ORDER BY ar.created_at DESC LIMIT 200`,
    params
  );
  res.json({ data: rows });
}));

r.post('/regularizations', requirePermission('attendance.regularize'), asyncH(async (req, res) => {
  const { adate, requestedIn, requestedOut, reason } = req.body || {};
  if (!adate || !reason) throw new HttpError(400, 'Date and reason are required');
  if (dayjs(adate).isAfter(dayjs(), 'day')) throw new HttpError(400, 'Cannot regularize a future date');
  const [locks] = await pool.query('SELECT * FROM attendance_locks WHERE tenant_id = ? AND period_year = ? AND period_month = ?', [req.user.tenant_id, dayjs(adate).year(), dayjs(adate).month() + 1]);
  if (locks[0]) throw new HttpError(400, 'Attendance for this month is locked');
  const [dupe] = await pool.query(
    'SELECT id FROM attendance_regularizations WHERE tenant_id = ? AND employee_id = ? AND adate = ? AND status = "pending"',
    [req.user.tenant_id, req.user.employee_id, adate]
  );
  if (dupe[0]) throw new HttpError(409, 'A pending regularization already exists for this date');
  const [ins] = await pool.query(
    `INSERT INTO attendance_regularizations (tenant_id, employee_id, adate, requested_in, requested_out, reason) VALUES (?,?,?,?,?,?)`,
    [req.user.tenant_id, req.user.employee_id, adate, requestedIn || null, requestedOut || null, reason]
  );
  res.status(201).json({ data: { id: ins.insertId } });
}));

r.post('/regularizations/:id/action', requirePermission('attendance.approve'), asyncH(async (req, res) => {
  const { action, comment } = req.body || {};
  const [rows] = await pool.query(
    `SELECT ar.*, e.manager_id FROM attendance_regularizations ar JOIN employees e ON e.id = ar.employee_id
     WHERE ar.id = ? AND ar.tenant_id = ?`,
    [req.params.id, req.user.tenant_id]
  );
  const reg = rows[0];
  if (!reg) throw new HttpError(404, 'Request not found');
  if (reg.status !== 'pending') throw new HttpError(400, 'Request already actioned');
  const regScope = scopeFor(req.user, 'attendance.view');
  if (['team', 'department'].includes(regScope) && Number(reg.employee_id) === Number(req.user.employee_id)) throw new HttpError(403, 'Cannot approve your own request');
  if (regScope === 'department') {
    const [d] = await pool.query('SELECT department_id FROM employees WHERE id = ?', [reg.employee_id]);
    const [mine] = await pool.query('SELECT id FROM departments WHERE head_employee_id = ? AND id = ?', [req.user.employee_id, d[0]?.department_id]);
    if (!mine[0]) throw new HttpError(403, 'Not in your department');
  }
  const status = action === 'approve' ? 'approved' : 'rejected';
  await pool.query(
    'UPDATE attendance_regularizations SET status = ?, approver_id = ?, approver_comment = ?, actioned_at = NOW() WHERE id = ?',
    [status, req.user.id, comment || null, reg.id]
  );
  if (status === 'approved') {
    const emp = await getEmployee(req.user.tenant_id, reg.employee_id);
    await punch({ tenantId: req.user.tenant_id, employee: emp, source: 'system', when: reg.requested_in });
    if (reg.requested_out) {
      await punch({ tenantId: req.user.tenant_id, employee: emp, source: 'system', when: reg.requested_out });
    }
    await pool.query('UPDATE attendance_records SET is_regularized = 1 WHERE tenant_id = ? AND employee_id = ? AND adate = ?', [req.user.tenant_id, reg.employee_id, dayjs(reg.adate).format('YYYY-MM-DD')]);
  }
  await logAudit({ tenantId: req.user.tenant_id, actor: req.user, action: `attendance.regularization_${status}`, entityType: 'attendance_regularization', entityId: reg.id, before: { status: 'pending' }, after: { status }, req });
  res.json({ ok: true });
}));

// ---------- Biometric/CSV import ----------
r.post('/import', requirePermission('attendance.import'), upload('documents', { fieldName: 'file', maxSizeMb: 10 }), asyncH(async (req, res) => {
  if (!req.file) throw new HttpError(400, 'CSV file required');
  const fs = require('fs');
  const content = fs.readFileSync(req.file.path, 'utf8');
  fs.unlinkSync(req.file.path);
  const rows = parseCsv(content);
  if (rows.length < 2) throw new HttpError(400, 'CSV has no data rows');
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const idx = (name) => header.indexOf(name);
  if (idx('employee_code') === -1 || idx('timestamp') === -1) {
    throw new HttpError(400, 'CSV must have columns: employee_code, timestamp (YYYY-MM-DD HH:mm:ss)');
  }
  let success = 0;
  const errors = [];
  for (let i = 1; i < rows.length; i++) {
    const code = rows[i][idx('employee_code')]?.trim();
    const ts = rows[i][idx('timestamp')]?.trim();
    if (!code || !ts) { errors.push({ row: i + 1, error: 'missing fields' }); continue; }
    if (!dayjs(ts, 'YYYY-MM-DD HH:mm:ss').isValid() && !dayjs(ts, 'YYYY-MM-DD HH:mm').isValid()) { errors.push({ row: i + 1, error: 'bad timestamp' }); continue; }
    const [emps] = await pool.query('SELECT * FROM employees WHERE tenant_id = ? AND employee_code = ?', [req.user.tenant_id, code]);
    if (!emps[0]) { errors.push({ row: i + 1, error: `unknown employee_code ${code}` }); continue; }
    await punch({ tenantId: req.user.tenant_id, employee: emps[0], source: 'biometric', when: ts });
    success++;
  }
  await pool.query(
    'INSERT INTO attendance_imports (tenant_id, file_name, imported_by, total_rows, success_rows, error_rows, error_report) VALUES (?,?,?,?,?,?,?)',
    [req.user.tenant_id, req.file.originalname, req.user.id, rows.length - 1, success, errors.length, JSON.stringify(errors)]
  );
  await logAudit({ tenantId: req.user.tenant_id, actor: req.user, action: 'attendance.import', entityType: 'attendance_import', after: { success, errors: errors.length }, req });
  res.json({ data: { total: rows.length - 1, success, errors: errors.slice(0, 50) } });
}));

// ---------- Device push API (biometric integration point) ----------
r.post('/device-punch', asyncH(async (req, res) => {
  const deviceKey = req.headers['x-device-key'];
  if (!deviceKey) throw new HttpError(401, 'Device key required');
  const { getSetting } = require('../services/settings');
  const [tenants] = await pool.query('SELECT id FROM tenants');
  let matched = null;
  for (const t of tenants) {
    const cfg = await getSetting(t.id, 'attendance', {});
    if (cfg.deviceKey && cfg.deviceKey === deviceKey) { matched = t.id; break; }
  }
  if (!matched) throw new HttpError(401, 'Invalid device key');
  const { employeeCode, timestamp } = req.body || {};
  if (!employeeCode || !timestamp) throw new HttpError(400, 'employeeCode and timestamp required');
  const [emps] = await pool.query('SELECT * FROM employees WHERE tenant_id = ? AND employee_code = ?', [matched, employeeCode]);
  if (!emps[0]) throw new HttpError(404, 'Unknown employee');
  const result = await punch({ tenantId: matched, employee: emps[0], source: 'biometric', when: timestamp });
  res.json({ ok: true, ...result });
}));

// ---------- Monthly lock ----------
r.post('/lock', requirePermission('attendance.lock'), asyncH(async (req, res) => {
  const { year, month } = req.body || {};
  if (!year || !month) throw new HttpError(400, 'year and month required');
  await pool.query(
    'INSERT IGNORE INTO attendance_locks (tenant_id, period_year, period_month, locked_by) VALUES (?,?,?,?)',
    [req.user.tenant_id, year, month, req.user.id]
  );
  await logAudit({ tenantId: req.user.tenant_id, actor: req.user, action: 'attendance.lock', entityType: 'attendance_lock', entityId: `${year}-${month}`, req });
  res.json({ ok: true });
}));

r.delete('/lock', requirePermission('attendance.lock'), asyncH(async (req, res) => {
  const { year, month } = req.query;
  await pool.query('DELETE FROM attendance_locks WHERE tenant_id = ? AND period_year = ? AND period_month = ?', [req.user.tenant_id, year, month]);
  res.json({ ok: true });
}));

// ---------- Summary ----------
r.get('/summary', requirePermission('attendance.view'), asyncH(async (req, res) => {
  const date = req.query.date || dayjs().format('YYYY-MM-DD');
  const scope = employeeScopeCondition(req.user, 'attendance.view', 'e');
  const [rows] = await pool.query(
    `SELECT ar.status, COUNT(*) AS n FROM attendance_records ar
     JOIN employees e ON e.id = ar.employee_id
     WHERE ar.tenant_id = ? AND ar.adate = ? AND (${scope.sql})
     GROUP BY ar.status`,
    [req.user.tenant_id, date, ...scope.params]
  );
  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM employees e WHERE e.tenant_id = ? AND e.deleted_at IS NULL AND e.status IN ('active','on_probation','on_notice') AND (${scope.sql})`,
    [req.user.tenant_id, ...scope.params]
  );
  const byStatus = Object.fromEntries(rows.map((x) => [x.status, x.n]));
  res.json({ data: { date, total, byStatus, notMarked: total - rows.reduce((s, x) => s + x.n, 0) } });
}));

module.exports = r;
