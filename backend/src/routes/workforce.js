const express = require('express');
const { pool } = require('../config/db');
const { asyncH, HttpError } = require('../utils/helpers');
const { authenticate, requirePermission } = require('../middleware/auth');
const { logAudit } = require('../services/audit');

const r = express.Router();
r.use(authenticate);

// ---- Headcount plans ----
r.get('/', requirePermission('workforce.view'), asyncH(async (req, res) => {
  const params = [req.user.tenant_id];
  let where = 'h.tenant_id = ?';
  if (req.query.year) { where += ' AND h.plan_year = ?'; params.push(req.query.year); }
  if (req.query.department_id) { where += ' AND h.department_id = ?'; params.push(req.query.department_id); }
  const [rows] = await pool.query(
    `SELECT h.*, d.name AS department_name, des.name AS designation_name,
            (SELECT COUNT(*) FROM employees e WHERE e.department_id = h.department_id
              AND (h.designation_id IS NULL OR e.designation_id = h.designation_id)
              AND e.status IN ('active','on_probation')) AS actual_count
     FROM headcount_plans h
     JOIN departments d ON d.id = h.department_id
     LEFT JOIN designations des ON des.id = h.designation_id
     WHERE ${where}
     ORDER BY h.plan_year DESC, h.quarter, d.name, des.name LIMIT 500`,
    params
  );
  res.json({ data: rows });
}));

r.post('/', requirePermission('workforce.manage'), asyncH(async (req, res) => {
  const { planYear, quarter, departmentId, designationId, plannedCount, budgetCtc, scenario, notes } = req.body || {};
  if (!planYear || !departmentId) throw new HttpError(400, 'planYear and departmentId required');
  const [ins] = await pool.query(
    `INSERT INTO headcount_plans (tenant_id, plan_year, quarter, department_id, designation_id, planned_count, budget_ctc, scenario, notes)
     VALUES (?,?,?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE planned_count = VALUES(planned_count), budget_ctc = VALUES(budget_ctc), notes = VALUES(notes)`,
    [req.user.tenant_id, planYear, quarter || 1, departmentId, designationId || null, plannedCount || 0, budgetCtc || 0, scenario || 'base', notes || null]
  );
  await logAudit({ tenantId: req.user.tenant_id, actor: req.user, action: 'headcount_plan.upsert', entityType: 'headcount_plan', entityId: ins.insertId, after: req.body, req });
  res.status(201).json({ data: { id: ins.insertId } });
}));

r.delete('/:id', requirePermission('workforce.manage'), asyncH(async (req, res) => {
  const [before] = await pool.query('SELECT * FROM headcount_plans WHERE id = ? AND tenant_id = ?', [req.params.id, req.user.tenant_id]);
  if (!before[0]) throw new HttpError(404, 'Plan row not found');
  await pool.query('DELETE FROM headcount_plans WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
}));

// ---- Planned vs actual summary (with vacancies) ----
r.get('/summary', requirePermission('workforce.view'), asyncH(async (req, res) => {
  const year = req.query.year || new Date().getFullYear();
  const [rows] = await pool.query(
    `SELECT h.quarter, d.name AS department, des.name AS designation, h.scenario,
            SUM(h.planned_count) AS planned, SUM(h.budget_ctc) AS budget
     FROM headcount_plans h
     JOIN departments d ON d.id = h.department_id
     LEFT JOIN designations des ON des.id = h.designation_id
     WHERE h.tenant_id = ? AND h.plan_year = ?
     GROUP BY h.quarter, d.name, des.name, h.scenario ORDER BY h.quarter, d.name`,
    [req.user.tenant_id, year]
  );
  // actual headcount per department
  const [actuals] = await pool.query(
    `SELECT d.name AS department, COUNT(e.id) AS actual, COALESCE(SUM(es.ctc_annual),0) AS actual_cost
     FROM departments d
     LEFT JOIN employees e ON e.department_id = d.id AND e.status IN ('active','on_probation')
     LEFT JOIN employee_salaries es ON es.employee_id = e.id AND es.id = (SELECT MAX(id) FROM employee_salaries WHERE employee_id = e.id)
     WHERE d.tenant_id = ? GROUP BY d.name`,
    [req.user.tenant_id]
  );
  const plannedTotal = rows.reduce((a, r) => a + Number(r.planned || 0), 0);
  const actualTotal = actuals.reduce((a, r) => a + Number(r.actual || 0), 0);
  res.json({
    data: {
      year: Number(year), rows, actuals,
      plannedTotal, actualTotal,
      vacancies: Math.max(0, plannedTotal - actualTotal),
      plannedCost: rows.reduce((a, r) => a + Number(r.budget || 0), 0),
      actualCost: actuals.reduce((a, r) => a + Number(r.actual_cost || 0), 0),
    },
  });
}));

// ---- Open positions feed (planned minus actual, joined with open requisitions) ----
r.get('/vacancies', requirePermission('workforce.view'), asyncH(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT h.plan_year, h.quarter, d.name AS department, des.name AS designation, h.planned_count,
            (SELECT COUNT(*) FROM employees e WHERE e.department_id = h.department_id AND (h.designation_id IS NULL OR e.designation_id = h.designation_id) AND e.status IN ('active','on_probation')) AS actual_count,
            (SELECT COALESCE(SUM(openings),0) FROM requisitions r WHERE r.department_id = h.department_id AND (h.designation_id IS NULL OR r.title LIKE CONCAT('%', des.name, '%')) AND r.status = 'open') AS open_requisitions
     FROM headcount_plans h
     JOIN departments d ON d.id = h.department_id
     LEFT JOIN designations des ON des.id = h.designation_id
     WHERE h.tenant_id = ? AND h.status = 'active'
     HAVING planned_count > actual_count
     ORDER BY h.plan_year DESC, h.quarter LIMIT 200`,
    [req.user.tenant_id]
  );
  res.json({ data: rows });
}));

module.exports = r;
