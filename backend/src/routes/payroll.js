const express = require('express');
const dayjs = require('dayjs');
const { pool } = require('../config/db');
const { asyncH, HttpError, monthRange, fyLabel } = require('../utils/helpers');
const { authenticate, requirePermission } = require('../middleware/auth');
const { calculateRun, transitionRun, bankFile } = require('../services/payroll');
const { logAudit } = require('../services/audit');
const { decrypt } = require('../utils/crypto');
const { toCsv } = require('../utils/csv');
const { validateFormula } = require('../utils/exprEval');
const { crudRouter } = require('./_crud');

const r = express.Router();
r.use(authenticate);

// ---------- Runs ----------
r.get('/runs', requirePermission('payroll.view'), asyncH(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT pr.*, u1.name AS calculated_by_name, u2.name AS approved_by_name
     FROM payroll_runs pr
     LEFT JOIN users u1 ON u1.id = pr.calculated_by
     LEFT JOIN users u2 ON u2.id = pr.approved_by
     WHERE pr.tenant_id = ? ORDER BY pr.period_year DESC, pr.period_month DESC LIMIT 60`,
    [req.user.tenant_id]
  );
  res.json({ data: rows.map((x) => ({ ...x, totals: typeof x.totals === 'string' ? JSON.parse(x.totals || '{}') : x.totals, exceptions: typeof x.exceptions === 'string' ? JSON.parse(x.exceptions || '[]') : x.exceptions })) });
}));

r.post('/runs', requirePermission('payroll.calculate'), asyncH(async (req, res) => {
  const { year, month, payDate, monthDays } = req.body || {};
  const y = parseInt(year || dayjs().year(), 10);
  const m = parseInt(month || dayjs().month() + 1, 10);
  const [dupe] = await pool.query('SELECT id FROM payroll_runs WHERE tenant_id = ? AND period_year = ? AND period_month = ?', [req.user.tenant_id, y, m]);
  if (dupe[0]) throw new HttpError(409, 'A payroll run already exists for this period');
  const { daysInMonth } = monthRange(y, m);
  const [ins] = await pool.query(
    `INSERT INTO payroll_runs (tenant_id, period_year, period_month, pay_date, month_days) VALUES (?,?,?,?,?)`,
    [req.user.tenant_id, y, m, payDate || null, monthDays || daysInMonth]
  );
  await logAudit({ tenantId: req.user.tenant_id, actor: req.user, action: 'payroll.create_run', entityType: 'payroll_run', entityId: ins.insertId, after: { y, m }, req });
  res.status(201).json({ data: { id: ins.insertId } });
}));

r.get('/runs/:id', requirePermission('payroll.view'), asyncH(async (req, res) => {
  const [runs] = await pool.query('SELECT * FROM payroll_runs WHERE id = ? AND tenant_id = ?', [req.params.id, req.user.tenant_id]);
  if (!runs[0]) throw new HttpError(404, 'Run not found');
  const run = runs[0];
  const [items] = await pool.query(
    `SELECT pi.*, e.employee_code, e.first_name, e.last_name, e.tax_regime, d.name AS department_name
     FROM payroll_items pi JOIN employees e ON e.id = pi.employee_id
     LEFT JOIN departments d ON d.id = e.department_id
     WHERE pi.run_id = ? ORDER BY e.employee_code`,
    [req.params.id]
  );
  res.json({
    data: {
      ...run,
      totals: typeof run.totals === 'string' ? JSON.parse(run.totals || '{}') : run.totals,
      exceptions: typeof run.exceptions === 'string' ? JSON.parse(run.exceptions || '[]') : run.exceptions,
    },
    items: items.map((it) => ({
      ...it,
      earnings: typeof it.earnings === 'string' ? JSON.parse(it.earnings || '[]') : it.earnings,
      deductions: typeof it.deductions === 'string' ? JSON.parse(it.deductions || '[]') : it.deductions,
      employer_contrib: typeof it.employer_contrib === 'string' ? JSON.parse(it.employer_contrib || '[]') : it.employer_contrib,
    })),
  });
}));

r.post('/runs/:id/calculate', requirePermission('payroll.calculate'), asyncH(async (req, res) => {
  const result = await calculateRun(req.user.tenant_id, req.params.id, req.user);
  res.json({ ok: true, ...result });
}));

r.post('/runs/:id/:action(submit|approve|lock|pay|cancel)', asyncH(async (req, res, next) => {
  const permMap = { submit: 'payroll.submit', approve: 'payroll.approve', lock: 'payroll.lock', pay: 'payroll.pay', cancel: 'payroll.calculate' };
  const needed = permMap[req.params.action];
  if (req.user.role !== 'platform_super_admin' && !(req.user.permissions.includes(needed) || req.user.permissions.includes(needed.split('.')[0]))) {
    throw new HttpError(403, `Missing permission: ${needed}`);
  }
  const result = await transitionRun(req.user.tenant_id, req.params.id, req.params.action, req.user);
  res.json({ ok: true, ...result });
}));

r.get('/runs/:id/bank-file', requirePermission('payroll.view_sensitive'), asyncH(async (req, res) => {
  const [runs] = await pool.query('SELECT * FROM payroll_runs WHERE id = ? AND tenant_id = ?', [req.params.id, req.user.tenant_id]);
  if (!runs[0] || !['locked', 'paid'].includes(runs[0].status)) throw new HttpError(400, 'Bank file available after lock');
  const rows = await bankFile(req.user.tenant_id, req.params.id);
  const [empRows] = await pool.query(
    `SELECT e.employee_code, e.bank_account_enc, e.ifsc FROM payroll_items pi JOIN employees e ON e.id = pi.employee_id WHERE pi.run_id = ?`,
    [req.params.id]
  );
  const acctByCode = Object.fromEntries(empRows.map((e) => [e.employee_code, decrypt(e.bank_account_enc) || '']));
  const csv = toCsv(rows.map((x) => ({ ...x, account: acctByCode[x.employeeCode] || '' })), [
    { key: 'employeeCode', header: 'employee_code' }, { key: 'name', header: 'beneficiary_name' },
    { key: 'ifsc', header: 'ifsc' }, { key: 'account', header: 'account_number' }, { key: 'amount', header: 'amount' },
  ]);
  await logAudit({ tenantId: req.user.tenant_id, actor: req.user, action: 'payroll.bank_file_export', entityType: 'payroll_run', entityId: req.params.id, req });
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename=bank-file-${runs[0].period_year}${String(runs[0].period_month).padStart(2, '0')}.csv`);
  res.send(csv);
}));

