const express = require('express');
const { pool } = require('../config/db');
const { asyncH, HttpError } = require('../utils/helpers');
const { authenticate, requirePermission, employeeScopeCondition } = require('../middleware/auth');
const { logAudit } = require('../services/audit');
const { crudRouter } = require('./_crud');
const { emitEvent } = require('../services/webhooks');

const r = express.Router();
r.use(authenticate);

// ---- Skills catalogue + employee skill matrix ----
r.use('/skills', crudRouter({
  table: 'skills', perm: 'talent.manage',
  fields: ['name', 'category', 'status'], required: ['name'], searchable: ['name', 'category'],
}));

r.get('/matrix', requirePermission('talent.view'), asyncH(async (req, res) => {
  const params = [req.user.tenant_id];
  let where = 'es.tenant_id = ?';
  const scope = employeeScopeCondition(req.user, 'employee.view', 'e');
  where += ` AND ${scope.sql}`;
  params.push(...scope.params);
  if (req.query.skill_id) { where += ' AND es.skill_id = ?'; params.push(req.query.skill_id); }
  if (req.query.department_id) { where += ' AND e.department_id = ?'; params.push(req.query.department_id); }
  const [rows] = await pool.query(
    `SELECT es.id, es.employee_id, es.skill_id, es.proficiency, es.years_experience, es.verified, es.notes,
            s.name AS skill_name, s.category AS skill_category,
            CONCAT(e.first_name, ' ', e.last_name) AS employee_name, e.employee_code,
            d.name AS department
     FROM employee_skills es
     JOIN skills s ON s.id = es.skill_id
     JOIN employees e ON e.id = es.employee_id
     LEFT JOIN departments d ON d.id = e.department_id
     WHERE ${where}
     ORDER BY employee_name, s.name LIMIT 1000`,
    params
  );
  res.json({ data: rows });
}));

r.post('/matrix', requirePermission('talent.manage'), asyncH(async (req, res) => {
  const { employeeId, skillId, proficiency, yearsExperience, notes, verified } = req.body || {};
  if (!employeeId || !skillId) throw new HttpError(400, 'employeeId and skillId required');
  const [ins] = await pool.query(
    `INSERT INTO employee_skills (tenant_id, employee_id, skill_id, proficiency, years_experience, notes, verified)
     VALUES (?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE proficiency = VALUES(proficiency), years_experience = VALUES(years_experience), notes = VALUES(notes), verified = VALUES(verified)`,
    [req.user.tenant_id, employeeId, skillId, proficiency || 'intermediate', yearsExperience || 0, notes || null, verified ? 1 : 0]
  );
  await logAudit({ tenantId: req.user.tenant_id, actor: req.user, action: 'employee_skill.upsert', entityType: 'employee_skill', entityId: ins.insertId, after: req.body, req });
  res.status(201).json({ data: { id: ins.insertId } });
}));

r.delete('/matrix/:id', requirePermission('talent.manage'), asyncH(async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM employee_skills WHERE id = ? AND tenant_id = ?', [req.params.id, req.user.tenant_id]);
  if (!rows[0]) throw new HttpError(404, 'Record not found');
  await pool.query('DELETE FROM employee_skills WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
}));

// ---- Career paths ----
r.use('/career-paths', crudRouter({
  table: 'career_paths', perm: 'talent.manage',
  fields: ['name', 'track', 'from_designation_id', 'to_designation_id', 'steps', 'description', 'status'],
  required: ['name'], searchable: ['name'], numericFields: ['from_designation_id', 'to_designation_id'], jsonFields: ['steps'],
}));

