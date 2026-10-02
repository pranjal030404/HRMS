/**
 * Workflow Configuration — approval chains, SLA clocks and versions.
 *
 * The existing `/api/workflows` routes and the sequential engine in
 * `services/workflow` keep executing work; this router manages *how* approval is
 * defined: steps, conditional routing, SLA escalation, version history and
 * approval with rollback.
 */
const express = require('express');
const { pool } = require('../../config/db');
const { asyncH, HttpError } = require('../../utils/helpers');
const { requirePermission } = require('../../middleware/auth');
const { tenantId, writeTenantId, audit, int, decode, j, unj } = require('./_shared');

const r = express.Router();

const READ = requirePermission('administration.workflows.view', { anyOf: ['workflow.manage', 'settings.view'] });
const WRITE = requirePermission('administration.workflows.manage', { anyOf: ['workflow.manage', 'settings.manage'] });
const APPROVE = requirePermission('administration.workflows.approve', { anyOf: ['workflow.manage'] });

r.get('/workflows', READ, asyncH(async (req, res) => {
  const t = tenantId(req);
  const [rows] = await pool.query(
    `SELECT w.id, w.name, w.description, w.trigger_event, w.entity_type, w.active, w.status, w.version,
            w.published_at, w.updated_at,
            (SELECT COUNT(*) FROM workflow_sla_rules s WHERE s.workflow_id = w.id AND s.active = 1) AS sla_count,
            (SELECT MAX(v.version) FROM workflow_versions v WHERE v.workflow_id = w.id) AS latest_version
     FROM workflows w WHERE w.tenant_id = ? ORDER BY w.name`, [t]
  );
  res.json({ data: decode(rows, []), meta: { entityTypes: [...new Set(rows.map((x) => x.entity_type).filter(Boolean))] } });
}));

r.get('/workflows/:id', READ, asyncH(async (req, res) => {
  const t = tenantId(req);
  const [rows] = await pool.query('SELECT * FROM workflows WHERE id = ? AND tenant_id = ?', [int(req.params.id), t]);
  if (!rows[0]) throw new HttpError(404, 'Workflow not found');
  const workflow = decode(rows[0], ['conditions', 'steps']);
  const [sla] = await pool.query('SELECT * FROM workflow_sla_rules WHERE workflow_id = ? AND (tenant_id = ? OR tenant_id IS NULL) ORDER BY sla_hours', [workflow.id, t]);
  const [versions] = await pool.query(
    'SELECT id, version, status, change_note, created_by, created_at FROM workflow_versions WHERE workflow_id = ? ORDER BY version DESC LIMIT 20', [workflow.id]
  );
  const [instances] = await pool.query(
    `SELECT status, COUNT(*) AS c FROM approval_requests WHERE tenant_id = ? AND workflow_id = ? GROUP BY status`,
    [t, workflow.id]
  ).catch(() => [[]]);
  res.json({ data: { ...workflow, slaRules: sla, versions, instanceStats: Object.fromEntries(instances.map((i) => [i.status, Number(i.c)])) } });
}));

/**
 * PUT /workflows/:id/steps
 * Rewrites the approval chain. A new step shape replaces the legacy JSON blob and
 * is written back into `workflows.steps`, so the running engine sees it unchanged.
 */
r.put('/workflows/:id/steps', WRITE, asyncH(async (req, res) => {
  const t = writeTenantId(req);
  const [rows] = await pool.query('SELECT * FROM workflows WHERE id = ? AND tenant_id = ?', [int(req.params.id), t]);
  if (!rows[0]) throw new HttpError(404, 'Workflow not found');
  const { steps } = req.body || {};
  if (!Array.isArray(steps) || !steps.length) throw new HttpError(400, 'steps[] is required');
  const normalised = steps.map((s, i) => ({
    name: s.name || `Step ${i + 1}`,
    role: s.role || null,
    approver: s.approver ?? null,
    sla_hours: s.sla_hours === undefined || s.sla_hours === null || s.sla_hours === '' ? null : Number(s.sla_hours),
    condition: s.condition ?? null,
    optional: !!s.optional,
  }));
  await pool.query('UPDATE workflows SET steps = ?, updated_by = ?, updated_at = NOW() WHERE id = ? AND tenant_id = ?',
    [JSON.stringify(normalised), req.user.id, rows[0].id, t]);
  await snapshotWorkflow(t, rows[0].id, req.user, 'Steps updated');
  await audit(req, { action: 'workflow.steps.update', entityType: 'workflow', entityId: rows[0].id, before: decode(rows[0], ['steps']), after: normalised });
  res.json({ ok: true, data: { steps: normalised } });
}));

