const express = require('express');
const dayjs = require('dayjs');
const { pool } = require('../config/db');
const { asyncH, HttpError, round2 } = require('../utils/helpers');
const { authenticate, requirePermission, scopeFor, departmentRowCondition } = require('../middleware/auth');
const { logAudit } = require('../services/audit');
const { notifyEvent } = require('../services/notify');
const { upload, relPath } = require('../middleware/upload');

const expenses = express.Router();
expenses.use(authenticate);

expenses.get('/', requirePermission('expense.view'), asyncH(async (req, res) => {
  const params = [req.user.tenant_id];
  let where = 'ec.tenant_id = ?';
  const mine = req.query.mine === '1';
  const scope = scopeFor(req.user, 'expense.view');
  if (mine || scope === 'own') { where += ' AND ec.employee_id = ?'; params.push(req.user.employee_id); }
  else if (scope === 'team') { where += ' AND (ec.employee_id IN (SELECT id FROM employees WHERE manager_id = ?) OR ec.employee_id = ?)'; params.push(req.user.employee_id, req.user.employee_id); }
  else if (scope === 'department') { const cond = departmentRowCondition(req.user, 'ec.employee_id'); where += ` AND ${cond.sql}`; params.push(...cond.params); }
  if (req.query.status) { where += ' AND ec.status = ?'; params.push(req.query.status); }
  if (req.query.employee_id) { where += ' AND ec.employee_id = ?'; params.push(req.query.employee_id); }
  const [rows] = await pool.query(
    `SELECT ec.*, e.employee_code, e.first_name, e.last_name, c.name AS category_name
     FROM expense_claims ec JOIN employees e ON e.id = ec.employee_id
     JOIN expense_categories c ON c.id = ec.category_id
     WHERE ${where} ORDER BY ec.created_at DESC LIMIT 300`,
    params
  );
  res.json({ data: rows });
}));

expenses.post('/', requirePermission('expense.create'), upload('receipts'), asyncH(async (req, res) => {
  const { categoryId, title, expenseDate, amount, description } = req.body || {};
  if (!categoryId || !title || !expenseDate || !amount) throw new HttpError(400, 'category, title, date and amount required');
  const [cats] = await pool.query('SELECT * FROM expense_categories WHERE id = ? AND tenant_id = ?', [categoryId, req.user.tenant_id]);
  if (!cats[0]) throw new HttpError(404, 'Category not found');
  if (cats[0].receipt_required_above && Number(amount) > Number(cats[0].receipt_required_above) && !req.file) {
    throw new HttpError(400, `Receipt required above ₹${cats[0].receipt_required_above}`);
  }
  const [ins] = await pool.query(
    `INSERT INTO expense_claims (tenant_id, employee_id, category_id, title, expense_date, amount, description, receipt_path, status, submitted_at)
     VALUES (?,?,?,?,?,?,?,?,'submitted',NOW())`,
    [req.user.tenant_id, req.user.employee_id, categoryId, title, expenseDate, round2(amount), description || null, req.file ? relPath(req.file) : null]
  );
  // notify approver (manager or finance)
  const [mgr] = await pool.query('SELECT u.id, u.email FROM users u WHERE u.employee_id = (SELECT manager_id FROM employees WHERE id = ?)', [req.user.employee_id]);
  const [fin] = await pool.query(`SELECT u.id, u.email FROM users u WHERE u.tenant_id = ? AND u.role IN ('finance_admin','hr_admin') AND u.status = 'active'`, [req.user.tenant_id]);
  const recipients = [...(mgr[0] ? [mgr[0]] : []), ...fin].map((u) => ({ userId: u.id, email: u.email }));
  await notifyEvent({
    tenantId: req.user.tenant_id, eventKey: 'expense.actioned',
    vars: { title: 'Expense submitted for approval', body: `${req.user.name} submitted "${title}" (₹${amount})`, status: 'submitted', amount },
    recipients, link: '/expenses',
  });
  await logAudit({ tenantId: req.user.tenant_id, actor: req.user, action: 'expense.submit', entityType: 'expense_claim', entityId: ins.insertId, after: { title, amount }, req });
  res.status(201).json({ data: { id: ins.insertId } });
}));

expenses.post('/:id/action', requirePermission('expense.approve'), asyncH(async (req, res) => {
  const { action, comment } = req.body || {};
  const [rows] = await pool.query(
    `SELECT ec.*, e.email AS emp_email, e.manager_id, e.first_name FROM expense_claims ec JOIN employees e ON e.id = ec.employee_id
     WHERE ec.id = ? AND ec.tenant_id = ?`,
    [req.params.id, req.user.tenant_id]
  );
  const claim = rows[0];
  if (!claim) throw new HttpError(404, 'Claim not found');
  if (!['submitted'].includes(claim.status)) throw new HttpError(400, `Claim is ${claim.status}`);
  if (Number(claim.employee_id) === Number(req.user.employee_id)) throw new HttpError(403, 'Cannot approve your own claim');
  const claimScope = scopeFor(req.user, 'expense.view');
  if (claimScope === 'department') {
    const [d] = await pool.query('SELECT department_id FROM employees WHERE id = ?', [claim.employee_id]);
    const [mine] = await pool.query('SELECT id FROM departments WHERE head_employee_id = ? AND id = ?', [req.user.employee_id, d[0]?.department_id]);
    if (!mine[0]) throw new HttpError(403, 'Claim is outside your department');
  }
  const status = action === 'approve' ? 'approved' : 'rejected';
  await pool.query('UPDATE expense_claims SET status = ?, approver_id = ?, approver_comment = ?, actioned_at = NOW() WHERE id = ?', [status, req.user.id, comment || null, claim.id]);
  await notifyEvent({
    tenantId: req.user.tenant_id, eventKey: 'expense.actioned',
    vars: { status, title: claim.title, amount: claim.amount, comment: comment || '-' },
    recipients: [{ userId: null, email: claim.emp_email }], link: '/portal/expenses',
  });
  await logAudit({ tenantId: req.user.tenant_id, actor: req.user, action: `expense.${status}`, entityType: 'expense_claim', entityId: claim.id, before: { status: 'submitted' }, after: { status }, req });
  res.json({ ok: true });
}));

