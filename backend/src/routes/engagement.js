const express = require('express');
const { pool } = require('../config/db');
const { asyncH, HttpError } = require('../utils/helpers');
const { authenticate, requirePermission } = require('../middleware/auth');
const { logAudit } = require('../services/audit');
const { crudRouter } = require('./_crud');
const { notifyEvent } = require('../services/notify');

const r = express.Router();
r.use(authenticate);

// ---- Surveys ----
r.use('/surveys', crudRouter({
  table: 'surveys', perm: 'engagement.manage',
  fields: ['title', 'description', 'stype', 'anonymity', 'questions', 'start_date', 'end_date', 'status'],
  required: ['title'], searchable: ['title'], jsonFields: ['questions'],
}));

// Active surveys visible to the signed-in employee
r.get('/my/surveys', asyncH(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT id, title, description, stype, anonymity, questions, end_date FROM surveys
     WHERE tenant_id = ? AND status = 'active' AND (start_date IS NULL OR start_date <= CURDATE())
     ORDER BY end_date IS NULL, end_date LIMIT 20`,
    [req.user.tenant_id]
  );
  const data = [];
  for (const s of rows) {
    const [answered] = await pool.query(
      `SELECT id FROM survey_responses WHERE survey_id = ? AND employee_id = ?`,
      [s.id, req.user.employee_id || 0]
    );
    data.push({ ...s, answered: answered.length > 0, questions: typeof s.questions === 'string' ? JSON.parse(s.questions) : s.questions });
  }
  res.json({ data });
}));

r.post('/surveys/:id/respond', requirePermission('engagement.respond'), asyncH(async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM surveys WHERE id = ? AND tenant_id = ?', [req.params.id, req.user.tenant_id]);
  const survey = rows[0];
  if (!survey) throw new HttpError(404, 'Survey not found');
  if (survey.status !== 'active') throw new HttpError(400, 'Survey is not active');
  const anonymous = survey.anonymity === 'anonymous';
  if (!req.user.employee_id) throw new HttpError(400, 'Only linked employees can respond');
  if (!anonymous) {
    const [dupe] = await pool.query('SELECT id FROM survey_responses WHERE survey_id = ? AND employee_id = ?', [survey.id, req.user.employee_id]);
    if (dupe[0]) throw new HttpError(400, 'You have already responded');
  }
  await pool.query(
    'INSERT INTO survey_responses (tenant_id, survey_id, employee_id, answers) VALUES (?,?,?,?)',
    [req.user.tenant_id, survey.id, anonymous ? null : req.user.employee_id, JSON.stringify(req.body.answers || [])]
  );
  res.status(201).json({ ok: true });
}));

r.get('/surveys/:id/results', requirePermission('engagement.view'), asyncH(async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM surveys WHERE id = ? AND tenant_id = ?', [req.params.id, req.user.tenant_id]);
  const survey = rows[0];
  if (!survey) throw new HttpError(404, 'Survey not found');
  const [responses] = await pool.query('SELECT employee_id, answers, submitted_at FROM survey_responses WHERE survey_id = ?', [survey.id]);
  const questions = typeof survey.questions === 'string' ? JSON.parse(survey.questions) : survey.questions;
  const results = questions.map((q) => {
    const values = responses.map((r) => {
      const answers = typeof r.answers === 'string' ? JSON.parse(r.answers) : r.answers;
      return (answers || []).find((a) => Number(a.qid) === Number(q.id));
    }).filter(Boolean);
    if (q.type === 'rating') {
      const nums = values.map((v) => Number(v.value)).filter((n) => !Number.isNaN(n));
      return {
        ...q, responses: nums.length,
        average: nums.length ? Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 100) / 100 : 0,
        distribution: [1, 2, 3, 4, 5].map((n) => ({ rating: n, count: nums.filter((x) => x === n).length })),
      };
    }
    if (q.type === 'choice') {
      const counts = {};
      for (const v of values) counts[v.value] = (counts[v.value] || 0) + 1;
      return { ...q, responses: values.length, counts };
    }
    return { ...q, responses: values.length, texts: survey.anonymity === 'anonymous' ? values.map((v) => v.value) : values.map((v) => v.value) };
  });
  res.json({ data: { survey: { id: survey.id, title: survey.title, anonymity: survey.anonymity, status: survey.status }, responseCount: responses.length, results } });
}));

// ---- Polls ----
r.get('/polls', asyncH(async (req, res) => {
  const [polls] = await pool.query(
    'SELECT * FROM polls WHERE tenant_id = ? ORDER BY status = "active" DESC, created_at DESC LIMIT 30',
    [req.user.tenant_id]
  );
  const data = [];
  for (const p of polls) {
    const [votes] = await pool.query('SELECT option_index, COUNT(*) AS n FROM poll_votes WHERE poll_id = ? GROUP BY option_index', [p.id]);
    const [mine] = await pool.query('SELECT option_index FROM poll_votes WHERE poll_id = ? AND employee_id = ?', [p.id, req.user.employee_id || 0]);
    data.push({
      ...p, options: typeof p.options === 'string' ? JSON.parse(p.options) : p.options,
      counts: votes.map((v) => ({ optionIndex: v.option_index, count: v.n })),
      myVote: mine[0] ? mine[0].option_index : null,
    });
  }
  res.json({ data });
}));

r.post('/polls', requirePermission('engagement.manage'), asyncH(async (req, res) => {
  const { question, options, endsAt } = req.body || {};
  if (!question || !Array.isArray(options) || options.length < 2) throw new HttpError(400, 'question and 2+ options required');
  const [ins] = await pool.query(
    'INSERT INTO polls (tenant_id, question, options, ends_at, status, created_by) VALUES (?,?,?,?, "active", ?)',
    [req.user.tenant_id, question, JSON.stringify(options), endsAt || null, req.user.id]
  );
  res.status(201).json({ data: { id: ins.insertId } });
}));

r.post('/polls/:id/vote', requirePermission('engagement.respond'), asyncH(async (req, res) => {
  const { optionIndex } = req.body || {};
  if (optionIndex === undefined || !req.user.employee_id) throw new HttpError(400, 'optionIndex and employee link required');
  const [rows] = await pool.query('SELECT * FROM polls WHERE id = ? AND tenant_id = ?', [req.params.id, req.user.tenant_id]);
  if (!rows[0] || rows[0].status !== 'active') throw new HttpError(400, 'Poll is not active');
  const options = typeof rows[0].options === 'string' ? JSON.parse(rows[0].options) : rows[0].options;
  if (Number(optionIndex) >= options.length) throw new HttpError(400, 'Invalid option');
  try {
    await pool.query('INSERT INTO poll_votes (tenant_id, poll_id, employee_id, option_index) VALUES (?,?,?,?)',
      [req.user.tenant_id, req.params.id, req.user.employee_id, optionIndex]);
  } catch (e) {
    if (/Duplicate/.test(e.message)) throw new HttpError(400, 'Already voted');
    throw e;
  }
  res.status(201).json({ ok: true });
}));

r.put('/polls/:id/close', requirePermission('engagement.manage'), asyncH(async (req, res) => {
  await pool.query('UPDATE polls SET status = "closed" WHERE id = ? AND tenant_id = ?', [req.params.id, req.user.tenant_id]);
  res.json({ ok: true });
}));

// ---- Recognition wall (kudos / badges / rewards) ----
r.get('/recognitions', asyncH(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT rec.*, CONCAT(f.first_name, ' ', f.last_name) AS from_name,
            CONCAT(t.first_name, ' ', t.last_name) AS to_name, t.employee_code AS to_code, d.name AS to_department
     FROM recognitions rec
     JOIN employees f ON f.id = rec.from_employee_id
     JOIN employees t ON t.id = rec.to_employee_id
     LEFT JOIN departments d ON d.id = t.department_id
     WHERE rec.tenant_id = ? ORDER BY rec.created_at DESC LIMIT 100`,
    [req.user.tenant_id]
  );
  res.json({ data: rows });
}));

