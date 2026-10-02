const express = require('express');
const { pool } = require('../config/db');
const { asyncH, HttpError } = require('../utils/helpers');
const { authenticate, requirePermission } = require('../middleware/auth');
const { logAudit } = require('../services/audit');
const { createAdjustment } = require('../services/payroll');
const { crudRouter } = require('./_crud');
const { emitEvent } = require('../services/webhooks');

const r = express.Router();
r.use(authenticate);

// ---- Salary bands ----
r.use('/bands', crudRouter({
  table: 'salary_bands', perm: 'compensation.manage',
  fields: ['name', 'grade_id', 'currency', 'min_amount', 'mid_amount', 'max_amount', 'effective_from', 'status'],
  required: ['name'], searchable: ['name'], numericFields: ['grade_id', 'min_amount', 'mid_amount', 'max_amount'],
}));

// ---- Compensation cycles ----
r.use('/cycles', crudRouter({
  table: 'comp_cycles', perm: 'compensation.manage',
  fields: ['name', 'cycle_year', 'effective_date', 'increment_budget_pct', 'status'],
  required: ['name', 'cycle_year'], searchable: ['name'], numericFields: ['cycle_year', 'increment_budget_pct'],
}));

// Init reviews for all active employees from their current salary
r.post('/cycles/:id/init', requirePermission('compensation.manage'), asyncH(async (req, res) => {
  const [cycles] = await pool.query('SELECT * FROM comp_cycles WHERE id = ? AND tenant_id = ?', [req.params.id, req.user.tenant_id]);
  if (!cycles[0]) throw new HttpError(404, 'Cycle not found');
  const [emps] = await pool.query(
    `SELECT e.id, es.ctc_annual FROM employees e
     LEFT JOIN employee_salaries es ON es.employee_id = e.id AND es.id = (SELECT MAX(id) FROM employee_salaries WHERE employee_id = e.id)
     WHERE e.tenant_id = ? AND e.status IN ('active','on_probation')`,
    [req.user.tenant_id]
  );
  let created = 0;
  for (const e of emps) {
    const [res] = await pool.query(
      `INSERT IGNORE INTO comp_reviews (tenant_id, cycle_id, employee_id, current_ctc) VALUES (?,?,?,?)`,
      [req.user.tenant_id, req.params.id, e.id, e.ctc_annual || 0]
    );
    created += res.affectedRows;
  }
  await logAudit({ tenantId: req.user.tenant_id, actor: req.user, action: 'comp_cycle.init', entityType: 'comp_cycle', entityId: req.params.id, after: { created }, req });
  res.json({ data: { created, total: emps.length } });
}));