// ---------- Payslips ----------
r.get('/payslips', authenticate, asyncH(async (req, res) => {
  const mine = req.query.mine === '1' || !req.user.permissions.includes('payroll.view');
  const params = [req.user.tenant_id];
  let where = 'ps.tenant_id = ?';
  if (mine) { where += ' AND ps.employee_id = ?'; params.push(req.user.employee_id); }
  else if (req.query.employee_id) { where += ' AND ps.employee_id = ?'; params.push(req.query.employee_id); }
  const [rows] = await pool.query(
    `SELECT ps.id, ps.employee_id, ps.pdf_path, ps.published_at, pr.period_month, pr.period_year, pr.status, pr.pay_date,
            pi.net_pay, pi.gross, pi.total_deductions,
            e.employee_code, e.first_name, e.last_name
     FROM payslips ps
     JOIN payroll_runs pr ON pr.id = ps.run_id
     JOIN payroll_items pi ON pi.id = ps.payroll_item_id
     JOIN employees e ON e.id = ps.employee_id
     WHERE ${where} ORDER BY pr.period_year DESC, pr.period_month DESC LIMIT 120`,
    params
  );
  res.json({ data: rows });
}));

// ---------- Salary structures ----------
r.use('/structures', crudRouter({
  table: 'salary_structures', perm: 'payroll.configure',
  fields: ['name', 'description', 'active'], required: ['name'], searchable: ['name'], boolFields: ['active'],
}));