r.post('/workflows/:id/publish', WRITE, asyncH(async (req, res) => {
  const t = writeTenantId(req);
  const [rows] = await pool.query('SELECT * FROM workflows WHERE id = ? AND tenant_id = ?', [int(req.params.id), t]);
  if (!rows[0]) throw new HttpError(404, 'Workflow not found');
  const steps = unj(rows[0].steps, []) || [];
  if (!steps.length) throw new HttpError(400, 'Add at least one step before publishing');
  const version = Number(rows[0].version || 0) + 1;
  await pool.query(
    `UPDATE workflows SET status = 'published', active = 1, version = ?, published_at = NOW(), updated_by = ?, updated_at = NOW()
     WHERE id = ? AND tenant_id = ?`, [version, req.user.id, rows[0].id, t]
  );
  await pool.query(
    `INSERT INTO workflow_versions (tenant_id, workflow_id, version, snapshot, status, change_note, created_by)
     VALUES (?,?,?,?,'published',?,?)`,
    [t, rows[0].id, version, JSON.stringify(decode(rows[0], ['conditions', 'steps'])), req.body?.note || null, req.user.id]
  );
  await audit(req, { action: 'workflow.publish', entityType: 'workflow', entityId: rows[0].id, after: { version } });
  res.json({ ok: true, data: { version } });
}));

r.post('/workflows/:id/rollback', APPROVE, asyncH(async (req, res) => {
  const t = writeTenantId(req);
  const [rows] = await pool.query('SELECT * FROM workflows WHERE id = ? AND tenant_id = ?', [int(req.params.id), t]);
  if (!rows[0]) throw new HttpError(404, 'Workflow not found');
  const version = int(req.body?.version);
  if (!version) throw new HttpError(400, 'version is required');
  const [vers] = await pool.query('SELECT * FROM workflow_versions WHERE workflow_id = ? AND version = ?', [rows[0].id, version]);
  if (!vers[0]) throw new HttpError(404, 'That version does not exist');
  const snap = unj(vers[0].snapshot, {}) || {};
  const nextVersion = Number(rows[0].version || 0) + 1;
  await pool.query(
    `UPDATE workflows SET name = ?, description = ?, trigger_event = ?, entity_type = ?, conditions = ?, steps = ?,
       version = ?, status = 'published', updated_by = ?, updated_at = NOW() WHERE id = ? AND tenant_id = ?`,
    [snap.name ?? rows[0].name, snap.description ?? null, snap.trigger_event ?? null, snap.entity_type ?? null,
      j(snap.conditions ?? null), j(snap.steps ?? []), nextVersion, req.user.id, rows[0].id, t]
  );
  await pool.query(
    `INSERT INTO workflow_versions (tenant_id, workflow_id, version, snapshot, status, change_note, created_by)
     VALUES (?,?,?,?,'published',?,?)`,
    [t, rows[0].id, nextVersion, JSON.stringify(decode(rows[0], ['conditions', 'steps'])), `Rollback to v${version}`, req.user.id]
  );
  await audit(req, { action: 'workflow.rollback', entityType: 'workflow', entityId: rows[0].id, before: { version: rows[0].version }, after: { rolledBackTo: version, newVersion: nextVersion } });
  res.json({ ok: true, data: { version: nextVersion, rolledBackTo: version } });
}));

r.get('/workflows/:id/versions', READ, asyncH(async (req, res) => {
  const t = tenantId(req);
  const [rows] = await pool.query(
    'SELECT id, version, status, change_note, created_at, published_at FROM workflow_versions WHERE workflow_id = ? AND tenant_id = ? ORDER BY version DESC',
    [int(req.params.id), t]
  );
  res.json({ data: rows });
}));

async function snapshotWorkflow(tenant, workflowId, actor, note) {
  const [rows] = await pool.query('SELECT * FROM workflows WHERE id = ?', [workflowId]);
  if (!rows[0]) return;
  const version = Number(rows[0].version || 0) + 1;
  await pool.query(
    `INSERT INTO workflow_versions (tenant_id, workflow_id, version, snapshot, status, change_note, created_by)
     VALUES (?,?,?,?, 'draft', ?, ?)`,
    [tenant, workflowId, version, JSON.stringify(decode(rows[0], ['conditions', 'steps'])), note, actor.id]
  );
}

