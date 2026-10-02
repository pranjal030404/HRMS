const express = require('express');
const { pool } = require('../config/db');
const { asyncH, HttpError } = require('../utils/helpers');
const { authenticate, requirePermission } = require('../middleware/auth');
const { logAudit } = require('../services/audit');
const { crudRouter } = require('./_crud');

const r = express.Router();
r.use(authenticate);

// ---- Benefit plans ----
r.use('/plans', crudRouter({
  table: 'benefit_plans', perm: 'benefit.manage',
  fields: ['name', 'btype', 'provider', 'description', 'eligibility', 'employer_cost', 'employee_cost', 'effective_from', 'status'],
  required: ['name'], searchable: ['name', 'provider'], numericFields: ['employer_cost', 'employee_cost'],
  jsonFields: ['eligibility'],
}));

// ---- Enrollments ----
r.get('/enrollments', requirePermission('benefit.view'), asyncH(async (req, res) => {
  const params = [req.user.tenant_id];
  let where = 'be.tenant_id = ?';
  if (req.query.plan_id) { where += ' AND be.plan_id = ?'; params.push(req.query.plan_id); }
  if (req.query.employee_id) { where += ' AND be.employee_id = ?'; params.push(req.query.employee_id); }
  const [rows] = await pool.query(
    `SELECT be.*, CONCAT(e.first_name, ' ', e.last_name) AS employee_name, e.employee_code,
            d.name AS department, p.name AS plan_name, p.btype, p.provider
     FROM benefit_enrollments be
     JOIN employees e ON e.id = be.employee_id
     LEFT JOIN departments d ON d.id = e.department_id
     JOIN benefit_plans p ON p.id = be.plan_id
     WHERE ${where} ORDER BY p.name, employee_name LIMIT 1000`,
    params
  );
  res.json({ data: rows });
}));

// Employee's own benefits (portal)
r.get('/mine', asyncH(async (req, res) => {
  if (!req.user.employee_id) return res.json({ data: [] });
  const [rows] = await pool.query(
    `SELECT be.*, p.name AS plan_name, p.btype, p.provider, p.description
     FROM benefit_enrollments be JOIN benefit_plans p ON p.id = be.plan_id
     WHERE be.tenant_id = ? AND be.employee_id = ? AND be.status = 'active'
     ORDER BY p.name`,
    [req.user.tenant_id, req.user.employee_id]
  );
  res.json({ data: rows });
}));

r.post('/enroll', requirePermission('benefit.manage'), asyncH(async (req, res) => {
  const { planId, employeeId, nomineeName, nomineeRelation, nomineeDob, coverageDetails, enrolledOn } = req.body || {};
  if (!planId || !employeeId) throw new HttpError(400, 'planId and employeeId required');
  const [plans] = await pool.query('SELECT * FROM benefit_plans WHERE id = ? AND tenant_id = ?', [planId, req.user.tenant_id]);
  if (!plans[0]) throw new HttpError(404, 'Benefit plan not found');
  // eligibility check
  const el = typeof plans[0].eligibility === 'string' ? JSON.parse(plans[0].eligibility || '{}') : (plans[0].eligibility || {});
  const [emps] = await pool.query('SELECT employment_type, joined_on, grade_id FROM employees WHERE id = ?', [employeeId]);
  const emp = emps[0];
  if (emp && Array.isArray(el.employmentTypes) && el.employmentTypes.length && !el.employmentTypes.includes(emp.employment_type)) {
    throw new HttpError(400, `Employee employment type (${emp.employment_type}) is not eligible for this plan`);
  }
  if (emp && el.minTenureMonths && emp.joined_on) {
    const months = Math.floor((Date.now() - new Date(emp.joined_on).getTime()) / (30 * 24 * 3600 * 1000));
    if (months < Number(el.minTenureMonths)) throw new HttpError(400, `Minimum tenure ${el.minTenureMonths} months not met (${months})`);
  }
  const [ins] = await pool.query(
    `INSERT INTO benefit_enrollments (tenant_id, plan_id, employee_id, nominee_name, nominee_relation, nominee_dob, coverage_details, enrolled_on, status)
     VALUES (?,?,?,?,?,?,?,?, 'active')
     ON DUPLICATE KEY UPDATE nominee_name = VALUES(nominee_name), nominee_relation = VALUES(nominee_relation), nominee_dob = VALUES(nominee_dob), coverage_details = VALUES(coverage_details), status = 'active'`,
    [req.user.tenant_id, planId, employeeId, nomineeName || null, nomineeRelation || null, nomineeDob || null,
      coverageDetails ? JSON.stringify(coverageDetails) : null, enrolledOn || null]
  );
  await logAudit({ tenantId: req.user.tenant_id, actor: req.user, action: 'benefit.enroll', entityType: 'benefit_enrollment', entityId: ins.insertId, after: req.body, req });
  res.status(201).json({ data: { id: ins.insertId } });
}));

r.put('/enrollments/:id/close', requirePermission('benefit.manage'), asyncH(async (req, res) => {
  await pool.query('UPDATE benefit_enrollments SET status = "closed" WHERE id = ? AND tenant_id = ?', [req.params.id, req.user.tenant_id]);
  res.json({ ok: true });
}));

// ---- Benefits overview ----
r.get('/overview', requirePermission('benefit.view'), asyncH(async (req, res) => {
  const T = req.user.tenant_id;
  const [[{ activePlans }]] = await pool.query('SELECT COUNT(*) AS activePlans FROM benefit_plans WHERE tenant_id = ? AND status = "active"', [T]);
  const [[{ enrolled }]] = await pool.query('SELECT COUNT(*) AS enrolled FROM benefit_enrollments WHERE tenant_id = ? AND status = "active"', [T]);
  const [[{ monthlyCost }]] = await pool.query(
    `SELECT COALESCE(SUM(p.employer_cost),0) AS monthlyCost FROM benefit_enrollments be JOIN benefit_plans p ON p.id = be.plan_id WHERE be.tenant_id = ? AND be.status = 'active'`,
    [T]
  );
  const [byType] = await pool.query(
    `SELECT p.btype, COUNT(*) AS n FROM benefit_enrollments be JOIN benefit_plans p ON p.id = be.plan_id WHERE be.tenant_id = ? AND be.status = 'active' GROUP BY p.btype`,
    [T]
  );
  const [[{ eligibleUnenrolled }]] = await pool.query(
    `SELECT COUNT(*) AS eligibleUnenrolled FROM employees e WHERE e.tenant_id = ? AND e.status IN ('active','on_probation')
     AND NOT EXISTS (SELECT 1 FROM benefit_enrollments be WHERE be.employee_id = e.id AND be.status = 'active')`,
    [T]
  );
  res.json({ data: { activePlans, enrolled, monthlyCost, byType, eligibleUnenrolled } });
}));

module.exports = r;
