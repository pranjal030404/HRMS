/**
 * Workflow & Automation engine (spec §7).
 * Flow: Trigger → Conditions → Approval/Task → SLA → Escalation → Action → Notification → Audit
 * Steps are sequential; each step creates a workflow_task for its resolved assignee.
 */
const { pool } = require('../config/db');
const { logAudit } = require('./audit');
const { notifyEvent } = require('./notify');

const OPS = {
  eq: (a, b) => String(a) === String(b),
  ne: (a, b) => String(a) !== String(b),
  gt: (a, b) => Number(a) > Number(b),
  gte: (a, b) => Number(a) >= Number(b),
  lt: (a, b) => Number(a) < Number(b),
  lte: (a, b) => Number(a) <= Number(b),
  in: (a, b) => String(b).split(',').map((s) => s.trim()).includes(String(a)),
  contains: (a, b) => String(a || '').toLowerCase().includes(String(b).toLowerCase()),
  not_empty: (a) => a !== null && a !== undefined && String(a).trim() !== '',
};

function evaluateConditions(conditions, ctx) {
  if (!Array.isArray(conditions) || !conditions.length) return true;
  for (const c of conditions) {
    if (!c || !c.field) continue;
    const actual = ctx[c.field];
    const op = OPS[c.op] || OPS.eq;
    if (c.op === 'not_empty') { if (!op(actual)) return false; continue; }
    if (!op(actual, c.value)) return false;
  }
  return true;
}

/** Resolve a step's assignee spec to user id(s). */
async function resolveAssignees(tenantId, spec, ctx) {
  if (!spec) return [];
  if (spec.type === 'user') return [Number(spec.value)].filter(Boolean);
  if (spec.type === 'role') {
    const [rows] = await pool.query(
      `SELECT id FROM users WHERE tenant_id = ? AND role = ? AND status = 'active' LIMIT 5`,
      [tenantId, spec.value]
    );
    return rows.map((r) => r.id);
  }
  if (spec.type === 'manager' && ctx.employeeId) {
    const [rows] = await pool.query(
      `SELECT u.id FROM employees e JOIN users u ON u.employee_id = e.id AND u.status = 'active'
       WHERE e.id = (SELECT manager_id FROM employees WHERE id = ?)`,
      [ctx.employeeId]
    );
    return rows.map((r) => r.id);
  }
  if (spec.type === 'self' && ctx.employeeId) {
    const [rows] = await pool.query(
      `SELECT u.id FROM users u WHERE u.employee_id = ? AND u.status = 'active'`,
      [ctx.employeeId]
    );
    return rows.map((r) => r.id);
  }
  return [];
}

/** Start a run for the given workflow if conditions match ctx. Returns run id or null. */
async function startRun({ tenantId, workflow, entityType, entityId, ctx }) {
  if (!evaluateConditions(workflow.conditions, ctx)) return null;
  const steps = typeof workflow.steps === 'string' ? JSON.parse(workflow.steps) : workflow.steps;
  if (!Array.isArray(steps) || !steps.length) return null;

  // Metered entitlement (spec §13, §14). A run that will actually execute is
  // charged; a trigger whose conditions did not match is not. The workflow is
  // still allowed to be *created* on a tenant that has run out — the cap governs
  // execution volume, not authoring, so `onExhausted: 'warn'` here would be wrong
  // and blocking below is the correct behaviour: an exhausted tenant simply stops
  // starting new approval chains and its existing ones continue to completion.
  const limits = require('./limits');
  await limits.assertWithinLimit({
    tenantId, entitlementKey: 'workflow.executions.month', incoming: 1,
    action: 'workflow.execute', onExhausted: 'block',
  });

  const [run] = await pool.query(
    `INSERT INTO workflow_runs (tenant_id, workflow_id, entity_type, entity_id, context, status, current_step)
     VALUES (?,?,?,?,?, 'running', ?)`,
    [tenantId, workflow.id, entityType, String(entityId), JSON.stringify(ctx || {}), steps[0].name]
  );
  await require('./usage').increment(tenantId, 'workflow.executions.month', 1, {
    source: 'workflow_run', referenceType: 'workflow_run', referenceId: run.insertId,
    metadata: { workflowId: workflow.id, entityType },
  }).catch((e) => console.error('[usage] workflow execution metering failed:', e.message));
  await createStepTasks({ tenantId, runId: run.insertId, step: steps[0], ctx });
  return run.insertId;
}

async function createStepTasks({ tenantId, runId, step, ctx }) {
  const assignees = await resolveAssignees(tenantId, step.assignee, ctx);
  const sla = Number(step.slaHours || 48);
  const due = new Date(Date.now() + sla * 3600 * 1000);
  for (const uid of assignees) {
    await pool.query(
      `INSERT INTO workflow_tasks (tenant_id, run_id, step_name, assignee_user_id, sla_hours, due_at)
       VALUES (?,?,?,?,?,?)`,
      [tenantId, runId, step.name, uid, sla, due]
    );
  }
  if (assignees.length) {
    await notifyEvent({
      tenantId,
      eventKey: 'workflow.task_assigned',
      vars: { title: `Approval needed: ${step.name}`, body: `Workflow step "${step.name}" requires your action.` },
      recipients: assignees.map((id) => ({ userId: id })),
      link: '/workflows?tab=My%20tasks',
    });
  }
  return assignees;
}

