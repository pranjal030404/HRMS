const express = require('express');
const { pool } = require('../config/db');
const { asyncH, HttpError } = require('../utils/helpers');
const { authenticate, requirePermission } = require('../middleware/auth');
const { logAudit } = require('../services/audit');
const { upload, relPath } = require('../middleware/upload');
const { crudRouter } = require('./_crud');

const r = express.Router();
r.use(authenticate);

// ---------- Requisitions ----------
r.get('/requisitions', requirePermission('recruitment.view'), asyncH(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT rq.*, d.name AS department_name, l.name AS location_name,
            (SELECT COUNT(*) FROM candidates c WHERE c.requisition_id = rq.id) AS candidate_count
     FROM requisitions rq
     LEFT JOIN departments d ON d.id = rq.department_id
     LEFT JOIN locations l ON l.id = rq.location_id
     WHERE rq.tenant_id = ? ORDER BY rq.created_at DESC LIMIT 100`,
    [req.user.tenant_id]
  );
  res.json({ data: rows });
}));

r.post('/requisitions', requirePermission('recruitment.manage'), asyncH(async (req, res) => {
  const { title, departmentId, locationId, openings, employmentType, minExperience, maxExperience, budgetCtc, description, hiringManagerId } = req.body || {};
  if (!title) throw new HttpError(400, 'Title required');
  const [ins] = await pool.query(
    `INSERT INTO requisitions (tenant_id, rcode, title, department_id, location_id, openings, employment_type, min_experience, max_experience, budget_ctc, description, hiring_manager_id, status, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'pending_approval', ?)`,
    [req.user.tenant_id, `REQ-${Date.now().toString().slice(-6)}`, title, departmentId || null, locationId || null, openings || 1, employmentType || 'full_time', minExperience || 0, maxExperience || null, budgetCtc || null, description || null, hiringManagerId || null, req.user.id]
  );
  res.status(201).json({ data: { id: ins.insertId } });
}));

r.post('/requisitions/:id/status', requirePermission('recruitment.manage'), asyncH(async (req, res) => {
  const { status, published } = req.body || {};
  await pool.query('UPDATE requisitions SET status = COALESCE(?, status), published = COALESCE(?, published) WHERE id = ? AND tenant_id = ?', [status || null, published ?? null, req.params.id, req.user.tenant_id]);
  res.json({ ok: true });
}));

// ---------- Candidates ----------
r.get('/candidates', requirePermission('recruitment.view'), asyncH(async (req, res) => {
  const params = [req.user.tenant_id];
  let where = 'c.tenant_id = ?';
  if (req.query.requisition_id) { where += ' AND c.requisition_id = ?'; params.push(req.query.requisition_id); }
  if (req.query.stage) { where += ' AND c.stage = ?'; params.push(req.query.stage); }
  const [rows] = await pool.query(
    `SELECT c.*, rq.title AS requisition_title FROM candidates c JOIN requisitions rq ON rq.id = c.requisition_id
     WHERE ${where} ORDER BY c.applied_on DESC LIMIT 300`,
    params
  );
  res.json({ data: rows });
}));

r.post('/candidates', requirePermission('recruitment.manage'), upload('resumes'), asyncH(async (req, res) => {
  const { requisitionId, name, email, phone, source, experienceYears, currentCompany, expectedCtc, notes } = req.body || {};
  if (!requisitionId || !name) throw new HttpError(400, 'requisitionId and name required');
  const [ins] = await pool.query(
    `INSERT INTO candidates (tenant_id, requisition_id, name, email, phone, source, resume_path, experience_years, current_company, expected_ctc, notes)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [req.user.tenant_id, requisitionId, name, email || null, phone || null, source || 'direct', req.file ? relPath(req.file) : null, experienceYears || 0, currentCompany || null, expectedCtc || null, notes || null]
  );
  res.status(201).json({ data: { id: ins.insertId } });
}));

r.post('/candidates/:id/stage', requirePermission('recruitment.manage'), asyncH(async (req, res) => {
  const { stage, rating, notes } = req.body || {};
  if (!['applied', 'screening', 'interview', 'offer', 'hired', 'rejected', 'on_hold'].includes(stage)) throw new HttpError(400, 'Invalid stage');
  await pool.query('UPDATE candidates SET stage = ?, rating = COALESCE(?, rating), notes = COALESCE(?, notes) WHERE id = ? AND tenant_id = ?', [stage, rating || null, notes || null, req.params.id, req.user.tenant_id]);
  res.json({ ok: true });
}));

// ---------- Interviews ----------
r.post('/interviews', requirePermission('recruitment.manage'), asyncH(async (req, res) => {
  const { candidateId, roundName, scheduledAt, mode, interviewerId } = req.body || {};
  if (!candidateId || !roundName || !scheduledAt) throw new HttpError(400, 'candidateId, roundName, scheduledAt required');
  const [ins] = await pool.query(
    'INSERT INTO interviews (tenant_id, candidate_id, round_name, scheduled_at, mode, interviewer_id) VALUES (?,?,?,?,?,?)',
    [req.user.tenant_id, candidateId, roundName, scheduledAt, mode || 'video', interviewerId || null]
  );
  await pool.query('UPDATE candidates SET stage = "interview" WHERE id = ? AND stage IN ("applied","screening")', [candidateId]);
  res.status(201).json({ data: { id: ins.insertId } });
}));

