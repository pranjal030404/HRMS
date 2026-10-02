const express = require('express');
const dayjs = require('dayjs');
const { pool } = require('../config/db');
const { asyncH, HttpError, fyLabel } = require('../utils/helpers');
const { authenticate, requirePermission, scopeFor } = require('../middleware/auth');
const { getSetting, setSetting } = require('../services/settings');
const { logAudit } = require('../services/audit');
const statutory = require('../services/statutoryReturns');
const { round2 } = require('../utils/helpers');
const { toCsv } = require('../utils/csv');
const { ROLE_DEFS } = require('../utils/permissions');
const { invalidateRoleCache } = require('../middleware/auth');

const r = express.Router();
r.use(authenticate);

// ---------- Notifications (my) ----------
r.get('/my-notifications', asyncH(async (req, res) => {
  const [rows] = await pool.query(
    'SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50', [req.user.id]
  );
  const [[{ unread }]] = await pool.query('SELECT COUNT(*) AS unread FROM notifications WHERE user_id = ? AND read_at IS NULL', [req.user.id]);
  res.json({ data: rows, unread });
}));

r.post('/my-notifications/read', asyncH(async (req, res) => {
  if (req.body.id) await pool.query('UPDATE notifications SET read_at = NOW() WHERE id = ? AND user_id = ?', [req.body.id, req.user.id]);
  else await pool.query('UPDATE notifications SET read_at = NOW() WHERE user_id = ? AND read_at IS NULL', [req.user.id]);
  res.json({ ok: true });
}));

// ---------- Reports ----------
const REPORTS = {
  'employee-master': 'Employee master data',
  'headcount': 'Headcount by department & location',
  'attendance-daily': 'Daily attendance register',
  'attendance-monthly': 'Monthly attendance summary',
  'leave-ledger': 'Leave ledger & balances',
  'payroll-register': 'Payroll register',
  'payroll-variance': 'Payroll month-over-month variance',
  'statutory-summary': 'Statutory contributions summary',
  'statutory-pf-ecr': 'PF — ECR / Challan cum Return (ECR sheet)',
  'statutory-esi': 'ESI — Employee & Employer Contribution Return',
  'statutory-pt': 'Professional Tax — state-wise collection summary',
  'statutory-tds': 'TDS on Salary — deposits & annual reconciliation',
  'payroll-reconciliation': 'Bank reconciliation vs payroll net (by run)',
  'expense-register': 'Expense register',
  'loan-register': 'Loan & advance register',
  'invoice-register': 'Invoice register',
  'document-expiry': 'Document expiry tracker',
  'audit-log': 'Audit log',
};

r.get('/catalog', requirePermission('report.view'), asyncH(async (req, res) => {
  res.json({ data: Object.entries(REPORTS).map(([key, name]) => ({ key, name })) });
}));

