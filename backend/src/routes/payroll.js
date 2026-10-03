const express = require('express');
const dayjs = require('dayjs');
const { pool } = require('../config/db');
const { asyncH, HttpError, monthRange, fyLabel, round2 } = require('../utils/helpers');
const { authenticate, requirePermission } = require('../middleware/auth');
const { calculateRun, transitionRun, bankFile, createAdjustment } = require('../services/payroll');
const { buildReturn, bankReconciliation, fyRange } = require('../services/statutoryReturns');
const { logAudit } = require('../services/audit');
const { notifyEvent } = require('../services/notify');
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

r.post('/runs', requirePermission('payroll.calculate'), asyncH(require('../services/limits').locked('payroll.run', async (req, res) => {
  const { year, month, periodYear, periodMonth, payDate, monthDays } = req.body || {};
  // Accept both spellings — responses expose period_year/period_month, so callers reasonably
  // send periodYear/periodMonth. Responses are left unchanged for frontend compatibility.
  const y = parseInt(year || periodYear || dayjs().year(), 10);
  const m = parseInt(month || periodMonth || dayjs().month() + 1, 10);
  if (!(y >= 2000 && y <= 2100) || !(m >= 1 && m <= 12)) throw new HttpError(400, 'Invalid payroll period');
  const [dupe] = await pool.query('SELECT id FROM payroll_runs WHERE tenant_id = ? AND period_year = ? AND period_month = ?', [req.user.tenant_id, y, m]);
  if (dupe[0]) throw new HttpError(409, 'A payroll run already exists for this period');
  const { daysInMonth } = monthRange(y, m);
  // Metered entitlement (spec §13, §14): a tenant that has run out of monthly
  // payroll runs is told so, and the counter is advanced only once the run exists
  // — a refused request must not consume allowance.
  const limits = require('../services/limits');
  await limits.assertWithinLimit({
    tenantId: req.user.tenant_id, entitlementKey: 'payroll_runs.month', incoming: 1,
    action: 'payroll.create_run', req,
  });
  const [ins] = await pool.query(
    `INSERT INTO payroll_runs (tenant_id, period_year, period_month, pay_date, month_days) VALUES (?,?,?,?,?)`,
    [req.user.tenant_id, y, m, payDate || null, monthDays || daysInMonth]
  );
  // Awaited, not fire-and-forget: payroll runs are low-volume and this is a
  // billing counter. A metered figure that lags its own write path is a figure
  // the platform console will under-report.
  await require('../services/usage').increment(req.user.tenant_id, 'payroll_runs.month', 1, {
    source: 'payroll_run', referenceType: 'payroll_run', referenceId: ins.insertId,
    actorUserId: req.user?.id, requestId: req.requestId, metadata: { year: y, month: m },
  }).catch((e) => console.error('[usage] payroll run metering failed:', e.message));
  await logAudit({ tenantId: req.user.tenant_id, actor: req.user, action: 'payroll.create_run', entityType: 'payroll_run', entityId: ins.insertId, after: { y, m }, req });
  res.status(201).json({ data: { id: ins.insertId } });
})));

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
  table: 'salary_structures', perm: 'payroll.configure', readPerm: 'payroll.view',
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
  table: 'salary_components', perm: 'payroll.configure', readPerm: 'payroll.view',
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
    [req.user.tenant_id, employeeId, structureId || null, ctcAnnual || round2(grossMonthly * 12), round2(grossMonthly), JSON.stringify(items), effectiveFrom, revisionReason || null, req.user.id]
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
    [req.user.tenant_id, employeeId, 'salary_revision', `Salary revised to ₹${round2(grossMonthly).toLocaleString('en-IN')}/month`, effectiveFrom, JSON.stringify({ grossMonthly }), req.user.id]
  );
  await logAudit({ tenantId: req.user.tenant_id, actor: req.user, action: 'payroll.salary_revision', entityType: 'employee_salary', entityId: ins.insertId, after: { employeeId, effectiveFrom, grossMonthly }, req });
  res.status(201).json({ data: { id: ins.insertId } });
}));


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

// ---------- Payroll adjustments (arrears, back-pay, corrections) ----------
// Locked and paid runs are immutable, so every post-lock correction is booked here and
// consumed automatically by the next calculation.