r.post('/interviews/:id/feedback', requirePermission('recruitment.manage'), asyncH(async (req, res) => {
  const { score, feedback, result } = req.body || {};
  if (!['pending', 'selected', 'rejected', 'on_hold'].includes(result || 'pending')) throw new HttpError(400, 'Invalid result');
  await pool.query('UPDATE interviews SET score = ?, feedback = ?, result = ? WHERE id = ? AND tenant_id = ?', [score || null, feedback || null, result || 'pending', req.params.id, req.user.tenant_id]);
  res.json({ ok: true });
}));

r.get('/interviews', requirePermission('recruitment.view'), asyncH(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT i.*, c.name AS candidate_name, u.name AS interviewer_name FROM interviews i
     JOIN candidates c ON c.id = i.candidate_id LEFT JOIN users u ON u.id = i.interviewer_id
     WHERE i.tenant_id = ? ORDER BY i.scheduled_at DESC LIMIT 200`,
    [req.user.tenant_id]
  );
  res.json({ data: rows });
}));

// ---------- Offers ----------
r.post('/offers', requirePermission('recruitment.manage'), asyncH(async (req, res) => {
  const { candidateId, designation, ctcAnnual, joiningDate } = req.body || {};
  if (!candidateId || !ctcAnnual) throw new HttpError(400, 'candidateId and ctcAnnual required');
  const [ins] = await pool.query(
    'INSERT INTO offers (tenant_id, candidate_id, designation, ctc_annual, joining_date, status, created_by) VALUES (?,?,?,?,?,?,?)',
    [req.user.tenant_id, candidateId, designation || null, ctcAnnual, joiningDate || null, 'draft', req.user.id]
  );
  await pool.query('UPDATE candidates SET stage = "offer" WHERE id = ?', [candidateId]);
  res.status(201).json({ data: { id: ins.insertId } });
}));

r.post('/offers/:id/:action(send|accept|reject)', requirePermission('recruitment.manage'), asyncH(async (req, res) => {
  const map = { send: 'sent', accept: 'accepted', reject: 'rejected' };
  await pool.query('UPDATE offers SET status = ?, sent_at = COALESCE(sent_at, NOW()), responded_at = IF(? = "sent", NULL, NOW()) WHERE id = ? AND tenant_id = ?', [map[req.params.action], req.params.action, req.params.id, req.user.tenant_id]);
  res.json({ ok: true });
}));

// Convert accepted offer → employee
r.post('/offers/:id/convert', requirePermission('employee.create'), asyncH(async (req, res) => {
  const [offers] = await pool.query('SELECT o.*, c.name, c.email, c.phone FROM offers o JOIN candidates c ON c.id = o.candidate_id WHERE o.id = ? AND o.tenant_id = ?', [req.params.id, req.user.tenant_id]);
  const offer = offers[0];
  if (!offer) throw new HttpError(404, 'Offer not found');
  if (offer.status !== 'accepted') throw new HttpError(400, 'Only accepted offers can be converted');
  const { first_name, last_name } = splitName(offer.name);
  const [[{ maxId }]] = await pool.query('SELECT COALESCE(MAX(id),0)+1 AS maxId FROM employees WHERE tenant_id = ?', [req.user.tenant_id]);
  const code = `EMP${String(maxId).padStart(4, '0')}`;
  const [ins] = await pool.query(
    `INSERT INTO employees (tenant_id, employee_code, first_name, last_name, email, phone, joined_on, employment_type, status)
     VALUES (?,?,?,?,?,?,?,'full_time','onboarding')`,
    [req.user.tenant_id, code, first_name, last_name || '', offer.email || `${code}@example.com`, offer.phone, offer.joining_date || null]
  );
  await pool.query('UPDATE candidates SET stage = "hired" WHERE id = ?', [offer.candidate_id]);
  await logAudit({ tenantId: req.user.tenant_id, actor: req.user, action: 'recruitment.convert_offer', entityType: 'employee', entityId: ins.insertId, after: { offerId: offer.id }, req });
  res.status(201).json({ data: { employeeId: ins.insertId, employeeCode: code } });
}));

function splitName(name) {
  const parts = String(name || '').trim().split(/\s+/);
  return { first_name: parts[0] || 'Candidate', last_name: parts.slice(1).join(' ') || '' };
}

// funnel analytics
r.get('/analytics', requirePermission('recruitment.view'), asyncH(async (req, res) => {
  const [byStage] = await pool.query('SELECT stage, COUNT(*) AS n FROM candidates WHERE tenant_id = ? GROUP BY stage', [req.user.tenant_id]);
  const [bySource] = await pool.query('SELECT source, COUNT(*) AS n FROM candidates WHERE tenant_id = ? GROUP BY source ORDER BY n DESC', [req.user.tenant_id]);
  const [open] = await pool.query(`SELECT COUNT(*) AS n FROM requisitions WHERE tenant_id = ? AND status IN ('open','approved')`, [req.user.tenant_id]);
  res.json({ data: { byStage, bySource, openPositions: open[0].n } });
}));

module.exports = r;