r.get('/cycles/:id/reviews', requirePermission('compensation.view'), asyncH(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT cr.*, CONCAT(e.first_name, ' ', e.last_name) AS employee_name, e.employee_code,
            d.name AS department, des.name AS designation, g.name AS grade,
            des2.name AS proposed_designation, c.name AS cycle_name, c.status AS cycle_status
     FROM comp_reviews cr
     JOIN employees e ON e.id = cr.employee_id
     LEFT JOIN departments d ON d.id = e.department_id
     LEFT JOIN designations des ON des.id = e.designation_id
     LEFT JOIN grades g ON g.id = e.grade_id
     LEFT JOIN designations des2 ON des2.id = cr.new_designation_id
     JOIN comp_cycles c ON c.id = cr.cycle_id
     WHERE cr.cycle_id = ? AND cr.tenant_id = ?
     ORDER BY employee_name LIMIT 1000`,
    [req.params.id, req.user.tenant_id]
  );
  const totals = rows.reduce((acc, x) => {
    acc.totalCurrent += Number(x.current_ctc || 0);
    acc.totalNew += Number(x.new_ctc || x.current_ctc * (1 + x.proposed_increment_pct / 100) || 0);
    acc.totalBonus += Number(x.proposed_bonus || 0);
    acc.promotions += x.promotion_flag ? 1 : 0;
    return acc;
  }, { totalCurrent: 0, totalNew: 0, totalBonus: 0, promotions: 0 });
  res.json({ data: rows, totals });
}));

r.put('/reviews/:id', requirePermission('compensation.manage'), asyncH(async (req, res) => {
  const [before] = await pool.query('SELECT * FROM comp_reviews WHERE id = ? AND tenant_id = ?', [req.params.id, req.user.tenant_id]);
  if (!before[0]) throw new HttpError(404, 'Review not found');
  const allowed = ['proposed_increment_pct', 'proposed_bonus', 'promotion_flag', 'new_designation_id', 'justification', 'status'];
  const sets = [], params = [];
  for (const k of allowed) if (req.body[k] !== undefined) { sets.push(`${k} = ?`); params.push(k === 'promotion_flag' ? (req.body[k] ? 1 : 0) : req.body[k]); }
  if (req.body.proposed_increment_pct !== undefined) {
    const pct = Number(req.body.proposed_increment_pct);
    sets.push('new_ctc = ROUND(current_ctc * (1 + ? / 100))');
    params.push(pct);
  }
  if (req.body.status === 'approved' || req.body.status === 'rejected') {
    sets.push('decided_by = ?', 'decided_at = NOW()');
    params.push(req.user.id);
  }
  if (!sets.length) throw new HttpError(400, 'No fields to update');
  params.push(req.params.id, req.user.tenant_id);
  await pool.query(`UPDATE comp_reviews SET ${sets.join(', ')} WHERE id = ? AND tenant_id = ?`, params);
  await logAudit({ tenantId: req.user.tenant_id, actor: req.user, action: 'comp_review.update', entityType: 'comp_review', entityId: req.params.id, before: before[0], after: req.body, req });
  res.json({ ok: true });
}));

// Apply approved increments: create a new effective-dated salary revision
r.post('/cycles/:id/apply', requirePermission('compensation.manage'), asyncH(async (req, res) => {
  const { effectiveDate } = req.body || {};
  const [cycles] = await pool.query('SELECT * FROM comp_cycles WHERE id = ? AND tenant_id = ?', [req.params.id, req.user.tenant_id]);
  if (!cycles[0]) throw new HttpError(404, 'Cycle not found');
  if (cycles[0].status === 'closed') throw new HttpError(400, 'Cycle is closed');
  const [reviews] = await pool.query(
    `SELECT cr.*, es.structure_id, es.items, es.gross_monthly
     FROM comp_reviews cr
     LEFT JOIN employee_salaries es ON es.employee_id = cr.employee_id AND es.id = (SELECT MAX(id) FROM employee_salaries WHERE employee_id = cr.employee_id)
     WHERE cr.cycle_id = ? AND cr.tenant_id = ? AND cr.status = 'approved'`,
    [req.params.id, req.user.tenant_id]
  );
  let applied = 0;
  for (const cr of reviews) {
    const newCtc = Number(cr.new_ctc || 0) || Math.round(Number(cr.current_ctc || 0) * (1 + Number(cr.proposed_increment_pct || 0) / 100));
    if (!newCtc || newCtc <= Number(cr.current_ctc || 0)) continue;
    const grossMonthly = Math.round(newCtc / 12);
    let items = typeof cr.items === 'string' ? JSON.parse(cr.items) : (cr.items || []);
    if (items.length) {
      const oldGross = items.reduce((a, i) => a + (i.type === 'earning' ? Number(i.amount || 0) : 0), 0) || Number(cr.gross_monthly || 0);
      const factor = oldGross ? grossMonthly / oldGross : 1;
      items = items.map((i) => (i.type === 'earning' ? { ...i, amount: Math.round(Number(i.amount || 0) * factor) } : i));
    }
    await pool.query(
      `INSERT INTO employee_salaries (tenant_id, employee_id, structure_id, ctc_annual, gross_monthly, items, effective_from, created_by)
       VALUES (?,?,?,?,?,?,?,?)`,
      [req.user.tenant_id, cr.employee_id, cr.structure_id || null, newCtc, grossMonthly, JSON.stringify(items), effectiveDate || cycles[0].effective_date || null, req.user.id]
    );
    if (cr.promotion_flag && cr.new_designation_id) {
      await pool.query('UPDATE employees SET designation_id = ? WHERE id = ?', [cr.new_designation_id, cr.employee_id]);
    }
    await pool.query('UPDATE comp_reviews SET status = "applied" WHERE id = ?', [cr.id]);
    applied++;
  }
  await logAudit({ tenantId: req.user.tenant_id, actor: req.user, action: 'comp_cycle.apply', entityType: 'comp_cycle', entityId: req.params.id, after: { applied }, req });
  await emitEvent({ tenantId: req.user.tenant_id, eventType: 'compensation.applied', payload: { cycleId: Number(req.params.id), applied } });
  res.json({ data: { applied } });
}));

// ---- Bonus plans & awards ----
r.use('/bonus/plans', crudRouter({
  table: 'bonus_plans', perm: 'bonus.manage',
  fields: ['name', 'plan_year', 'btype', 'budget', 'status'],
  required: ['name', 'plan_year'], searchable: ['name'], numericFields: ['plan_year', 'budget'],
}));

r.get('/bonus/plans/:id/awards', requirePermission('bonus.view'), asyncH(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT ba.*, CONCAT(e.first_name, ' ', e.last_name) AS employee_name, e.employee_code, d.name AS department
     FROM bonus_awards ba JOIN employees e ON e.id = ba.employee_id
     LEFT JOIN departments d ON d.id = e.department_id
     WHERE ba.plan_id = ? AND ba.tenant_id = ? ORDER BY employee_name`,
    [req.params.id, req.user.tenant_id]
  );
  const [[{ total }]] = await pool.query('SELECT COALESCE(SUM(amount),0) AS total FROM bonus_awards WHERE plan_id = ? AND tenant_id = ?', [req.params.id, req.user.tenant_id]);
  res.json({ data: rows, total });
}));