// ---- Development plans ----
r.get('/development-plans', requirePermission('talent.view'), asyncH(async (req, res) => {
  const params = [req.user.tenant_id];
  let where = 'dp.tenant_id = ?';
  const scope = employeeScopeCondition(req.user, 'employee.view', 'e');
  where += ` AND ${scope.sql}`;
  params.push(...scope.params);
  if (req.query.employee_id) { where += ' AND dp.employee_id = ?'; params.push(req.query.employee_id); }
  const [rows] = await pool.query(
    `SELECT dp.*, CONCAT(e.first_name, ' ', e.last_name) AS employee_name, e.employee_code,
            CONCAT(m.first_name, ' ', m.last_name) AS mentor_name
     FROM development_plans dp
     JOIN employees e ON e.id = dp.employee_id
     LEFT JOIN employees m ON m.id = dp.mentor_id
     WHERE ${where} ORDER BY dp.created_at DESC LIMIT 300`,
    params
  );
  res.json({ data: rows });
}));

r.post('/development-plans', requirePermission('talent.manage'), asyncH(async (req, res) => {
  const { employeeId, title, description, mentorId, startDate, targetDate } = req.body || {};
  if (!employeeId || !title) throw new HttpError(400, 'employeeId and title required');
  const [ins] = await pool.query(
    `INSERT INTO development_plans (tenant_id, employee_id, title, description, mentor_id, start_date, target_date, status)
     VALUES (?,?,?,?,?,?,?, 'active')`,
    [req.user.tenant_id, employeeId, title, description || null, mentorId || null, startDate || null, targetDate || null]
  );
  await emitEvent({ tenantId: req.user.tenant_id, eventType: 'development_plan.created', payload: { id: ins.insertId, employeeId, title } });
  await logAudit({ tenantId: req.user.tenant_id, actor: req.user, action: 'development_plan.create', entityType: 'development_plan', entityId: ins.insertId, after: req.body, req });
  res.status(201).json({ data: { id: ins.insertId } });
}));

r.put('/development-plans/:id', requirePermission('talent.manage'), asyncH(async (req, res) => {
  const [before] = await pool.query('SELECT * FROM development_plans WHERE id = ? AND tenant_id = ?', [req.params.id, req.user.tenant_id]);
  if (!before[0]) throw new HttpError(404, 'Plan not found');
  const allowed = ['title', 'description', 'mentor_id', 'start_date', 'target_date', 'progress', 'status'];
  const sets = [], params = [];
  for (const k of allowed) if (req.body[k] !== undefined) { sets.push(`${k} = ?`); params.push(k === 'progress' ? Math.max(0, Math.min(100, Number(req.body[k]))) : req.body[k]); }
  if (!sets.length) throw new HttpError(400, 'No fields to update');
  params.push(req.params.id, req.user.tenant_id);
  await pool.query(`UPDATE development_plans SET ${sets.join(', ')} WHERE id = ? AND tenant_id = ?`, params);
  await logAudit({ tenantId: req.user.tenant_id, actor: req.user, action: 'development_plan.update', entityType: 'development_plan', entityId: req.params.id, before: before[0], after: req.body, req });
  res.json({ ok: true });
}));

// ---- Talent pools ----
r.use('/pools', crudRouter({
  table: 'talent_pools', perm: 'talent.manage',
  fields: ['name', 'description', 'status'], required: ['name'], searchable: ['name'],
}));