r.post('/recognitions', requirePermission('engagement.respond'), asyncH(async (req, res) => {
  const { toEmployeeId, rtype, points, message } = req.body || {};
  if (!toEmployeeId || !req.user.employee_id) throw new HttpError(400, 'toEmployeeId and linked employee required');
  if (Number(toEmployeeId) === Number(req.user.employee_id)) throw new HttpError(400, 'Cannot recognise yourself');
  const [ins] = await pool.query(
    `INSERT INTO recognitions (tenant_id, from_employee_id, to_employee_id, rtype, points, message) VALUES (?,?,?,?,?,?)`,
    [req.user.tenant_id, req.user.employee_id, toEmployeeId, rtype || 'kudos', Number(points) || (rtype === 'reward' ? 50 : 10), message || null]
  );
  await notifyEvent({
    tenantId: req.user.tenant_id, eventKey: 'engagement.recognition',
    vars: { title: 'You received recognition! 🎉', body: message || 'Someone appreciated your work.' },
    recipients: (await pool.query('SELECT id FROM users WHERE employee_id = ? AND status = "active"', [toEmployeeId]))[0].map((u) => ({ userId: u.id })),
    link: '/engagement',
  });
  res.status(201).json({ data: { id: ins.insertId } });
}));

// ---- Suggestions box ----
r.get('/suggestions', asyncH(async (req, res) => {
  const isManager = (req.user.permissions || []).some((p) => p.startsWith('engagement.manage'));
  const params = [req.user.tenant_id];
  let where = 's.tenant_id = ?';
  if (!isManager) { where += ' AND (s.employee_id = ? OR s.employee_id IS NULL)'; params.push(req.user.employee_id || 0); }
  if (req.query.status) { where += ' AND s.status = ?'; params.push(req.query.status); }
  const [rows] = await pool.query(
    `SELECT s.*, CONCAT(e.first_name, ' ', e.last_name) AS employee_name
     FROM suggestions s LEFT JOIN employees e ON e.id = s.employee_id
     WHERE ${where} ORDER BY s.created_at DESC LIMIT 200`,
    params
  );
  res.json({ data: rows.map((s) => ({ ...s, employee_name: s.employee_id ? s.employee_name : 'Anonymous' })) });
}));