r.get('/structures/:id/items', requirePermission('payroll.view'), asyncH(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT ssi.*, sc.name AS component_name, sc.code AS component_code, sc.ctype
     FROM salary_structure_items ssi JOIN salary_components sc ON sc.id = ssi.component_id
     JOIN salary_structures ss ON ss.id = ssi.structure_id
     WHERE ssi.structure_id = ? AND ss.tenant_id = ?`,
    [req.params.id, req.user.tenant_id]
  );
  res.json({ data: rows });
}));

r.post('/structures/:id/items', requirePermission('payroll.configure'), asyncH(async (req, res) => {
  const { componentId, amount, formula } = req.body || {};
  if (!componentId) throw new HttpError(400, 'componentId required');
  if (formula) {
    const v = validateFormula(formula);
    if (!v.ok) throw new HttpError(400, `Invalid formula: ${v.error}`);
  }
  await pool.query(
    `INSERT INTO salary_structure_items (structure_id, component_id, amount, formula) VALUES (?,?,?,?)
     ON DUPLICATE KEY UPDATE amount = VALUES(amount), formula = VALUES(formula)`,
    [req.params.id, componentId, amount ?? null, formula || null]
  );
  res.status(201).json({ ok: true });
}));

r.delete('/structures/:id/items/:itemId', requirePermission('payroll.configure'), asyncH(async (req, res) => {
  await pool.query('DELETE ssi FROM salary_structure_items ssi JOIN salary_structures ss ON ss.id = ssi.structure_id WHERE ssi.id = ? AND ss.tenant_id = ?', [req.params.itemId, req.user.tenant_id]);
  res.json({ ok: true });
}));

// ---------- Salary components ----------
r.use('/components', crudRouter({
  table: 'salary_components', perm: 'payroll.configure',
  fields: ['name', 'code', 'ctype', 'calc_type', 'formula', 'taxable', 'prorated', 'part_of_gross', 'is_statutory_code', 'display_order', 'active'],
  required: ['name', 'code', 'ctype'], searchable: ['name', 'code'],
  numericFields: ['display_order'], boolFields: ['taxable', 'prorated', 'part_of_gross', 'active'],
}));

// ---------- Employee salaries (effective-dated revisions) ----------
r.get('/employee-salaries/:employeeId', requirePermission('payroll.view'), asyncH(async (req, res) => {
  const [rows] = await pool.query(
    'SELECT * FROM employee_salaries WHERE tenant_id = ? AND employee_id = ? ORDER BY effective_from DESC',
    [req.user.tenant_id, req.params.employeeId]
  );
  res.json({ data: rows.map((x) => ({ ...x, items: typeof x.items === 'string' ? JSON.parse(x.items || '[]') : x.items })) });
}));

r.post('/employee-salaries', requirePermission('payroll.configure'), asyncH(async (req, res) => {
  const { employeeId, effectiveFrom, ctcAnnual, structureId, revisionReason } = req.body || {};
  const items = req.body.items;
  if (!employeeId || !effectiveFrom || !Array.isArray(items) || !items.length) {
    throw new HttpError(400, 'employeeId, effectiveFrom and items[] required');
  }
  const grossMonthly = items.filter((i) => i.type === 'earning' && i.partOfGross !== false).reduce((s, i) => s + (Number(i.amount) || 0), 0);
  const [dupe] = await pool.query('SELECT id FROM employee_salaries WHERE tenant_id = ? AND employee_id = ? AND effective_from = ?', [req.user.tenant_id, employeeId, effectiveFrom]);
  if (dupe[0]) throw new HttpError(409, 'A salary record already exists with this effective date');
  const [ins] = await pool.query(
    `INSERT INTO employee_salaries (tenant_id, employee_id, structure_id, ctc_annual, gross_monthly, items, effective_from, revision_reason, created_by)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [req.user.tenant_id, employeeId, structureId || null, ctcAnnual || round(grossMonthly * 12), round(grossMonthly), JSON.stringify(items), effectiveFrom, revisionReason || null, req.user.id]
  );
  // close previous open-ended record
  await pool.query(
    `UPDATE employee_salaries SET effective_to = DATE_SUB(?, INTERVAL 1 DAY)
     WHERE tenant_id = ? AND employee_id = ? AND id != ? AND effective_to IS NULL AND effective_from < ?`,
    [effectiveFrom, req.user.tenant_id, employeeId, ins.insertId, effectiveFrom]
  );
  await pool.query(
    `INSERT INTO employee_timeline (tenant_id, employee_id, event_type, title, event_date, details, created_by)
     VALUES (?,?,?,?,?,?,?)`,
    [req.user.tenant_id, employeeId, 'salary_revision', `Salary revised to ₹${round(grossMonthly).toLocaleString('en-IN')}/month`, effectiveFrom, JSON.stringify({ grossMonthly }), req.user.id]
  );
  await logAudit({ tenantId: req.user.tenant_id, actor: req.user, action: 'payroll.salary_revision', entityType: 'employee_salary', entityId: ins.insertId, after: { employeeId, effectiveFrom, grossMonthly }, req });
  res.status(201).json({ data: { id: ins.insertId } });
}));