r.get('/pools/:id/members', requirePermission('talent.view'), asyncH(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT tm.*, CONCAT(e.first_name, ' ', e.last_name) AS employee_name, e.employee_code,
            c.name AS candidate_name, p.name AS pool_name
     FROM talent_pool_members tm
     LEFT JOIN employees e ON e.id = tm.employee_id
     LEFT JOIN candidates c ON c.id = tm.candidate_id
     JOIN talent_pools p ON p.id = tm.pool_id
     WHERE tm.pool_id = ? AND tm.tenant_id = ? ORDER BY tm.created_at DESC LIMIT 200`,
    [req.params.id, req.user.tenant_id]
  );
  res.json({ data: rows });
}));

r.post('/pools/:id/members', requirePermission('talent.manage'), asyncH(async (req, res) => {
  const { employeeId, candidateId, notes } = req.body || {};
  if (!employeeId && !candidateId) throw new HttpError(400, 'employeeId or candidateId required');
  const [ins] = await pool.query(
    `INSERT INTO talent_pool_members (tenant_id, pool_id, employee_id, candidate_id, notes, added_by) VALUES (?,?,?,?,?,?)`,
    [req.user.tenant_id, req.params.id, employeeId || null, candidateId || null, notes || null, req.user.id]
  );
  res.status(201).json({ data: { id: ins.insertId } });
}));

r.delete('/pools/:id/members/:memberId', requirePermission('talent.manage'), asyncH(async (req, res) => {
  await pool.query('DELETE FROM talent_pool_members WHERE id = ? AND pool_id = ? AND tenant_id = ?', [req.params.memberId, req.params.id, req.user.tenant_id]);
  res.json({ ok: true });
}));

// ---- Succession planning ----
r.get('/succession', requirePermission('talent.view'), asyncH(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT sp.*,
            CONCAT(e.first_name, ' ', e.last_name) AS incumbent_name, e.employee_code AS incumbent_code, d.name AS incumbent_department,
            CONCAT(s.first_name, ' ', s.last_name) AS successor_name, s.employee_code AS successor_code
     FROM succession_plans sp
     LEFT JOIN employees e ON e.id = sp.employee_id
     LEFT JOIN departments d ON d.id = e.department_id
     LEFT JOIN employees s ON s.id = sp.successor_employee_id
     WHERE sp.tenant_id = ?
     ORDER BY FIELD(sp.criticality, 'critical', 'high', 'medium', 'low'), sp.position_title LIMIT 300`,
    [req.user.tenant_id]
  );
  res.json({ data: rows });
}));

r.post('/succession', requirePermission('talent.manage'), asyncH(async (req, res) => {
  const { positionTitle, employeeId, criticality, risk, successorEmployeeId, readiness, developmentActions, notes } = req.body || {};
  if (!positionTitle) throw new HttpError(400, 'positionTitle required');
  const [ins] = await pool.query(
    `INSERT INTO succession_plans (tenant_id, position_title, employee_id, criticality, risk, successor_employee_id, readiness, development_actions, notes, status)
     VALUES (?,?,?,?,?,?,?,?,?, 'active')`,
    [req.user.tenant_id, positionTitle, employeeId || null, criticality || 'medium', risk || 'medium', successorEmployeeId || null, readiness || 'ready_1_2_years', developmentActions || null, notes || null]
  );
  await logAudit({ tenantId: req.user.tenant_id, actor: req.user, action: 'succession_plan.create', entityType: 'succession_plan', entityId: ins.insertId, after: req.body, req });
  res.status(201).json({ data: { id: ins.insertId } });
}));

r.put('/succession/:id', requirePermission('talent.manage'), asyncH(async (req, res) => {
  const [before] = await pool.query('SELECT * FROM succession_plans WHERE id = ? AND tenant_id = ?', [req.params.id, req.user.tenant_id]);
  if (!before[0]) throw new HttpError(404, 'Plan not found');
  const allowed = ['position_title', 'employee_id', 'criticality', 'risk', 'successor_employee_id', 'readiness', 'development_actions', 'notes', 'status'];
  const sets = [], params = [];
  for (const k of allowed) if (req.body[k] !== undefined) { sets.push(`${k} = ?`); params.push(req.body[k]); }
  if (!sets.length) throw new HttpError(400, 'No fields to update');
  params.push(req.params.id, req.user.tenant_id);
  await pool.query(`UPDATE succession_plans SET ${sets.join(', ')} WHERE id = ? AND tenant_id = ?`, params);
  await logAudit({ tenantId: req.user.tenant_id, actor: req.user, action: 'succession_plan.update', entityType: 'succession_plan', entityId: req.params.id, before: before[0], after: req.body, req });
  res.json({ ok: true });
}));

