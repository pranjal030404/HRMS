const express = require('express');
const { pool } = require('../config/db');
const { asyncH, HttpError } = require('../utils/helpers');
const { authenticate, requirePermission } = require('../middleware/auth');
const { logAudit } = require('../services/audit');
const { actionTask, startRun } = require('../services/workflow');

const r = express.Router();
r.use(authenticate);

// ---- Workflow definitions ----
r.get('/', requirePermission('workflow.view'), asyncH(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT w.*, u.name AS created_by_name,
            (SELECT COUNT(*) FROM workflow_runs wr WHERE wr.workflow_id = w.id) AS run_count
     FROM workflows w LEFT JOIN users u ON u.id = w.created_by
     WHERE w.tenant_id = ? ORDER BY w.trigger_event, w.name LIMIT 200`,
    [req.user.tenant_id]
  );
  res.json({ data: rows.map((x) => ({ ...x, steps: typeof x.steps === 'string' ? JSON.parse(x.steps) : x.steps, conditions: typeof x.conditions === 'string' ? JSON.parse(x.conditions) : x.conditions })) });
}));

r.post('/', requirePermission('workflow.manage'), asyncH(async (req, res) => {
  const { name, triggerEvent, entityType, conditions, steps, active } = req.body || {};
  if (!name || !triggerEvent) throw new HttpError(400, 'name and triggerEvent required');
  if (!Array.isArray(steps) || !steps.length) throw new HttpError(400, 'At least one step required');
  for (const s of steps) if (!s.name || !s.assignee) throw new HttpError(400, 'Each step needs name and assignee');
  const [ins] = await pool.query(
    `INSERT INTO workflows (tenant_id, name, trigger_event, entity_type, conditions, steps, active, created_by)
     VALUES (?,?,?,?,?,?,?,?)`,
    [req.user.tenant_id, name, triggerEvent, entityType || null,
      conditions ? JSON.stringify(conditions) : null, JSON.stringify(steps), active === false ? 0 : 1, req.user.id]
  );
  await logAudit({ tenantId: req.user.tenant_id, actor: req.user, action: 'workflow.create', entityType: 'workflow', entityId: ins.insertId, after: req.body, req });
  res.status(201).json({ data: { id: ins.insertId } });
}));

r.put('/:id', requirePermission('workflow.manage'), asyncH(async (req, res) => {
  const [before] = await pool.query('SELECT * FROM workflows WHERE id = ? AND tenant_id = ?', [req.params.id, req.user.tenant_id]);
  if (!before[0]) throw new HttpError(404, 'Workflow not found');
  const { name, triggerEvent, entityType, conditions, steps, active } = req.body || {};
  await pool.query(
    `UPDATE workflows SET name = COALESCE(?, name), trigger_event = COALESCE(?, trigger_event), entity_type = COALESCE(?, entity_type),
       conditions = ?, steps = COALESCE(?, steps), active = COALESCE(?, active), version = version + 1
     WHERE id = ? AND tenant_id = ?`,
    [name || null, triggerEvent || null, entityType || null,
      conditions === undefined ? before[0].conditions : JSON.stringify(conditions || []),
      steps ? JSON.stringify(steps) : before[0].steps,
      active === undefined ? before[0].active : (active ? 1 : 0),
      req.params.id, req.user.tenant_id]
  );
  await logAudit({ tenantId: req.user.tenant_id, actor: req.user, action: 'workflow.update', entityType: 'workflow', entityId: req.params.id, before: before[0], after: req.body, req });
  res.json({ ok: true });
}));

r.delete('/:id', requirePermission('workflow.manage'), asyncH(async (req, res) => {
  await pool.query('DELETE FROM workflows WHERE id = ? AND tenant_id = ?', [req.params.id, req.user.tenant_id]);
  res.json({ ok: true });
}));

// Manual run (demo/testing + scheduled manual workflows)
r.post('/:id/run', requirePermission('workflow.manage'), asyncH(async (req, res) => {
  const [wfs] = await pool.query('SELECT * FROM workflows WHERE id = ? AND tenant_id = ?', [req.params.id, req.user.tenant_id]);
  if (!wfs[0]) throw new HttpError(404, 'Workflow not found');
  const runId = await startRun({
    tenantId: req.user.tenant_id, workflow: wfs[0],
    entityType: req.body.entityType || wfs[0].entity_type || 'manual',
    entityId: req.body.entityId || 0,
    ctx: req.body.context || {},
  });
  await logAudit({ tenantId: req.user.tenant_id, actor: req.user, action: 'workflow.manual_run', entityType: 'workflow', entityId: req.params.id, after: { runId }, req });
  res.json({ data: { runId } });
}));

// ---- Runs ----
r.get('/runs', requirePermission('workflow.view'), asyncH(async (req, res) => {
  const params = [req.user.tenant_id];
  let where = 'wr.tenant_id = ?';
  if (req.query.workflow_id) { where += ' AND wr.workflow_id = ?'; params.push(req.query.workflow_id); }
  if (req.query.status) { where += ' AND wr.status = ?'; params.push(req.query.status); }
  const [rows] = await pool.query(
    `SELECT wr.*, w.name AS workflow_name
     FROM workflow_runs wr JOIN workflows w ON w.id = wr.workflow_id
     WHERE ${where} ORDER BY wr.started_at DESC LIMIT 200`,
    params
  );
  res.json({ data: rows.map((x) => ({ ...x, context: typeof x.context === 'string' ? JSON.parse(x.context) : x.context })) });
}));

// ---- My task inbox (approvals assigned to me or delegated to me) ----
r.get('/tasks/mine', asyncH(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT wt.*, wr.entity_type, wr.entity_id, wr.context, w.name AS workflow_name
     FROM workflow_tasks wt
     JOIN workflow_runs wr ON wr.id = wt.run_id
     JOIN workflows w ON w.id = wr.workflow_id
     WHERE wt.tenant_id = ? AND wt.status = 'pending' AND (wt.assignee_user_id = ? OR wt.delegated_to = ?)
     ORDER BY wt.due_at LIMIT 100`,
    [req.user.tenant_id, req.user.id, req.user.id]
  );
  res.json({ data: rows.map((x) => ({ ...x, context: typeof x.context === 'string' ? JSON.parse(x.context) : x.context })) });
}));