const loans = express.Router();
loans.use(authenticate);

loans.get('/', requirePermission('loan.view'), asyncH(async (req, res) => {
  const params = [req.user.tenant_id];
  let where = 'l.tenant_id = ?';
  if (!req.user.permissions.includes('loan.view:company')) { where += ' AND l.employee_id = ?'; params.push(req.user.employee_id); }
  else if (req.query.employee_id) { where += ' AND l.employee_id = ?'; params.push(req.query.employee_id); }
  const [rows] = await pool.query(
    `SELECT l.*, e.employee_code, e.first_name, e.last_name FROM loans l JOIN employees e ON e.id = l.employee_id
     WHERE ${where} ORDER BY l.created_at DESC LIMIT 200`,
    params
  );
  res.json({ data: rows });
}));

loans.post('/', requirePermission('loan.manage'), asyncH(async (req, res) => {
  const { employeeId, ltype, title, principal, tenureMonths, interestRate, startMonth, startYear, emiAmount, notes } = req.body || {};
  if (!employeeId || !principal || !tenureMonths || !startMonth || !startYear || !emiAmount) {
    throw new HttpError(400, 'employeeId, principal, tenureMonths, startMonth, startYear, emiAmount required');
  }
  if (Number(tenureMonths) * Number(emiAmount) < Number(principal) - 0.01) {
    throw new HttpError(400, 'Tenure × EMI must cover the principal');
  }
  const [ins] = await pool.query(
    `INSERT INTO loans (tenant_id, employee_id, ltype, title, principal, interest_rate, tenure_months, emi_amount, start_month, start_year, outstanding, status, notes, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,'pending',?,?)`,
    [req.user.tenant_id, employeeId, ltype || 'loan', title || null, round2(principal), interestRate || 0, tenureMonths, round2(emiAmount), startMonth, startYear, round2(principal), notes || null, req.user.id]
  );
  // generate installment schedule
  let m = Number(startMonth);
  let y = Number(startYear);
  for (let i = 1; i <= Number(tenureMonths); i++) {
    await pool.query(
      'INSERT INTO loan_installments (loan_id, tenant_id, installment_no, due_month, due_year, amount) VALUES (?,?,?,?,?,?)',
      [ins.insertId, req.user.tenant_id, i, m, y, round2(emiAmount)]
    );
    m++; if (m > 12) { m = 1; y++; }
  }
  await logAudit({ tenantId: req.user.tenant_id, actor: req.user, action: 'loan.create', entityType: 'loan', entityId: ins.insertId, after: { employeeId, principal, tenureMonths }, req });
  res.status(201).json({ data: { id: ins.insertId } });
}));

loans.post('/:id/approve', requirePermission('loan.manage'), asyncH(async (req, res) => {
  const { disburseOn } = req.body || {};
  await pool.query('UPDATE loans SET status = "active", disbursed_on = ? WHERE id = ? AND tenant_id = ? AND status = "pending"', [disburseOn || dayjs().format('YYYY-MM-DD'), req.params.id, req.user.tenant_id]);
  await logAudit({ tenantId: req.user.tenant_id, actor: req.user, action: 'loan.approve', entityType: 'loan', entityId: req.params.id, req });
  res.json({ ok: true });
}));

loans.post('/:id/:action(pause|resume|close)', requirePermission('loan.manage'), asyncH(async (req, res) => {
  const map = { pause: 'paused', resume: 'active', close: 'closed' };
  await pool.query('UPDATE loans SET status = ? WHERE id = ? AND tenant_id = ?', [map[req.params.action], req.params.id, req.user.tenant_id]);
  if (req.params.action === 'close') {
    await pool.query('UPDATE loan_installments SET status = "skipped" WHERE loan_id = ? AND status = "pending"', [req.params.id]);
  }
  await logAudit({ tenantId: req.user.tenant_id, actor: req.user, action: `loan.${req.params.action}`, entityType: 'loan', entityId: req.params.id, req });
  res.json({ ok: true });
}));

loans.get('/:id/schedule', requirePermission('loan.view'), asyncH(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT li.* FROM loan_installments li JOIN loans l ON l.id = li.loan_id WHERE li.loan_id = ? AND l.tenant_id = ? ORDER BY li.installment_no`,
    [req.params.id, req.user.tenant_id]
  );
  res.json({ data: rows });
}));

module.exports = { expenses, loans };