r.post('/suggestions', requirePermission('engagement.respond'), asyncH(async (req, res) => {
  const { category, subject, body, anonymous } = req.body || {};
  if (!subject) throw new HttpError(400, 'subject required');
  const [ins] = await pool.query(
    'INSERT INTO suggestions (tenant_id, employee_id, category, subject, body) VALUES (?,?,?,?,?)',
    [req.user.tenant_id, anonymous ? null : (req.user.employee_id || null), category || 'general', subject, body || null]
  );
  res.status(201).json({ data: { id: ins.insertId } });
}));

r.put('/suggestions/:id', requirePermission('engagement.manage'), asyncH(async (req, res) => {
  const { status, adminNotes } = req.body || {};
  const [rows] = await pool.query('SELECT * FROM suggestions WHERE id = ? AND tenant_id = ?', [req.params.id, req.user.tenant_id]);
  if (!rows[0]) throw new HttpError(404, 'Suggestion not found');
  await pool.query('UPDATE suggestions SET status = COALESCE(?, status), admin_notes = COALESCE(?, admin_notes) WHERE id = ?',
    [status || null, adminNotes || null, req.params.id]);
  await logAudit({ tenantId: req.user.tenant_id, actor: req.user, action: 'suggestion.update', entityType: 'suggestion', entityId: req.params.id, before: rows[0], after: req.body, req });
  res.json({ ok: true });
}));

// ---- Engagement overview ----
r.get('/overview', requirePermission('engagement.view'), asyncH(async (req, res) => {
  const T = req.user.tenant_id;
  const [[{ activeSurveys }]] = await pool.query('SELECT COUNT(*) AS activeSurveys FROM surveys WHERE tenant_id = ? AND status = "active"', [T]);
  const [[{ surveyResponses }]] = await pool.query('SELECT COUNT(*) AS surveyResponses FROM survey_responses WHERE tenant_id = ?', [T]);
  const [[{ activePolls }]] = await pool.query('SELECT COUNT(*) AS activePolls FROM polls WHERE tenant_id = ? AND status = "active"', [T]);
  const [[{ recognitions30d }]] = await pool.query('SELECT COUNT(*) AS recognitions30d FROM recognitions WHERE tenant_id = ? AND created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)', [T]);
  const [[{ openSuggestions }]] = await pool.query('SELECT COUNT(*) AS openSuggestions FROM suggestions WHERE tenant_id = ? AND status IN ("submitted","reviewing")', [T]);
  const [topRecognized] = await pool.query(
    `SELECT CONCAT(e.first_name, ' ', e.last_name) AS name, COUNT(*) AS total
     FROM recognitions rec JOIN employees e ON e.id = rec.to_employee_id
     WHERE rec.tenant_id = ? GROUP BY rec.to_employee_id ORDER BY total DESC LIMIT 5`,
    [T]
  );
  res.json({ data: { activeSurveys, surveyResponses, activePolls, recognitions30d, openSuggestions, topRecognized } });
}));

module.exports = r;
