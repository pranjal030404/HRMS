const express = require('express');
const dayjs = require('dayjs');
const { pool } = require('../config/db');
const { asyncH, HttpError, monthRange } = require('../utils/helpers');
const { authenticate, requirePermission, scopeFor, departmentRowCondition, headedDepartmentIds } = require('../middleware/auth');
const { getBalances, priceLeaveRequest, markLeaveAttendance, revertLeaveAttendance } = require('../services/leave');
const { logAudit } = require('../services/audit');
const { notifyEvent } = require('../services/notify');
const { fireTrigger } = require('../services/workflow');
const { emitEvent } = require('../services/webhooks');

const r = express.Router();
r.use(authenticate);

async function getEmployee(tenantId, id) {
  const [rows] = await pool.query('SELECT * FROM employees WHERE id = ? AND tenant_id = ?', [id, tenantId]);
  return rows[0] || null;
}

// ---------- Balances ----------
r.get('/balances', requirePermission('leave.view'), asyncH(async (req, res) => {
  const empId = req.query.employee_id ? Number(req.query.employee_id) : req.user.employee_id;
  if (!empId) return res.json({ data: [] });
  // scope check
  const scope = scopeFor(req.user, 'leave.view');
  if (scope !== 'company' && Number(empId) !== Number(req.user.employee_id)) {
    if (scope === 'team') {
      const [rows] = await pool.query('SELECT manager_id FROM employees WHERE id = ?', [empId]);
      if (Number(rows[0]?.manager_id) !== Number(req.user.employee_id)) throw new HttpError(403, 'Not in your team');
    } else if (scope === 'department') {
      const [rows] = await pool.query('SELECT department_id FROM employees WHERE id = ?', [empId]);
      const [mine] = await pool.query('SELECT id FROM departments WHERE head_employee_id = ? AND id = ?', [req.user.employee_id, rows[0]?.department_id]);
      if (!mine[0]) throw new HttpError(403, 'Not in your department');
    } else {
      throw new HttpError(403, 'Not allowed to view this balance');
    }
  }
  const emp = await getEmployee(req.user.tenant_id, empId);
  if (!emp) throw new HttpError(404, 'Employee not found');
  const year = parseInt(req.query.year || dayjs().year(), 10);
  const balances = await getBalances(req.user.tenant_id, emp, year);
  res.json({ data: balances });
}));