// ------------------------------------------------------- approval rules
r.get('/approval-rules', READ, asyncH(async (req, res) => {
  const t = tenantId(req);
  const [rows] = await pool.query(
    'SELECT * FROM workflow_approval_rules WHERE tenant_id = ? ORDER BY is_system DESC, name', [t]
  );
  res.json({ data: decode(rows, ['conditions', 'steps']) });
}));

r.post('/approval-rules', WRITE, asyncH(async (req, res) => {
  const t = writeTenantId(req);
  const { name, description, entity_type: entityType, conditions = [], steps = [] } = req.body || {};
  if (!name) throw new HttpError(400, 'A rule name is required');
  if (!Array.isArray(steps) || !steps.length) throw new HttpError(400, 'steps[] is required');
  const [ins] = await pool.query(
    `INSERT INTO workflow_approval_rules (tenant_id, name, description, entity_type, conditions, steps, is_system, status, created_by)
     VALUES (?,?,?,?,?,?,0,'active',?)`,
    [t, name, description || null, entityType || null, JSON.stringify(conditions), JSON.stringify(steps), req.user.id]
  );
  await audit(req, { action: 'approval_rule.create', entityType: 'workflow', entityId: ins.insertId, after: { name } });
  res.status(201).json({ data: { id: ins.insertId } });
}));

r.put('/approval-rules/:id', WRITE, asyncH(async (req, res) => {
  const t = writeTenantId(req);
  const [rows] = await pool.query('SELECT * FROM workflow_approval_rules WHERE id = ? AND tenant_id = ?', [int(req.params.id), t]);
  if (!rows[0]) throw new HttpError(404, 'Approval rule not found');
  if (rows[0].is_system) throw new HttpError(403, 'System approval rules cannot be edited');
  const { name, description, entity_type: entityType, conditions, steps, status } = req.body || {};
  const sets = []; const params = [];
  if (name) { sets.push('name = ?'); params.push(name); }
  if (description !== undefined) { sets.push('description = ?'); params.push(description); }
  if (entityType !== undefined) { sets.push('entity_type = ?'); params.push(entityType); }
  if (Array.isArray(conditions)) { sets.push('conditions = ?'); params.push(JSON.stringify(conditions)); }
  if (Array.isArray(steps)) {
    const cleaned = steps.map((s, i) => (typeof s === 'string' ? { name: s, role: s } : { name: s.name || `Step ${i + 1}`, ...s }));
    sets.push('steps = ?'); params.push(JSON.stringify(cleaned));
  }
  if (status) { sets.push('status = ?'); params.push(status); }
  if (!sets.length) throw new HttpError(400, 'Nothing to update');
  params.push(rows[0].id, t);
  await pool.query(`UPDATE workflow_approval_rules SET ${sets.join(', ')}, updated_at = NOW() WHERE id = ? AND tenant_id = ?`, params);
  await audit(req, { action: 'approval_rule.update', entityType: 'workflow', entityId: rows[0].id, before: decode(rows[0], ['conditions', 'steps']), after: req.body });
  res.json({ ok: true });
}));

r.delete('/approval-rules/:id', WRITE, asyncH(async (req, res) => {
  const t = writeTenantId(req);
  const [rows] = await pool.query('SELECT * FROM workflow_approval_rules WHERE id = ? AND tenant_id = ?', [int(req.params.id), t]);
  if (!rows[0]) throw new HttpError(404, 'Approval rule not found');
  if (rows[0].is_system) throw new HttpError(403, 'System approval rules cannot be deleted');
  await pool.query('DELETE FROM workflow_approval_rules WHERE id = ? AND tenant_id = ?', [rows[0].id, t]);
  await audit(req, { action: 'approval_rule.delete', entityType: 'workflow', entityId: rows[0].id, before: rows[0] });
  res.json({ ok: true });
}));

// ------------------------------------------------------- SLA rules
r.get('/workflows/:id/sla', READ, asyncH(async (req, res) => {
  const [rows] = await pool.query(
    'SELECT * FROM workflow_sla_rules WHERE workflow_id = ? AND (tenant_id = ? OR tenant_id IS NULL) ORDER BY sla_hours', [int(req.params.id), tenantId(req)]
  );
  res.json({ data: rows });
}));