const round = (n) => Math.round((Number(n) || 0) * 100) / 100;

// ---------- Statutory rules ----------
r.get('/statutory', requirePermission('payroll.view'), asyncH(async (req, res) => {
  const [rows] = await pool.query(
    'SELECT * FROM statutory_rules WHERE tenant_id = ? ORDER BY rule_type, effective_from DESC',
    [req.user.tenant_id]
  );
  res.json({ data: rows.map((x) => ({ ...x, params: typeof x.params === 'string' ? JSON.parse(x.params || '{}') : x.params })) });
}));

r.post('/statutory', requirePermission('statutory.manage'), asyncH(async (req, res) => {
  const { ruleType, jurisdiction, effectiveFrom, version, params, notes } = req.body || {};
  if (!ruleType || !effectiveFrom || !version || !params) throw new HttpError(400, 'ruleType, effectiveFrom, version, params required');
  const [ins] = await pool.query(
    `INSERT INTO statutory_rules (tenant_id, rule_type, jurisdiction, effective_from, effective_to, version, params, notes, created_by)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [req.user.tenant_id, ruleType, jurisdiction || 'IN', effectiveFrom, req.body.effectiveTo || null, version, JSON.stringify(params), notes || null, req.user.id]
  );
  await logAudit({ tenantId: req.user.tenant_id, actor: req.user, action: 'statutory.create', entityType: 'statutory_rule', entityId: ins.insertId, after: { ruleType, version, effectiveFrom }, req });
  res.status(201).json({ data: { id: ins.insertId } });
}));

r.put('/statutory/:id/close', requirePermission('statutory.manage'), asyncH(async (req, res) => {
  const { effectiveTo } = req.body || {};
  if (!effectiveTo) throw new HttpError(400, 'effectiveTo required');
  await pool.query('UPDATE statutory_rules SET effective_to = ? WHERE id = ? AND tenant_id = ?', [effectiveTo, req.params.id, req.user.tenant_id]);
  res.json({ ok: true });
}));

// ---------- Tax declarations ----------
r.get('/tax/declarations', authenticate, asyncH(async (req, res) => {
  const fy = req.query.fy || fyLabel();
  const params = [req.user.tenant_id, fy];
  let where = 'tenant_id = ? AND financial_year = ?';
  if (!req.user.permissions.includes('tax.view')) {
    where += ' AND employee_id = ?';
    params.push(req.user.employee_id);
  } else if (req.query.employee_id) {
    where += ' AND employee_id = ?';
    params.push(req.query.employee_id);
  }
  const [rows] = await pool.query(`SELECT * FROM tax_declarations WHERE ${where}`, params);
  res.json({ data: rows.map((x) => ({ ...x, sections: typeof x.sections === 'string' ? JSON.parse(x.sections || '{}') : x.sections })) });
}));

r.post('/tax/declarations', authenticate, asyncH(async (req, res) => {
  const { financialYear, regime, sections } = req.body || {};
  if (!financialYear) throw new HttpError(400, 'financialYear required');
  const employeeId = req.user.employee_id;
  if (!employeeId) throw new HttpError(400, 'No employee profile linked');
  await pool.query(
    `INSERT INTO tax_declarations (tenant_id, employee_id, financial_year, regime, sections, status, submitted_at)
     VALUES (?,?,?,?,?, 'submitted', NOW())
     ON DUPLICATE KEY UPDATE regime = VALUES(regime), sections = VALUES(sections), status = 'submitted', submitted_at = NOW()`,
    [req.user.tenant_id, employeeId, financialYear, regime || 'new', JSON.stringify(sections || {})]
  );
  await logAudit({ tenantId: req.user.tenant_id, actor: req.user, action: 'tax.declaration_submit', entityType: 'tax_declaration', entityId: employeeId, after: { financialYear, regime }, req });
  res.status(201).json({ ok: true });
}));

r.post('/tax/declarations/:id/review', requirePermission('tax.manage'), asyncH(async (req, res) => {
  const { status, comment } = req.body || {};
  if (!['under_review', 'approved', 'rejected'].includes(status)) throw new HttpError(400, 'Invalid status');
  await pool.query('UPDATE tax_declarations SET status = ?, reviewer_id = ?, review_comment = ? WHERE id = ? AND tenant_id = ?', [status, req.user.id, comment || null, req.params.id, req.user.tenant_id]);
  res.json({ ok: true });
}));

module.exports = r;