r.get('/adjustments', requirePermission('payroll.view'), asyncH(async (req, res) => {
  const params = [req.user.tenant_id];
  let where = 'a.tenant_id = ?';
  if (req.query.status) { where += ' AND a.status = ?'; params.push(req.query.status); }
  if (req.query.employee_id) { where += ' AND a.employee_id = ?'; params.push(req.query.employee_id); }
  if (req.query.atype) { where += ' AND a.atype = ?'; params.push(req.query.atype); }
  if (req.query.pending === '1') where += " AND a.status IN ('submitted','approved') AND a.applied_run_id IS NULL";

  const [rows] = await pool.query(
    `SELECT a.*, e.employee_code, CONCAT(e.first_name,' ',e.last_name) AS employee_name,
            d.name AS department,
            req.name AS requested_by_name, act.name AS actioned_by_name,
            pr.period_year AS original_period_year, pr.period_month AS original_period_month
     FROM payroll_adjustments a
     JOIN employees e ON e.id = a.employee_id
     LEFT JOIN departments d ON d.id = e.department_id
     LEFT JOIN users req ON req.id = a.requested_by
     LEFT JOIN users act ON act.id = a.actioned_by
     LEFT JOIN payroll_runs pr ON pr.id = a.original_run_id
     WHERE ${where}
     ORDER BY (a.status = 'applied') ASC, a.id DESC LIMIT 300`,
    params
  );

  const t = rows.reduce(
    (acc, x) => {
      acc.count += 1;
      if (x.direction === 'deduction') acc.deductions += Number(x.amount);
      else acc.earnings += Number(x.amount);
      if (x.status === 'submitted') acc.pendingApproval += 1;
      if (x.status === 'approved' && !x.applied_run_id) acc.queuedForNextRun += 1;
      if (x.status === 'applied') acc.applied += 1;
      return acc;
    },
    { count: 0, earnings: 0, deductions: 0, pendingApproval: 0, queuedForNextRun: 0, applied: 0 }
  );
  for (const k of ['earnings', 'deductions']) t[k] = round2(t[k]);

  if (req.query.format === 'csv') {
    const csv = toCsv(rows, [
      { key: 'employee_code', header: 'employee_code' }, { key: 'employee_name', header: 'employee_name' },
      { key: 'atype', header: 'type' }, { key: 'direction', header: 'direction' },
      { key: 'component', header: 'component' }, { key: 'description', header: 'description' },
      { key: 'amount', header: 'amount' }, { key: 'status', header: 'status' },
      { key: 'reason', header: 'reason' }, { key: 'applied_at', header: 'applied_at' },
    ]);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=payroll-adjustments-${dayjs().format('YYYYMMDD')}.csv`);
    return res.send(csv);
  }
  res.json({ data: rows, summary: t });
}));

r.get('/adjustments/:id', requirePermission('payroll.view'), asyncH(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT a.*, e.employee_code, CONCAT(e.first_name,' ',e.last_name) AS employee_name
     FROM payroll_adjustments a JOIN employees e ON e.id = a.employee_id
     WHERE a.id = ? AND a.tenant_id = ?`,
    [req.params.id, req.user.tenant_id]
  );
  if (!rows[0]) throw new HttpError(404, 'Adjustment not found');
  res.json({ data: rows[0] });
}));

r.post('/adjustments', requirePermission('payroll.adjust'), asyncH(async (req, res) => {
  const { employeeId, atype, direction, component, description, amount, forPeriodYear, forPeriodMonth,
    originalRunId, reason, submit } = req.body || {};
  if (!atype) throw new HttpError(400, 'atype required');
  // Referencing a run means "correct a closed period" — verify it is actually closed.
  if (originalRunId) {
    const [run] = await pool.query(
      'SELECT id, period_year, period_month, status FROM payroll_runs WHERE id = ? AND tenant_id = ?',
      [originalRunId, req.user.tenant_id]
    );
    if (!run[0]) throw new HttpError(404, 'Original payroll run not found');
    if (!['locked', 'paid'].includes(run[0].status)) {
      throw new HttpError(400, 'Corrections to a run are only meaningful once it is locked or paid — recalculate it instead');
    }
  }
  const result = await createAdjustment(req.user.tenant_id, req.user, {
    employeeId, atype, direction, component, description, amount,
    forPeriodYear: forPeriodYear ? parseInt(forPeriodYear, 10) : null,
    forPeriodMonth: forPeriodMonth ? parseInt(forPeriodMonth, 10) : null,
    originalRunId: originalRunId || null,
    reason: reason || null,
    submit: submit !== false,
  });
  res.status(201).json({ data: result });
}));