r.post('/workflows/:id/sla', WRITE, asyncH(async (req, res) => {
  const t = writeTenantId(req);
  const { step_name: stepName, sla_hours: slaHours, remind_after_hours: remindAfter, escalate_to: escalateTo } = req.body || {};
  if (!stepName || !slaHours) throw new HttpError(400, 'step_name and sla_hours are required');
  const [wf] = await pool.query('SELECT id FROM workflows WHERE id = ? AND tenant_id = ?', [int(req.params.id), t]);
  if (!wf[0]) throw new HttpError(404, 'Workflow not found');
  const [ins] = await pool.query(
    `INSERT INTO workflow_sla_rules (tenant_id, workflow_id, step_name, sla_hours, remind_after_hours, escalate_to, active)
     VALUES (?,?,?,?,?,?,1)`,
    [t, int(req.params.id), stepName, int(slaHours), int(remindAfter) || null, int(escalateTo) || null]
  );
  await audit(req, { action: 'workflow.sla.create', entityType: 'workflow', entityId: req.params.id, after: { stepName, slaHours } });
  res.status(201).json({ data: { id: ins.insertId } });
}));

r.put('/workflows/sla/:slaId', WRITE, asyncH(async (req, res) => {
  const t = writeTenantId(req);
  const [rows] = await pool.query('SELECT * FROM workflow_sla_rules WHERE id = ? AND tenant_id = ?', [int(req.params.slaId), t]);
  if (!rows[0]) throw new HttpError(404, 'SLA rule not found');
  const { sla_hours: slaHours, remind_after_hours: remindAfter, escalate_to: escalateTo, active } = req.body || {};
  const sets = []; const params = [];
  if (slaHours !== undefined) { sets.push('sla_hours = ?'); params.push(int(slaHours)); }
  if (remindAfter !== undefined) { sets.push('remind_after_hours = ?'); params.push(int(remindAfter)); }
  if (escalateTo !== undefined) { sets.push('escalate_to = ?'); params.push(int(escalateTo)); }
  if (active !== undefined) { sets.push('active = ?'); params.push(active ? 1 : 0); }
  if (!sets.length) throw new HttpError(400, 'Nothing to update');
  params.push(rows[0].id, t);
  await pool.query(`UPDATE workflow_sla_rules SET ${sets.join(', ')} WHERE id = ? AND tenant_id = ?`, params);
  await audit(req, { action: 'workflow.sla.update', entityType: 'workflow', entityId: rows[0].workflow_id, before: rows[0], after: req.body });
  res.json({ ok: true });
}));

r.delete('/workflows/sla/:slaId', WRITE, asyncH(async (req, res) => {
  const t = writeTenantId(req);
  const [rows] = await pool.query('SELECT * FROM workflow_sla_rules WHERE id = ? AND tenant_id = ?', [int(req.params.slaId), t]);
  if (!rows[0]) throw new HttpError(404, 'SLA rule not found');
  await pool.query('DELETE FROM workflow_sla_rules WHERE id = ? AND tenant_id = ?', [rows[0].id, t]);
  await audit(req, { action: 'workflow.sla.delete', entityType: 'workflow', entityId: rows[0].workflow_id, before: rows[0] });
  res.json({ ok: true });
}));

// ------------------------------------------------------- in-flight impact
/**
 * GET /workflows/:id/impact
 * What a republish would do to approvals already in progress — the check that
 * makes publishing a configuration change safe.
 */
r.get('/workflows/:id/impact', READ, asyncH(async (req, res) => {
  const t = tenantId(req);
  const workflowId = int(req.params.id);
  const [rows] = await pool.query(
    `SELECT ar.status, COUNT(*) AS c FROM approval_requests ar
     WHERE ar.tenant_id = ? AND ar.workflow_id = ? GROUP BY ar.status`, [t, workflowId]
  ).catch(() => [[]]);
  const inFlight = rows.filter((x) => ['pending', 'in_progress'].includes(x.status)).reduce((n, x) => n + Number(x.c), 0);
  const [versions] = await pool.query('SELECT MAX(version) AS v FROM workflow_versions WHERE workflow_id = ?', [workflowId]);
  res.json({
    data: {
      workflowId,
      version: Number(versions[0].v || 0),
      inFlight,
      byStatus: Object.fromEntries(rows.map((x) => [x.status, Number(x.c)])),
      warning: inFlight > 0
        ? `${inFlight} approval(s) are still in progress; they keep the version they started on.`
        : 'No approvals are in progress — a publish takes effect immediately.',
    },
  });
}));

module.exports = r;