r.post('/bonus/plans/:id/awards', requirePermission('bonus.manage'), asyncH(async (req, res) => {
  const { employeeId, amount, pctOfCtc, reason } = req.body || {};
  if (!employeeId) throw new HttpError(400, 'employeeId required');
  await pool.query(
    `INSERT INTO bonus_awards (tenant_id, plan_id, employee_id, amount, pct_of_ctc, reason) VALUES (?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE amount = VALUES(amount), pct_of_ctc = VALUES(pct_of_ctc), reason = VALUES(reason)`,
    [req.user.tenant_id, req.params.id, employeeId, amount || 0, pctOfCtc || 0, reason || null]
  );
  res.status(201).json({ ok: true });
}));

r.get('/bonus/awards', requirePermission('bonus.view'), asyncH(async (req, res) => {
  const where = ['ba.tenant_id = ?'];
  const args = [req.user.tenant_id];
  if (req.query.planId) { where.push('ba.plan_id = ?'); args.push(req.query.planId); }
  if (req.query.status) { where.push('ba.status = ?'); args.push(req.query.status); }
  if (req.query.employeeId) { where.push('ba.employee_id = ?'); args.push(req.query.employeeId); }
  const [rows] = await pool.query(
    `SELECT ba.*, bp.name AS plan_name, bp.plan_year,
            CONCAT(e.first_name, ' ', e.last_name) AS employee_name, e.employee_code, d.name AS department
     FROM bonus_awards ba
     JOIN bonus_plans bp ON bp.id = ba.plan_id
     JOIN employees e ON e.id = ba.employee_id
     LEFT JOIN departments d ON d.id = e.department_id
     WHERE ${where.join(' AND ')} ORDER BY ba.id DESC`,
    args
  );
  const [[{ total }]] = await pool.query(
    `SELECT COALESCE(SUM(amount),0) AS total FROM bonus_awards ba WHERE ${where.join(' AND ')}`,
    args
  );
  res.json({ data: rows, total });
}));