r.put('/adjustments/:id', requirePermission('payroll.adjust'), asyncH(async (req, res) => {
  const { component, description, amount, reason, forPeriodYear, forPeriodMonth } = req.body || {};
  const [rows] = await pool.query('SELECT * FROM payroll_adjustments WHERE id = ? AND tenant_id = ?', [req.params.id, req.user.tenant_id]);
  const a = rows[0];
  if (!a) throw new HttpError(404, 'Adjustment not found');
  if (!['draft', 'rejected'].includes(a.status)) {
    throw new HttpError(409, `Only draft or rejected adjustments can be edited (this one is ${a.status})`);
  }
  if (amount !== undefined && !(Number(amount) > 0)) throw new HttpError(400, 'amount must be greater than 0');
  await pool.query(
    `UPDATE payroll_adjustments SET component = COALESCE(?, component), description = COALESCE(?, description),
            amount = COALESCE(?, amount), reason = COALESCE(?, reason),
            for_period_year = COALESCE(?, for_period_year), for_period_month = COALESCE(?, for_period_month)
     WHERE id = ? AND tenant_id = ?`,
    [component || null, description || null, amount === undefined ? null : round2(Number(amount)),
      reason || null,
      forPeriodYear ? parseInt(forPeriodYear, 10) : null, forPeriodMonth ? parseInt(forPeriodMonth, 10) : null,
      req.params.id, req.user.tenant_id]
  );
  await logAudit({ tenantId: req.user.tenant_id, actor: req.user, action: 'payroll.adjustment_update', entityType: 'payroll_adjustment', entityId: req.params.id, before: a, after: req.body, req });
  res.json({ ok: true });
}));

r.post('/adjustments/:id/submit', requirePermission('payroll.adjust'), asyncH(async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM payroll_adjustments WHERE id = ? AND tenant_id = ?', [req.params.id, req.user.tenant_id]);
  const a = rows[0];
  if (!a) throw new HttpError(404, 'Adjustment not found');
  if (!['draft', 'rejected'].includes(a.status)) throw new HttpError(409, `Cannot submit from status ${a.status}`);
  await pool.query(
    `UPDATE payroll_adjustments SET status = 'submitted', requested_by = ?, requested_at = NOW(), actioned_comment = NULL WHERE id = ?`,
    [req.user.id, req.params.id]
  );
  // notify approvers
  const [byRole] = await pool.query(
    `SELECT u.id, u.email FROM users u WHERE u.tenant_id = ? AND u.status = 'active' AND u.role IN ('payroll_admin','company_owner')`,
    [req.user.tenant_id]
  );
  const recipients = byRole.filter((u) => u.id !== req.user.id);
  if (recipients.length) {
    await notifyEvent({
      tenantId: req.user.tenant_id, eventKey: 'payroll.adjustment_requested',
      vars: { title: 'Payroll adjustment awaiting approval', body: `${req.user.name} requested a ₹${a.amount} adjustment.` },
      recipients: recipients.map((u) => ({ userId: u.id, email: u.email })),
      link: '/payroll/adjustments',
    });
  }
  await logAudit({ tenantId: req.user.tenant_id, actor: req.user, action: 'payroll.adjustment_submit', entityType: 'payroll_adjustment', entityId: req.params.id, after: { status: 'submitted' }, req });
  res.json({ data: { id: a.id, status: 'submitted' } });
}));

r.post('/adjustments/:id/action', requirePermission('payroll.adjust_approve'), asyncH(async (req, res) => {
  const { action, comment } = req.body || {};
  if (!['approved', 'rejected'].includes(action)) throw new HttpError(400, 'action must be approved or rejected');
  const [rows] = await pool.query('SELECT * FROM payroll_adjustments WHERE id = ? AND tenant_id = ?', [req.params.id, req.user.tenant_id]);
  const a = rows[0];
  if (!a) throw new HttpError(404, 'Adjustment not found');
  if (a.status !== 'submitted') throw new HttpError(409, `Adjustment is ${a.status} — only submitted adjustments can be actioned`);
  if (Number(a.requested_by) === Number(req.user.id)) {
    throw new HttpError(403, 'Maker-checker: you cannot approve an adjustment you raised yourself');
  }
  await pool.query(
    `UPDATE payroll_adjustments SET status = ?, actioned_by = ?, actioned_at = NOW(), actioned_comment = ? WHERE id = ?`,
    [action, req.user.id, comment || null, req.params.id]
  );
  await logAudit({
    tenantId: req.user.tenant_id, actor: req.user, action: `payroll.adjustment_${action}`,
    entityType: 'payroll_adjustment', entityId: req.params.id,
    before: { status: a.status }, after: { status: action, comment: comment || null }, req,
  });
  if (action === 'rejected') {
    const [empUsers] = await pool.query('SELECT u.id FROM users u WHERE u.employee_id = ?', [a.employee_id]);
    if (empUsers.length) {
      await notifyEvent({
        tenantId: req.user.tenant_id, eventKey: 'payroll.adjustment_actioned',
        vars: { title: 'Payroll adjustment rejected', body: comment || `Your ₹${a.amount} adjustment was rejected.` },
        recipients: empUsers.map((u) => ({ userId: u.id })),
        link: '/portal/payslips',
      });
    }
  }
  res.json({ data: { id: a.id, status: action } });
}));