// ---- Certifications (part of talent record; LMS-created ones arrive via API) ----
r.get('/certifications', requirePermission('talent.view'), asyncH(async (req, res) => {
  const params = [req.user.tenant_id];
  let where = 'c.tenant_id = ?';
  if (req.query.employee_id) { where += ' AND c.employee_id = ?'; params.push(req.query.employee_id); }
  if (req.query.expiring === '1') { where += ' AND c.expires_on IS NOT NULL AND c.expires_on <= DATE_ADD(CURDATE(), INTERVAL 90 DAY)'; }
  const [rows] = await pool.query(
    `SELECT c.*, CONCAT(e.first_name, ' ', e.last_name) AS employee_name, e.employee_code
     FROM certifications c JOIN employees e ON e.id = c.employee_id
     WHERE ${where} ORDER BY c.expires_on IS NULL, c.expires_on LIMIT 300`,
    params
  );
  res.json({ data: rows });
}));

r.post('/certifications', requirePermission('talent.manage'), asyncH(async (req, res) => {
  const { employeeId, name, issuedBy, issuedOn, expiresOn, credentialId, verified } = req.body || {};
  if (!employeeId || !name) throw new HttpError(400, 'employeeId and name required');
  const [ins] = await pool.query(
    `INSERT INTO certifications (tenant_id, employee_id, name, issued_by, issued_on, expires_on, credential_id, verified)
     VALUES (?,?,?,?,?,?,?,?)`,
    [req.user.tenant_id, employeeId, name, issuedBy || null, issuedOn || null, expiresOn || null, credentialId || null, verified ? 1 : 0]
  );
  res.status(201).json({ data: { id: ins.insertId } });
}));

// ---- Training records (LMS completions land here) ----
r.get('/training', requirePermission('talent.view'), asyncH(async (req, res) => {
  const params = [req.user.tenant_id];
  let where = 't.tenant_id = ?';
  if (req.query.employee_id) { where += ' AND t.employee_id = ?'; params.push(req.query.employee_id); }
  const [rows] = await pool.query(
    `SELECT t.*, CONCAT(e.first_name, ' ', e.last_name) AS employee_name, e.employee_code
     FROM training_records t JOIN employees e ON e.id = t.employee_id
     WHERE ${where} ORDER BY t.completed_on DESC LIMIT 300`,
    params
  );
  res.json({ data: rows });
}));

// ---- Talent overview KPIs ----
r.get('/overview', requirePermission('talent.view'), asyncH(async (req, res) => {
  const T = req.user.tenant_id;
  const [[{ skillCount }]] = await pool.query('SELECT COUNT(*) AS skillCount FROM skills WHERE tenant_id = ? AND status = "active"', [T]);
  const [[{ mapped }]] = await pool.query('SELECT COUNT(DISTINCT employee_id) AS mapped FROM employee_skills WHERE tenant_id = ?', [T]);
  const [[{ activePlans }]] = await pool.query('SELECT COUNT(*) AS activePlans FROM development_plans WHERE tenant_id = ? AND status = "active"', [T]);
  const [[{ criticalRoles }]] = await pool.query('SELECT COUNT(*) AS criticalRoles FROM succession_plans WHERE tenant_id = ? AND criticality IN ("high","critical") AND status = "active"', [T]);
  const [[{ successorsReady }]] = await pool.query('SELECT COUNT(*) AS successorsReady FROM succession_plans WHERE tenant_id = ? AND readiness = "ready_now"', [T]);
  const [[{ expiringCerts }]] = await pool.query('SELECT COUNT(*) AS expiringCerts FROM certifications WHERE tenant_id = ? AND expires_on BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 90 DAY)', [T]);
  res.json({
    data: {
      skillCount, mapped, activePlans, criticalRoles, successorsReady, expiringCerts,
      coverage: mapped ? Math.round((mapped / Math.max(1, skillCount)) * 100) : 0,
    },
  });
}));

module.exports = r;