r.put('/bonus/awards/:id/status', requirePermission('bonus.manage'), asyncH(async (req, res) => {
  const { status } = req.body || {};
  if (!['proposed', 'approved', 'paid'].includes(status)) throw new HttpError(400, 'Invalid status');

  const [rows] = await pool.query(
    `SELECT ba.*, bp.plan_year, bp.btype, bp.name AS plan_name,
            e.employee_code, CONCAT(e.first_name,' ',e.last_name) AS employee_name
     FROM bonus_awards ba
     JOIN bonus_plans bp ON bp.id = ba.plan_id
     JOIN employees e ON e.id = ba.employee_id
     WHERE ba.id = ? AND ba.tenant_id = ?`,
    [req.params.id, req.user.tenant_id]
  );
  const award = rows[0];
  if (!award) throw new HttpError(404, 'Bonus award not found');
  if (award.status === status) throw new HttpError(409, `Award is already ${status}`);
  if (award.status === 'paid' && status !== 'paid') {
    throw new HttpError(409, 'A paid bonus award cannot be reopened — post a payroll adjustment instead');
  }
  if (status === 'proposed' && award.status === 'approved') {
    throw new HttpError(409, 'Cannot un-approve an award once a payroll adjustment has been raised for it');
  }

  let adjustment = null;
  if (status === 'approved') {
    if (!(Number(award.amount) > 0)) throw new HttpError(400, 'Cannot approve a bonus award with no amount');
    // Books the bonus into payroll so it is picked up by the next calculation.
    // sourceType/sourceId keeps this idempotent — re-approving cannot double-pay.
    adjustment = await createAdjustment(req.user.tenant_id, req.user, {
      employeeId: award.employee_id,
      atype: 'bonus',
      direction: 'earning',
      component: 'Bonus',
      description: award.plan_name || `${award.btype || 'Bonus'} ${award.plan_year || ''}`.trim(),
      amount: award.amount,
      forPeriodYear: award.plan_year || null,
      forPeriodMonth: null,
      sourceType: 'bonus',
      sourceId: award.id,
      reason: `Bonus award #${award.id} approved`,
      autoApprove: true,
    });
  }
  if (status === 'paid') {
    // A bonus may only be declared paid once payroll actually carried it.
    const [adj] = await pool.query(
      `SELECT id, applied_run_id, status FROM payroll_adjustments
       WHERE tenant_id = ? AND source_type = 'bonus' AND source_id = ?`,
      [req.user.tenant_id, award.id]
    );
    if (!adj[0]) throw new HttpError(409, 'This award has no payroll adjustment — approve it first');
    if (!adj[0].applied_run_id) {
      throw new HttpError(409, 'The payroll adjustment for this award has not been paid in a locked run yet');
    }
  }

  await pool.query('UPDATE bonus_awards SET status = ? WHERE id = ? AND tenant_id = ?', [status, req.params.id, req.user.tenant_id]);
  await logAudit({
    tenantId: req.user.tenant_id, actor: req.user, action: `bonus.award_${status}`,
    entityType: 'bonus_award', entityId: award.id,
    before: { status: award.status }, after: { status, adjustmentId: adjustment?.id || null }, req,
  });
  res.json({ data: { id: award.id, status, adjustment } });
}));

// ---- Pay equity & bands analytics ----
r.get('/analytics/equity', requirePermission('compensation.view'), asyncH(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT des.name AS designation, g.name AS grade, e.gender, COUNT(*) AS n,
            AVG(es.ctc_annual) AS avg_ctc, MIN(es.ctc_annual) AS min_ctc, MAX(es.ctc_annual) AS max_ctc
     FROM employees e
     LEFT JOIN designations des ON des.id = e.designation_id
     LEFT JOIN grades g ON g.id = e.grade_id
     LEFT JOIN employee_salaries es ON es.employee_id = e.id AND es.id = (SELECT MAX(id) FROM employee_salaries WHERE employee_id = e.id)
     WHERE e.tenant_id = ? AND e.status IN ('active','on_probation')
     GROUP BY des.name, g.name, e.gender ORDER BY des.name, g.name`,
    [req.user.tenant_id]
  );
  // compress to per designation+grade with male/female averages
  const map = {};
  for (const row of rows) {
    const key = `${row.designation || '—'}|${row.grade || '—'}`;
    if (!map[key]) map[key] = { designation: row.designation, grade: row.grade, male: null, female: null, n: 0 };
    map[key][row.gender === 'female' ? 'female' : 'male'] = Math.round(Number(row.avg_ctc || 0));
    map[key].n += row.n;
  }
  res.json({ data: Object.values(map), detail: rows });
}));

r.get('/analytics/band-positions', requirePermission('compensation.view'), asyncH(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT CONCAT(e.first_name, ' ', e.last_name) AS employee_name, e.employee_code, g.name AS grade, es.ctc_annual,
            sb.name AS band_name, sb.min_amount, sb.max_amount
     FROM employees e
     LEFT JOIN grades g ON g.id = e.grade_id
     LEFT JOIN employee_salaries es ON es.employee_id = e.id AND es.id = (SELECT MAX(id) FROM employee_salaries WHERE employee_id = e.id)
     LEFT JOIN salary_bands sb ON sb.grade_id = e.grade_id AND sb.status = 'active'
     WHERE e.tenant_id = ? AND e.status IN ('active','on_probation')
     ORDER BY g.level, es.ctc_annual LIMIT 500`,
    [req.user.tenant_id]
  );
  res.json({ data: rows });
}));

module.exports = r;