// ---------- Apply ----------
r.post('/requests', requirePermission('leave.apply'), asyncH(async (req, res) => {
  const { leaveTypeId, startDate, endDate, dayPart, reason, contactDuringLeave } = req.body || {};
  if (!leaveTypeId || !startDate || !endDate) throw new HttpError(400, 'leaveTypeId, startDate, endDate required');
  if (dayjs(endDate).isBefore(dayjs(startDate))) throw new HttpError(400, 'End date before start date');
  const emp = await getEmployee(req.user.tenant_id, req.user.employee_id);
  if (!emp) throw new HttpError(400, 'No employee profile linked');
  const [types] = await pool.query('SELECT * FROM leave_types WHERE id = ? AND tenant_id = ?', [leaveTypeId, req.user.tenant_id]);
  const type = types[0];
  if (!type) throw new HttpError(404, 'Leave type not found');

  // overlap check
  const [overlap] = await pool.query(
    `SELECT id FROM leave_requests WHERE tenant_id = ? AND employee_id = ? AND status IN ('pending','approved')
     AND start_date <= ? AND end_date >= ?`,
    [req.user.tenant_id, emp.id, endDate, startDate]
  );
  if (overlap[0]) throw new HttpError(409, 'You already have a leave request overlapping these dates');

  const { days, breakdown } = await priceLeaveRequest({ tenantId: req.user.tenant_id, employee: emp, type, startDate, endDate, dayPart });

  // balance check
  const balances = await getBalances(req.user.tenant_id, emp, dayjs(startDate).year());
  const bal = balances.find((b) => b.leaveTypeId === Number(leaveTypeId));
  if (bal && !type.negative_balance_allowed && bal.available < days) {
    throw new HttpError(400, `Insufficient balance: ${bal.available} day(s) available, ${days} requested`);
  }

  const [ins] = await pool.query(
    `INSERT INTO leave_requests (tenant_id, employee_id, leave_type_id, start_date, end_date, days, day_part, reason, contact_during_leave, day_breakdown)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [req.user.tenant_id, emp.id, leaveTypeId, startDate, endDate, days, dayPart || 'full', reason || null, contactDuringLeave || null, JSON.stringify(breakdown)]
  );

  // notify manager + HR
  const recipients = [];
  if (emp.manager_id) {
    const [mgr] = await pool.query('SELECT u.id, u.email FROM users u WHERE u.employee_id = ?', [emp.manager_id]);
    if (mgr[0]) recipients.push({ userId: mgr[0].id, email: mgr[0].email });
  }
  const [hrs] = await pool.query(`SELECT u.id, u.email FROM users u WHERE u.tenant_id = ? AND u.role IN ('hr_admin','company_owner') AND u.status = 'active'`, [req.user.tenant_id]);
  for (const h of hrs) recipients.push({ userId: h.id, email: h.email });
  await notifyEvent({
    tenantId: req.user.tenant_id, eventKey: 'leave.submitted',
    vars: { employeeName: `${emp.first_name} ${emp.last_name}`, leaveTypeName: type.name, startDate, endDate, days },
    recipients, link: '/leave/requests',
  });
  await logAudit({ tenantId: req.user.tenant_id, actor: req.user, action: 'leave.apply', entityType: 'leave_request', entityId: ins.insertId, after: { startDate, endDate, days }, req });
  // workflow engine (spec §7): long leaves route through configured approval workflows
  await fireTrigger({ tenantId: req.user.tenant_id, triggerEvent: 'leave.submitted', entityType: 'leave_request', entityId: ins.insertId, ctx: { employeeId: emp.id, days, leaveTypeId: type.id }, req });
  await emitEvent({ tenantId: req.user.tenant_id, eventType: 'leave.submitted', payload: { id: ins.insertId, employeeId: emp.id, days, startDate, endDate } });
  res.status(201).json({ data: { id: ins.insertId, days, breakdown } });
}));

// ---------- List requests ----------
r.get('/requests', requirePermission('leave.view'), asyncH(async (req, res) => {
  const params = [req.user.tenant_id];
  let where = 'lr.tenant_id = ?';
  const mine = req.query.mine === '1';
  const scope = scopeFor(req.user, 'leave.view');
  const pendingForMe = req.query.pending_for_me === '1';

  if (mine || scope === 'own') {
    where += ' AND lr.employee_id = ?';
    params.push(req.user.employee_id);
  } else if (pendingForMe) {
    // approver inbox: own team / own department + anything visible company-wide
    if (scope === 'team') {
      where += ' AND (lr.employee_id IN (SELECT id FROM employees WHERE manager_id = ?) OR lr.employee_id = ?)';
      params.push(req.user.employee_id, req.user.employee_id);
    } else if (scope === 'department') {
      const cond = departmentRowCondition(req.user, 'lr.employee_id');
      where += ` AND ${cond.sql}`;
      params.push(...cond.params);
    }
    where += ' AND lr.status = "pending"';
  } else if (scope === 'team') {
    where += ' AND (lr.employee_id IN (SELECT id FROM employees WHERE manager_id = ?) OR lr.employee_id = ?)';
    params.push(req.user.employee_id, req.user.employee_id);
  } else if (scope === 'department') {
    const cond = departmentRowCondition(req.user, 'lr.employee_id');
    where += ` AND ${cond.sql}`;
    params.push(...cond.params);
  }
  if (req.query.status) { where += ' AND lr.status = ?'; params.push(req.query.status); }
  if (req.query.year) { where += ' AND YEAR(lr.start_date) = ?'; params.push(req.query.year); }
  const [rows] = await pool.query(
    `SELECT lr.*, lt.name AS leave_type_name, lt.code AS leave_type_code, lt.is_paid,
            e.employee_code, e.first_name, e.last_name, e.manager_id,
            ap.name AS approver_name
     FROM leave_requests lr
     JOIN leave_types lt ON lt.id = lr.leave_type_id
     JOIN employees e ON e.id = lr.employee_id
     LEFT JOIN users ap ON ap.id = lr.approver_id
     WHERE ${where} ORDER BY lr.applied_at DESC LIMIT 300`,
    params
  );
  res.json({ data: rows });
}));

// ---------- Action (approve/reject/cancel) ----------
r.post('/requests/:id/action', requirePermission('leave.view'), asyncH(async (req, res) => {
  const { action, comment } = req.body || {};
  const [rows] = await pool.query(
    `SELECT lr.*, lt.name AS leave_type_name, lt.is_paid, lt.requires_approval, e.first_name, e.last_name, e.email, e.manager_id, e.department_id
     FROM leave_requests lr JOIN leave_types lt ON lt.id = lr.leave_type_id JOIN employees e ON e.id = lr.employee_id
     WHERE lr.id = ? AND lr.tenant_id = ?`,
    [req.params.id, req.user.tenant_id]
  );
  const reqRow = rows[0];
  if (!reqRow) throw new HttpError(404, 'Leave request not found');
  const isSelf = Number(reqRow.employee_id) === Number(req.user.employee_id);
  const scope = scopeFor(req.user, 'leave.view');
  // approvals are scope-bounded: company sees all, department heads their department,
  // managers their direct reports (plus unassigned employees)
  let canApprove = false;
  if (scope === 'company') {
    canApprove = req.user.permissions.includes('leave.approve');
  } else if (scope === 'department') {
    const deptIds = await headedDepartmentIds(req.user.employee_id);
    canApprove = req.user.permissions.includes('leave.approve')
      && (!reqRow.manager_id || Number(reqRow.manager_id) === Number(req.user.employee_id) || deptIds.includes(Number(reqRow.department_id)));
  } else if (scope === 'team') {
    canApprove = req.user.permissions.includes('leave.approve')
      && (Number(reqRow.manager_id) === Number(req.user.employee_id) || !reqRow.manager_id);
  }

  if (['approve', 'reject'].includes(action)) {
    if (!canApprove) throw new HttpError(403, 'Not authorized to approve this request');
    if (reqRow.status !== 'pending') throw new HttpError(400, 'Request already actioned');
    if (isSelf && scope !== 'company' && reqRow.manager_id) throw new HttpError(403, 'Manager approval required for own request');
    const status = action === 'approve' ? 'approved' : 'rejected';
    await pool.query('UPDATE leave_requests SET status = ?, approver_id = ?, approver_comment = ?, actioned_at = NOW() WHERE id = ?', [status, req.user.id, comment || null, reqRow.id]);
    if (status === 'approved') {
      const emp = await getEmployee(req.user.tenant_id, reqRow.employee_id);
      await markLeaveAttendance(req.user.tenant_id, emp, { id: reqRow.id, day_breakdown: typeof reqRow.day_breakdown === 'string' ? JSON.parse(reqRow.day_breakdown) : reqRow.day_breakdown }, { name: reqRow.leave_type_name });
    } else {
      // revert any attendance marks (defensive)
      const emp = await getEmployee(req.user.tenant_id, reqRow.employee_id);
      await revertLeaveAttendance(req.user.tenant_id, reqRow.employee_id, typeof reqRow.day_breakdown === 'string' ? JSON.parse(reqRow.day_breakdown) : reqRow.day_breakdown);
    }
    await notifyEvent({
      tenantId: req.user.tenant_id, eventKey: 'leave.actioned',
      vars: { status, leaveTypeName: reqRow.leave_type_name, startDate: dayjs(reqRow.start_date).format('YYYY-MM-DD'), endDate: dayjs(reqRow.end_date).format('YYYY-MM-DD'), comment: comment || '-' },
      recipients: [{ userId: null, email: reqRow.email }], link: '/portal/leave',
    });
    await logAudit({ tenantId: req.user.tenant_id, actor: req.user, action: `leave.${status}`, entityType: 'leave_request', entityId: reqRow.id, before: { status: 'pending' }, after: { status }, req });
  } else if (action === 'cancel' || action === 'withdraw') {
    if (!isSelf && !canApprove) throw new HttpError(403, 'Not allowed');
    if (!['pending', 'approved'].includes(reqRow.status)) throw new HttpError(400, 'Cannot cancel this request');
    await pool.query('UPDATE leave_requests SET status = "cancelled", actioned_at = NOW() WHERE id = ?', [reqRow.id]);
    const emp = await getEmployee(req.user.tenant_id, reqRow.employee_id);
    await revertLeaveAttendance(req.user.tenant_id, reqRow.employee_id, typeof reqRow.day_breakdown === 'string' ? JSON.parse(reqRow.day_breakdown) : reqRow.day_breakdown);
    await logAudit({ tenantId: req.user.tenant_id, actor: req.user, action: 'leave.cancel', entityType: 'leave_request', entityId: reqRow.id, before: { status: reqRow.status }, req });
  } else {
    throw new HttpError(400, 'Unknown action');
  }
  res.json({ ok: true });
}));

// ---------- Team calendar ----------
r.get('/calendar', requirePermission('leave.view'), asyncH(async (req, res) => {
  const y = parseInt(req.query.year || dayjs().year(), 10);
  const m = parseInt(req.query.month || dayjs().month() + 1, 10);
  const { start, end } = monthRange(y, m);
  const scope = scopeFor(req.user, 'leave.view');
  const params = [req.user.tenant_id, start, end];
  let empWhere = 'e.tenant_id = ? AND e.deleted_at IS NULL AND e.status IN ("active","on_probation","on_notice")';
  if (scope === 'team') {
    empWhere += ' AND (e.manager_id = ? OR e.id = ?)';
    params.push(req.user.employee_id, req.user.employee_id);
  } else if (scope === 'department') {
    empWhere += ' AND (e.id = ? OR e.department_id IN (SELECT id FROM departments WHERE head_employee_id = ?))';
    params.push(req.user.employee_id, req.user.employee_id);
  } else if (scope === 'own') {
    empWhere += ' AND e.id = ?';
    params.push(req.user.employee_id);
  }
  const [rows] = await pool.query(
    `SELECT lr.employee_id, lr.start_date, lr.end_date, lr.days, lr.status, lt.code, lt.name,
            e.first_name, e.last_name, e.employee_code
     FROM leave_requests lr JOIN leave_types lt ON lt.id = lr.leave_type_id JOIN employees e ON e.id = lr.employee_id
     WHERE lr.tenant_id = ? AND lr.status = 'approved' AND lr.start_date <= ? AND lr.end_date >= ?
       AND ${empWhere}`,
    params
  );
  res.json({ data: rows, month: { year: y, month: m } });
}));

// ---------- Year-end carry forward (admin) ----------
r.post('/year-end-carry-forward', requirePermission('leave.configure'), asyncH(async (req, res) => {
  const { fromYear } = req.body || {};
  const year = parseInt(fromYear || dayjs().year() - 1, 10);
  const [types] = await pool.query('SELECT * FROM leave_types WHERE tenant_id = ? AND active = 1', [req.user.tenant_id]);
  const [emps] = await pool.query(`SELECT * FROM employees WHERE tenant_id = ? AND deleted_at IS NULL AND status IN ('active','on_probation','on_notice')`, [req.user.tenant_id]);
  let moved = 0;
  let lapsed = 0;
  for (const emp of emps) {
    for (const t of types) {
      if (t.max_carry_forward <= 0) continue;
      const balances = await getBalances(req.user.tenant_id, emp, year);
      const b = balances.find((x) => x.leaveTypeId === t.id);
      if (!b) continue;
      const carry = Math.min(Math.max(0, b.available), Number(t.max_carry_forward));
      await pool.query(
        `INSERT INTO leave_balances (tenant_id, employee_id, leave_type_id, year, opening, carry_forwarded, lapsed)
         VALUES (?,?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE carry_forwarded = VALUES(carry_forwarded), lapsed = VALUES(lapsed)`,
        [req.user.tenant_id, emp.id, t.id, year + 1, 0, carry, Math.max(0, Math.round((b.available - carry) * 100) / 100)]
      );
      if (carry > 0) moved += carry;
      if (b.available - carry > 0) lapsed += b.available - carry;
    }
  }
  await logAudit({ tenantId: req.user.tenant_id, actor: req.user, action: 'leave.carry_forward', entityType: 'leave_balances', entityId: `${year}->${year + 1}`, after: { moved, lapsed }, req });
  res.json({ ok: true, carriedForward: Math.round(moved * 100) / 100, lapsed: Math.round(lapsed * 100) / 100, year: year + 1 });
}));

module.exports = r;