r.get('/data', requirePermission('report.view'), asyncH(async (req, res) => {
  const t = req.user.tenant_id;
  const key = req.query.report;
  const from = req.query.from || dayjs().startOf('month').format('YYYY-MM-DD');
  const to = req.query.to || dayjs().format('YYYY-MM-DD');
  const year = parseInt(req.query.year || dayjs().year(), 10);
  const month = parseInt(req.query.month || dayjs().month() + 1, 10);
  let columns = [];
  let rows = [];

  switch (key) {
    case 'employee-master': {
      columns = ['employee_code', 'name', 'email', 'department', 'designation', 'location', 'status', 'joined_on'];
      [rows] = await pool.query(
        `SELECT e.employee_code, CONCAT(e.first_name,' ',e.last_name) AS name, e.email, d.name AS department,
                ds.name AS designation, l.name AS location, e.status, e.joined_on
         FROM employees e LEFT JOIN departments d ON d.id=e.department_id
         LEFT JOIN designations ds ON ds.id=e.designation_id LEFT JOIN locations l ON l.id=e.location_id
         WHERE e.tenant_id = ? AND e.deleted_at IS NULL ORDER BY e.employee_code`, [t]);
      break;
    }
    case 'headcount': {
      columns = ['department', 'location', 'active', 'on_probation', 'on_notice', 'exited'];
      [rows] = await pool.query(
        `SELECT IFNULL(d.name,'-') AS department, IFNULL(l.name,'-') AS location,
           SUM(e.status='active') AS active, SUM(e.status='on_probation') AS on_probation,
           SUM(e.status='on_notice') AS on_notice, SUM(e.status='exited') AS exited
         FROM employees e LEFT JOIN departments d ON d.id=e.department_id LEFT JOIN locations l ON l.id=e.location_id
         WHERE e.tenant_id = ? AND e.deleted_at IS NULL GROUP BY department, location ORDER BY active DESC`, [t]);
      break;
    }
    case 'attendance-daily': {
      columns = ['date', 'employee_code', 'name', 'status', 'first_in', 'last_out', 'worked_minutes', 'late_minutes'];
      [rows] = await pool.query(
        `SELECT ar.adate AS date, e.employee_code, CONCAT(e.first_name,' ',e.last_name) AS name, ar.status,
                ar.first_in, ar.last_out, ar.worked_minutes, ar.late_minutes
         FROM attendance_records ar JOIN employees e ON e.id=ar.employee_id
         WHERE ar.tenant_id = ? AND ar.adate BETWEEN ? AND ? ORDER BY ar.adate, e.employee_code`, [t, from, to]);
      break;
    }
    case 'attendance-monthly': {
      columns = ['employee_code', 'name', 'present', 'absent', 'half_day', 'on_leave', 'late_count'];
      [rows] = await pool.query(
        `SELECT e.employee_code, CONCAT(e.first_name,' ',e.last_name) AS name,
           SUM(ar.status='present') AS present, SUM(ar.status='absent') AS absent,
           SUM(ar.status='half_day') AS half_day, SUM(ar.status='on_leave') AS on_leave,
           SUM(ar.late_minutes > 0) AS late_count
         FROM attendance_records ar JOIN employees e ON e.id=ar.employee_id
         WHERE ar.tenant_id = ? AND YEAR(ar.adate) = ? AND MONTH(ar.adate) = ?
         GROUP BY e.id ORDER BY e.employee_code`, [t, year, month]);
      break;
    }
    case 'leave-ledger': {
      columns = ['employee_code', 'name', 'leave_type', 'opening', 'accrued', 'used', 'available'];
      [rows] = await pool.query(
        `SELECT e.employee_code, CONCAT(e.first_name,' ',e.last_name) AS name, lt.name AS leave_type,
                lb.opening, lb.accrued, lb.used,
                ROUND(lb.opening + lb.accrued + lb.carry_forwarded - lb.used - lb.lapsed - lb.encashed, 2) AS available
         FROM leave_balances lb JOIN employees e ON e.id=lb.employee_id JOIN leave_types lt ON lt.id=lb.leave_type_id
         WHERE lb.tenant_id = ? AND lb.year = ? ORDER BY e.employee_code`, [t, year]);
      break;
    }
    case 'payroll-register': {
      columns = ['employee_code', 'name', 'payable_days', 'lop_days', 'gross', 'deductions', 'net_pay'];
      [rows] = await pool.query(
        `SELECT e.employee_code, CONCAT(e.first_name,' ',e.last_name) AS name, pi.payable_days, pi.lop_days,
                pi.gross, pi.total_deductions AS deductions, pi.net_pay
         FROM payroll_items pi JOIN payroll_runs pr ON pr.id=pi.run_id JOIN employees e ON e.id=pi.employee_id
         WHERE pi.tenant_id = ? AND pr.period_year = ? AND pr.period_month = ?
           AND pr.status IN ('approved','locked','paid') ORDER BY e.employee_code`, [t, year, month]);
      break;
    }
    case 'payroll-variance': {
      columns = ['employee_code', 'name', 'this_month', 'last_month', 'change'];
      [rows] = await pool.query(
        `SELECT e.employee_code, CONCAT(e.first_name,' ',e.last_name) AS name,
                cur.net_pay AS this_month, prev.net_pay AS last_month,
                ROUND(cur.net_pay - COALESCE(prev.net_pay,0), 2) AS change
         FROM payroll_items cur
         JOIN payroll_runs prc ON prc.id = cur.run_id AND prc.period_year = ? AND prc.period_month = ?
         JOIN employees e ON e.id = cur.employee_id
         LEFT JOIN payroll_items prev ON prev.employee_id = cur.employee_id
         LEFT JOIN payroll_runs prp ON prp.id = prev.run_id AND prp.period_year = ? AND prp.period_month = ?
         WHERE cur.tenant_id = ? ORDER BY e.employee_code`,
        [year, month, month === 1 ? year - 1 : year, month === 1 ? 12 : month - 1, t]);
      break;
    }
    case 'statutory-summary': {
      columns = ['employee_code', 'name', 'pf_employee', 'esi', 'pt', 'tds', 'pf_employer'];
      [rows] = await pool.query(
        `SELECT e.employee_code, CONCAT(e.first_name,' ',e.last_name) AS name, pi.earnings, pi.deductions, pi.employer_contrib
         FROM payroll_items pi JOIN payroll_runs pr ON pr.id=pi.run_id JOIN employees e ON e.id=pi.employee_id
         WHERE pi.tenant_id = ? AND pr.period_year = ? AND pr.period_month = ? AND pr.status IN ('approved','locked','paid')`,
        [t, year, month]);
      const get = (arr, code) => (Array.isArray(arr) ? arr : JSON.parse(arr || '[]')).find((x) => x.code === code)?.amount || 0;
      rows = rows.map((x) => ({
        employee_code: x.employee_code, name: x.name,
        pf_employee: get(x.deductions, 'PF'), esi: get(x.deductions, 'ESI'), pt: get(x.deductions, 'PT'),
        tds: get(x.deductions, 'TDS'), pf_employer: get(x.employer_contrib, 'PF_ER'),
      }));
      break;
    }
    case 'expense-register': {
      columns = ['date', 'employee_code', 'name', 'title', 'category', 'amount', 'status'];
      [rows] = await pool.query(
        `SELECT ec.expense_date AS date, e.employee_code, CONCAT(e.first_name,' ',e.last_name) AS name, ec.title,
                c.name AS category, ec.amount, ec.status
         FROM expense_claims ec JOIN employees e ON e.id=ec.employee_id JOIN expense_categories c ON c.id=ec.category_id
         WHERE ec.tenant_id = ? AND ec.expense_date BETWEEN ? AND ? ORDER BY ec.expense_date DESC`, [t, from, to]);
      break;
    }
    case 'loan-register': {
      columns = ['employee_code', 'name', 'type', 'principal', 'emi', 'outstanding', 'status'];
      [rows] = await pool.query(
        `SELECT e.employee_code, CONCAT(e.first_name,' ',e.last_name) AS name, l.ltype AS type, l.principal,
                l.emi_amount AS emi, l.outstanding, l.status
         FROM loans l JOIN employees e ON e.id=l.employee_id WHERE l.tenant_id = ? ORDER BY l.created_at DESC`, [t]);
      break;
    }
    case 'invoice-register': {
      columns = ['invoice_no', 'date', 'customer', 'subtotal', 'cgst', 'sgst', 'igst', 'total', 'paid', 'status'];
      [rows] = await pool.query(
        `SELECT i.invoice_no, i.invoice_date AS date, c.name AS customer, i.subtotal, i.cgst, i.sgst, i.igst,
                i.total, i.amount_paid AS paid, i.status
         FROM invoices i JOIN customers c ON c.id=i.customer_id WHERE i.tenant_id = ? ORDER BY i.invoice_date DESC`, [t]);
      break;
    }
    case 'document-expiry': {
      columns = ['employee_code', 'name', 'document', 'expires_on', 'status'];
      [rows] = await pool.query(
        `SELECT e.employee_code, CONCAT(e.first_name,' ',e.last_name) AS name, ed.name AS document, ed.expires_on,
                CASE WHEN ed.expires_on < CURDATE() THEN 'expired' ELSE 'active' END AS status
         FROM employee_documents ed JOIN employees e ON e.id=ed.employee_id
         WHERE ed.tenant_id = ? AND ed.expires_on IS NOT NULL ORDER BY ed.expires_on`, [t]);
      break;
    }
    case 'audit-log': {
      if (!req.user.permissions.includes('audit.view')) throw new HttpError(403, 'Missing permission: audit.view');
      columns = ['time', 'actor', 'role', 'action', 'entity', 'entity_id', 'ip'];
      [rows] = await pool.query(
        `SELECT created_at AS time, actor_name AS actor, actor_role AS role, action, entity_type AS entity,
                entity_id, ip FROM audit_logs WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 2000`, [t]);
      break;
    }
    case 'statutory-pf-ecr':
    case 'statutory-esi':
    case 'statutory-pt':
    case 'statutory-tds': {
      if (!req.user.permissions.includes('payroll.view')) throw new HttpError(403, 'Missing permission: payroll.view');
      // Quarterly returns may be requested with fy + quarter; monthly ones fall back to year/month.
      const kind = key.replace('statutory-', '');
      const period = req.query.fy
        ? (() => { const [f, tt] = statutory.fyRange(req.query.fy, req.query.quarter); return { from: f, to: tt }; })()
        : { year, month };
      const out = await statutory.buildReturn(t, kind, period);
      if (kind === 'pt') {
        columns = ['state', 'employees', 'taxableGross', 'ptCollected'];
        rows = out.byState.map((s) => ({ state: s.state, employees: s.employees, taxableGross: s.taxableGross, ptCollected: s.ptCollected }));
      } else if (kind === 'tds') {
        columns = ['employee_code', 'name', 'pan', 'gross', 'tdsDeposit', 'annualDeposit', 'shortfall', 'variance', 'onTrack'];
        rows = out.deposits.map((d) => {
          const a = out.annual.find((x) => x.employeeId === d.employeeId) || {};
          return {
            employee_code: d.employeeCode, name: d.name, pan: d.pan || '-', gross: d.gross, tdsDeposit: d.tds,
            annualDeposit: a.deposited ?? 0, shortfall: a.shortfall ?? 0, variance: a.variance ?? 0, onTrack: a.onTrack ? 'yes' : 'no',
          };
        });
      } else if (kind === 'pf-ecr') {
        columns = ['employee_code', 'name', 'epfNumber', 'pfWages', 'epsContribution', 'edliContribution', 'epfContribution', 'totalRemittance'];
        rows = out.items.map((i) => ({
          employee_code: i.employeeCode, name: i.name, epfNumber: i.epfNumber || '-', pfWages: i.pfWages,
          epsContribution: i.epsContribution, edliContribution: i.edliContribution,
          epfContribution: i.epfContribution, totalRemittance: round2(i.epsContribution + i.edliContribution + i.epfContribution),
        }));
      } else {
        columns = ['ipNumber', 'employee_code', 'name', 'esicNumber', 'days', 'grossWages', 'esiEmployee', 'esiEmployer', 'totalRemittance'];
        rows = out.items.map((i) => ({
          ipNumber: i.ipNumber, employee_code: i.employeeCode, name: i.name, esicNumber: i.esicNumber || '-',
          days: i.days, grossWages: i.grossWages, esiEmployee: i.esiEmployee, esiEmployer: i.esiEmployer,
          totalRemittance: round2(i.esiEmployee + i.esiEmployer),
        }));
      }
      break;
    }
    case 'payroll-reconciliation': {
      if (!req.user.permissions.includes('payroll.view')) throw new HttpError(403, 'Missing permission: payroll.view');
      const runId = parseInt(req.query.runId || 0, 10);
      if (!runId) throw new HttpError(400, 'runId is required for the bank reconciliation report');
      const recon = await statutory.bankReconciliation(t, runId);
      if (!recon) throw new HttpError(404, 'Run not found');
      columns = ['employee_code', 'name', 'bankAccount', 'ifsc', 'netPay', 'status', 'flags'];
      rows = recon.items.map((i) => ({
        employee_code: i.employeeCode, name: i.name, bankAccount: i.bankAccount || '-', ifsc: i.ifsc || '-',
        netPay: i.netPay, status: i.status,
        flags: (recon.exceptions || []).filter((e) => e.employeeId === i.employeeId).map((e) => e.code).join('|') || '-',
      }));
      break;
    }
    default:
      throw new HttpError(400, `Unknown report: ${key}. Available: ${Object.keys(REPORTS).join(', ')}`);
  }

  if (req.query.format === 'csv') {
    if (!req.user.permissions.includes('report.export')) throw new HttpError(403, 'Missing permission: report.export');
    await logAudit({ tenantId: t, actor: req.user, action: 'report.export', entityType: 'report', entityId: key, req });
    const csv = toCsv(rows, columns.map((c) => ({ key: c, header: c.replace(/_/g, ' ').toUpperCase() })));
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=${key}-${dayjs().format('YYYYMMDD')}.csv`);
    return res.send(csv);
  }

  res.json({ data: rows, columns, report: key, name: REPORTS[key] || key });
}));

// ---------- Settings ----------
r.get('/settings/:key', requirePermission('settings.view'), asyncH(async (req, res) => {
  const defaultsMap = {
    company: {}, attendance: { autoAbsent: true, geoRequired: false }, leave: {},
    payroll: { monthDays: 30 }, notifications: {}, billing: { defaultGstRate: 18 },
    workflows: { leave: ['manager', 'hr'], expense: ['manager', 'finance'], regularization: ['manager'] },
  };
  const value = await getSetting(req.user.tenant_id, req.params.key, defaultsMap[req.params.key] || {});
  res.json({ data: value });
}));

r.put('/settings/:key', requirePermission('settings.manage'), asyncH(async (req, res) => {
  await setSetting(req.user.tenant_id, req.params.key, req.body || {});
  await logAudit({ tenantId: req.user.tenant_id, actor: req.user, action: `settings.update`, entityType: 'settings', entityId: req.params.key, after: req.body, req });
  res.json({ ok: true });
}));

// ---------- Company profile ----------
r.get('/company', requirePermission('settings.view'), asyncH(async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM companies WHERE tenant_id = ?', [req.user.tenant_id]);
  res.json({ data: rows[0] || null });
}));

r.put('/company', requirePermission('settings.manage'), asyncH(async (req, res) => {
  const fields = ['legal_name', 'trade_name', 'cin', 'pan', 'tan', 'gstin', 'address_line1', 'address_line2', 'city', 'state', 'state_code', 'pincode', 'contact_email', 'contact_phone', 'fiscal_year_start_month', 'timezone'];
  const data = {};
  for (const f of fields) if (req.body[f] !== undefined) data[f] = req.body[f];
  const [existing] = await pool.query('SELECT id FROM companies WHERE tenant_id = ?', [req.user.tenant_id]);
  if (existing[0]) {
    const sets = Object.keys(data).map((k) => `${k} = ?`);
    if (sets.length) await pool.query(`UPDATE companies SET ${sets.join(', ')} WHERE tenant_id = ?`, [...Object.values(data), req.user.tenant_id]);
  } else {
    await pool.query(`INSERT INTO companies (tenant_id, ${Object.keys(data).join(', ')}) VALUES (?, ${Object.keys(data).map(() => '?').join(', ')})`, [req.user.tenant_id, ...Object.values(data)]);
  }
  await logAudit({ tenantId: req.user.tenant_id, actor: req.user, action: 'company.update', entityType: 'company', after: data, req });
  res.json({ ok: true });
}));

// ---------- Branding ----------
r.put('/branding', requirePermission('settings.manage'), asyncH(async (req, res) => {
  const { logoUrl, primaryColor, companyName, supportEmail, loginTagline } = req.body || {};
  const branding = {};
  for (const [k, v] of Object.entries({ logoUrl, primaryColor, companyName, supportEmail, loginTagline })) if (v !== undefined) branding[k] = v;
  await pool.query('UPDATE tenants SET branding = ? WHERE id = ?', [JSON.stringify(branding), req.user.tenant_id]);
  await logAudit({ tenantId: req.user.tenant_id, actor: req.user, action: 'branding.update', entityType: 'tenant', entityId: req.user.tenant_id, after: branding, req });
  res.json({ ok: true });
}));

// ---------- Users & roles ----------
r.get('/users', requirePermission('user.manage'), asyncH(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT u.id, u.name, u.email, u.role, u.status, u.employee_id, u.last_login_at,
            e.employee_code FROM users u LEFT JOIN employees e ON e.id = u.employee_id
     WHERE u.tenant_id = ? ORDER BY u.id`, [req.user.tenant_id]
  );
  res.json({ data: rows });
}));