r.post('/tasks/:id/action', requirePermission('workflow.action'), asyncH(async (req, res) => {
  const { action, comment } = req.body || {}; // approved | rejected
  if (!['approved', 'rejected'].includes(action)) throw new HttpError(400, 'action must be approved or rejected');
  const result = await actionTask({ tenantId: req.user.tenant_id, taskId: req.params.id, user: req.user, action, comment });
  await logAudit({ tenantId: req.user.tenant_id, actor: req.user, action: `workflow.task.${action}`, entityType: 'workflow_task', entityId: req.params.id, after: { comment }, req });
  res.json({ data: result });
}));

// ---- Delegations & out-of-office ----
r.get('/delegations', asyncH(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT dg.*, u1.name AS from_name, u2.name AS to_name
     FROM approval_delegations dg
     JOIN users u1 ON u1.id = dg.from_user_id
     JOIN users u2 ON u2.id = dg.to_user_id
     WHERE dg.tenant_id = ? AND (dg.from_user_id = ? OR dg.to_user_id = ?)
     ORDER BY dg.starts_on DESC LIMIT 100`,
    [req.user.tenant_id, req.user.id, req.user.id]
  );
  res.json({ data: rows });
}));

r.post('/delegations', asyncH(async (req, res) => {
  const { toUserId, basePermission, startsOn, endsOn } = req.body || {};
  if (!toUserId || toUserId === req.user.id) throw new HttpError(400, 'toUserId required and must differ from you');
  if (!startsOn || !endsOn) throw new HttpError(400, 'startsOn and endsOn required');
  const [ins] = await pool.query(
    `INSERT INTO approval_delegations (tenant_id, from_user_id, to_user_id, base_permission, starts_on, ends_on, active)
     VALUES (?,?,?,?,?,?,1)`,
    [req.user.tenant_id, req.user.id, toUserId, basePermission || null, startsOn, endsOn]
  );
  res.status(201).json({ data: { id: ins.insertId } });
}));

r.delete('/delegations/:id', asyncH(async (req, res) => {
  await pool.query('DELETE FROM approval_delegations WHERE id = ? AND from_user_id = ? AND tenant_id = ?', [req.params.id, req.user.id, req.user.tenant_id]);
  res.json({ ok: true });
}));

module.exports = r;
