const express = require('express');
const dayjs = require('dayjs');
const { pool } = require('../config/db');
const { asyncH } = require('../utils/helpers');
const { authenticate, employeeScopeCondition } = require('../middleware/auth');
const { logAudit } = require('../services/audit');
const { toCsv } = require('../utils/csv');

const r = express.Router();
r.use(authenticate);

// ---------- Admin/HR dashboard KPIs ----------
r.get('/', asyncH(async (req, res) => {
  const t = req.user.tenant_id;
  const scope = employeeScopeCondition(req.user, 'employee.view', 'e');

  const [[headcount]] = await pool.query(
    `SELECT COUNT(*) AS total,
       SUM(e.status IN ('active','on_probation')) AS active,
       SUM(e.status = 'on_notice') AS onNotice,
       SUM(YEAR(e.joined_on) = ? AND MONTH(e.joined_on) = ?) AS newJoiners,
       SUM(e.status = 'exited' AND YEAR(e.exit_date) = ? AND MONTH(e.exit_date) = ?) AS exits
     FROM employees e WHERE e.tenant_id = ? AND e.deleted_at IS NULL AND (${scope.sql})`,
    [dayjs().year(), dayjs().month() + 1, dayjs().year(), dayjs().month() + 1, t, ...scope.params]
  );

  const today = dayjs().format('YYYY-MM-DD');
  const [[attToday]] = await pool.query(
    `SELECT SUM(ar.status = 'present') AS present, SUM(ar.status = 'absent') AS absent,
            SUM(ar.status = 'on_leave') AS onLeave, SUM(ar.status = 'half_day') AS halfDay
     FROM attendance_records ar JOIN employees e ON e.id = ar.employee_id
     WHERE ar.tenant_id = ? AND ar.adate = ? AND (${scope.sql})`,
    [t, today, ...scope.params]
  );

  const [[approvals]] = await pool.query(
    `SELECT
       (SELECT COUNT(*) FROM leave_requests lr JOIN employees e ON e.id = lr.employee_id WHERE lr.tenant_id = ? AND lr.status = 'pending' AND (${scope.sql.replace(/e\./g, 'e.')})) AS leaves,
       (SELECT COUNT(*) FROM attendance_regularizations ar JOIN employees e ON e.id = ar.employee_id WHERE ar.tenant_id = ? AND ar.status = 'pending' AND (${scope.sql})) AS regularizations,
       (SELECT COUNT(*) FROM expense_claims ec JOIN employees e ON e.id = ec.employee_id WHERE ec.tenant_id = ? AND ec.status = 'submitted' AND (${scope.sql})) AS expenses,
       (SELECT COUNT(*) FROM tickets tk WHERE tk.tenant_id = ? AND tk.status IN ('open','reopened')) AS tickets`,
    [t, ...scope.params, t, ...scope.params, t, ...scope.params, t]
  );

  const [[payroll]] = await pool.query(
    `SELECT pr.status, pr.period_month, pr.period_year, pr.totals FROM payroll_runs pr
     WHERE pr.tenant_id = ? ORDER BY pr.period_year DESC, pr.period_month DESC LIMIT 1`, [t]
  );

  const [[billing]] = await pool.query(
    `SELECT COALESCE(SUM(total - amount_paid),0) AS outstanding FROM invoices WHERE tenant_id = ? AND status IN ('sent','part_paid','overdue')`, [t]
  );

  // headcount by department (top 8)
  const [byDept] = await pool.query(
    `SELECT d.name AS label, COUNT(*) AS n FROM employees e JOIN departments d ON d.id = e.department_id
     WHERE e.tenant_id = ? AND e.deleted_at IS NULL AND e.status IN ('active','on_probation','on_notice') AND (${scope.sql})
     GROUP BY d.name ORDER BY n DESC LIMIT 8`,
    [t, ...scope.params]
  );

  // headcount trend (joiners vs exits last 6 months)
  const [trend] = await pool.query(
    `SELECT DATE_FORMAT(joined_on, '%Y-%m') AS ym, COUNT(*) AS joiners FROM employees e
     WHERE e.tenant_id = ? AND e.deleted_at IS NULL AND (${scope.sql}) AND joined_on >= DATE_SUB(CURDATE(), INTERVAL 6 MONTH)
     GROUP BY ym`,
    [t, ...scope.params]
  );
  const [exitsTrend] = await pool.query(
    `SELECT DATE_FORMAT(exit_date, '%Y-%m') AS ym, COUNT(*) AS exits FROM employees e
     WHERE e.tenant_id = ? AND e.deleted_at IS NULL AND (${scope.sql}) AND exit_date IS NOT NULL AND exit_date >= DATE_SUB(CURDATE(), INTERVAL 6 MONTH)
     GROUP BY ym`,
    [t, ...scope.params]
  );

  // pending tasks: document expiries (next 30 days)
  const [expiringDocs] = await pool.query(
    `SELECT ed.id, ed.name, ed.expires_on, ed.employee_id, e.first_name, e.last_name, e.employee_code
     FROM employee_documents ed JOIN employees e ON e.id = ed.employee_id
     WHERE ed.tenant_id = ? AND ed.expires_on BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 30 DAY) ORDER BY ed.expires_on LIMIT 10`,
    [t]
  );

  // birthdays & anniversaries this month
  const [birthdays] = await pool.query(
    `SELECT id, first_name, last_name, dob FROM employees e
     WHERE e.tenant_id = ? AND e.deleted_at IS NULL AND e.status IN ('active','on_probation','on_notice')
       AND (${scope.sql}) AND MONTH(dob) = ? ORDER BY DAY(dob) LIMIT 8`,
    [t, ...scope.params, dayjs().month() + 1]
  );

  res.json({
    data: {
      headcount, attendanceToday: attToday, approvals,
      lastPayroll: payroll ? { period: `${payroll.period_month}/${payroll.period_year}`, status: payroll.status, totals: typeof payroll.totals === 'string' ? JSON.parse(payroll.totals || '{}') : payroll.totals } : null,
      invoiceOutstanding: billing.outstanding,
      byDept, trend: { joiners: trend, exits: exitsTrend }, expiringDocs, birthdays,
    },
  });
}));

// ---------- Announcements ----------
r.get('/announcements', asyncH(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT a.*, u.name AS author_name, d.name AS department_name FROM announcements a
     LEFT JOIN users u ON u.id = a.created_by LEFT JOIN departments d ON d.id = a.department_id
     WHERE a.tenant_id = ? AND (a.publish_from IS NULL OR a.publish_from <= CURDATE())
       AND (a.publish_to IS NULL OR a.publish_to >= CURDATE())
       AND (a.audience = 'all' OR a.department_id IS NULL OR a.department_id = (SELECT department_id FROM employees WHERE id = ?))
     ORDER BY a.pinned DESC, a.created_at DESC LIMIT 20`,
    [req.user.tenant_id, req.user.employee_id || 0]
  );
  res.json({ data: rows });
}));

module.exports = r;