r.post('/users', requirePermission('user.manage'), asyncH(async (req, res) => {
  const { name, email, role, employeeId } = req.body || {};
  if (!name || !email || !role) throw new HttpError(400, 'name, email, role required');
  const bcrypt = require('bcryptjs');
  const tempPassword = `Av@${require('crypto').randomBytes(3).toString('hex')}`;
  const [ins] = await pool.query(
    `INSERT INTO users (tenant_id, employee_id, email, password_hash, name, role, status, must_change_password)
     VALUES (?,?,?,?,?,?,'active',1)`,
    [req.user.tenant_id, employeeId || null, String(email).toLowerCase(), await bcrypt.hash(tempPassword, 10), name, role]
  );
  await logAudit({ tenantId: req.user.tenant_id, actor: req.user, action: 'user.create', entityType: 'user', entityId: ins.insertId, after: { email, role }, req });
  res.status(201).json({ data: { id: ins.insertId }, tempPassword });
}));

r.put('/users/:id', requirePermission('user.manage'), asyncH(async (req, res) => {
  const { role, status, name } = req.body || {};
  const [before] = await pool.query('SELECT id, role, status FROM users WHERE id = ? AND tenant_id = ?', [req.params.id, req.user.tenant_id]);
  if (!before[0]) throw new HttpError(404, 'User not found');
  const sets = [];
  const params = [];
  if (role) { sets.push('role = ?'); params.push(role); }
  if (status) { sets.push('status = ?'); params.push(status); }
  if (name) { sets.push('name = ?'); params.push(name); }
  if (sets.length) {
    params.push(req.params.id);
    await pool.query(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, params);
  }
  await logAudit({ tenantId: req.user.tenant_id, actor: req.user, action: 'user.update', entityType: 'user', entityId: req.params.id, before: before[0], after: { role, status }, req });
  res.json({ ok: true });
}));