/** Fire trigger: run every active workflow bound to this event. Best-effort — never throws. */
async function fireTrigger({ tenantId, triggerEvent, entityType, entityId, ctx, req }) {
  try {
    const [workflows] = await pool.query(
      'SELECT * FROM workflows WHERE tenant_id = ? AND trigger_event = ? AND active = 1',
      [tenantId, triggerEvent]
    );
    const started = [];
    for (const wf of workflows) {
      const runId = await startRun({ tenantId, workflow: wf, entityType, entityId, ctx });
      if (runId) started.push({ workflowId: wf.id, runId });
    }
    if (req) {
      await logAudit({
        tenantId, actor: req.user, action: 'workflow.trigger',
        entityType, entityId: String(entityId),
        after: { triggerEvent, started }, req,
      });
    }
    return started;
  } catch (e) {
    console.error('[workflow] trigger failed:', triggerEvent, e.message);
    return [];
  }
}

/** Approve/reject a task; advances the run or completes/fails it. */
async function actionTask({ tenantId, taskId, user, action, comment }) {
  const [tasks] = await pool.query(
    'SELECT * FROM workflow_tasks WHERE id = ? AND tenant_id = ?',
    [taskId, tenantId]
  );
  const task = tasks[0];
  if (!task) throw Object.assign(new Error('Task not found'), { status: 404 });
  if (task.status !== 'pending') throw Object.assign(new Error('Task already actioned'), { status: 400 });

  // permission: assignee, delegated user, or workflow.manage
  const canManage = (user.permissions || []).includes('workflow.manage');
  const isAssignee = task.assignee_user_id === user.id || task.delegated_to === user.id;
  if (!isAssignee && !canManage) throw Object.assign(new Error('Not your task'), { status: 403 });

  await pool.query(
    `UPDATE workflow_tasks SET status = ?, comment = ?, actioned_at = NOW(), actioned_by = ? WHERE id = ?`,
    [action, comment || null, user.id, taskId]
  );

  const [runs] = await pool.query('SELECT * FROM workflow_runs WHERE id = ?', [task.run_id]);
  const run = runs[0];
  if (!run) return;
  const [wfs] = await pool.query('SELECT * FROM workflows WHERE id = ?', [run.workflow_id]);
  const wf = wfs[0];
  const steps = typeof wf.steps === 'string' ? JSON.parse(wf.steps) : wf.steps;
  const stepIdx = steps.findIndex((s) => s.name === task.step_name);

  if (action === 'rejected') {
    await pool.query(
      `UPDATE workflow_runs SET status = 'failed', finished_at = NOW(), current_step = NULL WHERE id = ?`,
      [task.run_id]
    );
    const ctx = safeParse(run.context);
    if (ctx.employeeId) {
      await notifyEvent({
        tenantId, eventKey: 'workflow.rejected',
        vars: { title: `Request rejected at "${task.step_name}"`, body: comment || 'Your request was rejected in the approval workflow.' },
        recipients: await usersForEmployee(tenantId, ctx.employeeId),
        link: '/portal',
      });
    }
    return { runStatus: 'failed' };
  }

  // approved → next step or complete
  const next = steps[stepIdx + 1];
  if (next) {
    const ctx = safeParse(run.context);
    await pool.query('UPDATE workflow_runs SET current_step = ? WHERE id = ?', [next.name, task.run_id]);
    const assignees = await createStepTasks({ tenantId, runId: task.run_id, step: next, ctx });
    if (!assignees.length) {
      await pool.query(
        `UPDATE workflow_runs SET status = 'completed', finished_at = NOW(), current_step = NULL WHERE id = ?`,
        [task.run_id]
      );
      return { runStatus: 'completed', note: `No assignee for step "${next.name}"` };
    }
    return { runStatus: 'running', nextStep: next.name };
  }
  await pool.query(
    `UPDATE workflow_runs SET status = 'completed', finished_at = NOW(), current_step = NULL WHERE id = ?`,
    [task.run_id]
  );
  const ctx = safeParse(run.context);
  if (ctx.employeeId) {
    await notifyEvent({
      tenantId, eventKey: 'workflow.completed',
      vars: { title: 'Request approved', body: `All approval steps for "${wf.name}" are complete.` },
      recipients: await usersForEmployee(tenantId, ctx.employeeId),
      link: '/portal',
    });
  }
  return { runStatus: 'completed' };
}

async function usersForEmployee(tenantId, employeeId) {
  const [rows] = await pool.query(
    `SELECT id FROM users WHERE employee_id = ? AND tenant_id = ? AND status = 'active'`,
    [employeeId, tenantId]
  );
  return rows.map((r) => ({ userId: r.id }));
}

const safeParse = (s) => { try { return typeof s === 'string' ? JSON.parse(s) : (s || {}); } catch { return {}; } };

module.exports = { fireTrigger, actionTask, evaluateConditions, startRun };