r.delete('/adjustments/:id', requirePermission('payroll.adjust'), asyncH(async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM payroll_adjustments WHERE id = ? AND tenant_id = ?', [req.params.id, req.user.tenant_id]);
  const a = rows[0];
  if (!a) throw new HttpError(404, 'Adjustment not found');
  if (a.status !== 'draft') throw new HttpError(409, 'Only draft adjustments can be deleted — reject it instead');
  await pool.query('DELETE FROM payroll_adjustments WHERE id = ? AND tenant_id = ?', [req.params.id, req.user.tenant_id]);
  await logAudit({ tenantId: req.user.tenant_id, actor: req.user, action: 'payroll.adjustment_delete', entityType: 'payroll_adjustment', entityId: req.params.id, before: a, req });
  res.json({ ok: true });
}));

// Adjustments consumed by a specific run (post-lock reconciliation trail).
r.get('/runs/:id/adjustments', requirePermission('payroll.view'), asyncH(async (req, res) => {
  const [run] = await pool.query('SELECT id FROM payroll_runs WHERE id = ? AND tenant_id = ?', [req.params.id, req.user.tenant_id]);
  if (!run[0]) throw new HttpError(404, 'Run not found');
  const [rows] = await pool.query(
    `SELECT a.*, e.employee_code, CONCAT(e.first_name,' ',e.last_name) AS employee_name
     FROM payroll_adjustments a JOIN employees e ON e.id = a.employee_id
     WHERE a.tenant_id = ? AND a.applied_run_id = ? ORDER BY a.id`,
    [req.user.tenant_id, req.params.id]
  );
  const [reimbursements] = await pool.query(
    `SELECT ec.id, ec.title, ec.amount, ec.expense_date, e.employee_code,
            CONCAT(e.first_name,' ',e.last_name) AS employee_name
     FROM expense_claims ec JOIN employees e ON e.id = ec.employee_id
     WHERE ec.reimbursed_run_id = ? AND ec.tenant_id = ? ORDER BY ec.id`,
    [req.params.id, req.user.tenant_id]
  );
  res.json({
    data: rows,
    reimbursements,
    totals: {
      adjustments: rows.length,
      earnings: round2(rows.filter((x) => x.direction !== 'deduction').reduce((s, x) => s + Number(x.amount), 0)),
      deductions: round2(rows.filter((x) => x.direction === 'deduction').reduce((s, x) => s + Number(x.amount), 0)),
      reimbursements: reimbursements.length,
      reimbursementAmount: round2(reimbursements.reduce((s, x) => s + Number(x.amount), 0)),
    },
  });
}));

// ---------- Statutory returns ----------
r.get('/returns/catalog', requirePermission('payroll.view'), asyncH(async (req, res) => {
  res.json({
    data: [
      { key: 'pf-ecr', name: 'PF ECR / Challan cum Return', frequency: 'monthly' },
      { key: 'esi', name: 'ESI Contribution Return', frequency: 'quarterly' },
      { key: 'pt', name: 'Professional Tax (state-wise)', frequency: 'monthly' },
      { key: 'tds', name: 'TDS on Salary & Annual Reconciliation', frequency: 'monthly / annual' },
    ],
  });
}));

r.get('/returns/:kind', requirePermission('payroll.view'), asyncH(async (req, res) => {
  const kind = req.params.kind;
  let period = {};
  if (req.query.fy || req.query.quarter) {
    const [from, to] = fyRange(req.query.fy || fyLabel().slice(0, 4), req.query.quarter);
    period = { from, to };
  } else {
    period = {
      year: req.query.year ? parseInt(req.query.year, 10) : null,
      month: req.query.month ? parseInt(req.query.month, 10) : null,
      from: req.query.from || null,
      to: req.query.to || null,
    };
  }
  let report;
  try {
    report = await buildReturn(req.user.tenant_id, kind, period);
  } catch (e) {
    throw new HttpError(400, e.message);
  }

  if (req.query.format === 'csv') {
    const rows = report.items || report.deposits || report.byState || [];
    const csv = toCsv(rows, Object.keys(rows[0] || { note: 'no data' }).map((k) => ({ key: k, header: k })));
    await logAudit({ tenantId: req.user.tenant_id, actor: req.user, action: 'payroll.statutory_return_export', entityType: 'statutory_return', entityId: kind, after: period, req });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=${kind}-${dayjs().format('YYYYMMDD')}.csv`);
    return res.send(csv);
  }
  await logAudit({ tenantId: req.user.tenant_id, actor: req.user, action: 'payroll.statutory_return_view', entityType: 'statutory_return', entityId: kind, after: period, req });
  res.json({ data: report });
}));

// ---------- Bank reconciliation ----------
r.get('/runs/:id/reconciliation', requirePermission('payroll.view'), asyncH(async (req, res) => {
  const report = await bankReconciliation(req.user.tenant_id, req.params.id);
  if (!report) throw new HttpError(404, 'Run not found');
  res.json({ data: report });
}));

module.exports = r;