r.get('/roles', requirePermission('settings.view'), asyncH(async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM roles WHERE tenant_id = ? OR tenant_id IS NULL', [req.user.tenant_id]);
  res.json({ data: rows.map((x) => ({ ...x, permissions: typeof x.permissions === 'string' ? JSON.parse(x.permissions || '[]') : x.permissions })) });
}));

r.put('/roles/:id', requirePermission('role.manage'), asyncH(async (req, res) => {
  const { permissions, label } = req.body || {};
  if (!Array.isArray(permissions)) throw new HttpError(400, 'permissions[] required');
  await pool.query('UPDATE roles SET permissions = ?, label = COALESCE(?, label) WHERE id = ? AND tenant_id = ?', [JSON.stringify(permissions), label || null, req.params.id, req.user.tenant_id]);
  invalidateRoleCache();
  await logAudit({ tenantId: req.user.tenant_id, actor: req.user, action: 'role.update', entityType: 'role', entityId: req.params.id, after: { permissions: permissions.length }, req });
  res.json({ ok: true });
}));

// ---------- Audit ----------
r.get('/audit', requirePermission('audit.view'), asyncH(async (req, res) => {
  const params = [req.user.tenant_id];
  let where = 'tenant_id = ?';
  if (req.query.action) { where += ' AND action LIKE ?'; params.push(`%${req.query.action}%`); }
  if (req.query.actor) { where += ' AND actor_name LIKE ?'; params.push(`%${req.query.actor}%`); }
  const page = Math.max(1, parseInt(req.query.page || '1', 10));
  const [rows] = await pool.query(
    `SELECT SQL_CALC_FOUND_ROWS * FROM audit_logs WHERE ${where} ORDER BY created_at DESC LIMIT 50 OFFSET ?`,
    [...params, (page - 1) * 50]
  );
  const [[{ total }]] = await pool.query('SELECT FOUND_ROWS() AS total');
  res.json({ data: rows, meta: { total, page, pages: Math.ceil(total / 50) } });
}));

module.exports = r;
