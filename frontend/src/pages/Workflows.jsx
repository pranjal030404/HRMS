import React, { useEffect, useState } from 'react';
import { api, errMsg, fmtDate } from '../api';
import { useAuth } from '../auth';
import DataTable from '../components/DataTable';
import { Spinner, StatusBadge, useToast, Modal, TextField, SelectField, Tabs, Empty } from '../components/ui';

const TRIGGER_EVENTS = [
  ['leave.submitted', 'Leave submitted'], ['expense.submitted', 'Expense submitted'],
  ['travel.submitted', 'Travel request submitted'], ['hr_case.created', 'HR case created'],
  ['manual', 'Manual run only'],
];
const ASSIGNABLE_ROLES = ['hr_admin', 'payroll_admin', 'finance_admin', 'manager', 'department_head', 'company_owner'];

export default function Workflows() {
  const { can, me } = useAuth();
  const toast = useToast();
  const [tab, setTab] = useState('definitions');
  const [workflows, setWorkflows] = useState(null);
  const [runs, setRuns] = useState(null);
  const [tasks, setTasks] = useState(null);
  const [delegations, setDelegations] = useState(null);
  const [users, setUsers] = useState([]);
  const [modal, setModal] = useState(null);
  const [form, setForm] = useState({});

  const load = async () => {
    try {
      const reqs = [api.get('/workflows'), api.get('/workflows/runs'), api.get('/workflows/tasks/mine'), api.get('/workflows/delegations')];
      const [w, rn, tk, dg] = (await Promise.all(reqs)).map((x) => x.data.data);
      setWorkflows(w); setRuns(rn); setTasks(tk); setDelegations(dg);
      if (can('user.manage')) api.get('/admin/users').then(({ data }) => setUsers(data.data)).catch(() => {});
    } catch (e) { toast(errMsg(e), true); }
  };
  useEffect(() => { load(); }, []); // eslint-disable-line

  const saveWorkflow = async () => {
    try {
      const steps = [{ name: form.step1 || 'Manager approval', assignee: { type: form.assigneeType1 || 'manager', value: form.assigneeValue1 }, slaHours: Number(form.sla1 || 48) }];
      if (form.step2) steps.push({ name: form.step2, assignee: { type: form.assigneeType2 || 'role', value: form.assigneeValue2 || 'hr_admin' }, slaHours: Number(form.sla2 || 48) });
      const conditions = form.condField ? [{ field: form.condField, op: form.condOp || 'gte', value: form.condValue }] : [];
      await api.post('/workflows', { name: form.name, triggerEvent: form.triggerEvent || 'manual', entityType: form.entityType, conditions, steps, active: form.active !== false });
      toast('Workflow created'); setModal(null); setForm({}); load();
    } catch (e) { toast(errMsg(e), true); }
  };

  const toggleActive = async (w) => {
    try { await api.put(`/workflows/${w.id}`, { active: !w.active }); load(); } catch (e) { toast(errMsg(e), true); }
  };

  const runNow = async (w) => {
    try { await api.post(`/workflows/${w.id}/run`, {}); toast('Workflow run started — check Runs'); load(); } catch (e) { toast(errMsg(e), true); }
  };

  const actionTask = async (taskId, action) => {
    try {
      const comment = action === 'rejected' ? (prompt('Rejection comment (optional)') || '') : '';
      await api.post(`/workflows/tasks/${taskId}/action`, { action, comment });
      toast(`Task ${action}`); load();
    } catch (e) { toast(errMsg(e), true); }
  };

  const createDelegation = async () => {
    try {
      await api.post('/workflows/delegations', { toUserId: Number(form.toUserId), basePermission: form.basePermission || null, startsOn: form.startsOn, endsOn: form.endsOn });
      toast('Delegation created'); setModal(null); setForm({}); load();
    } catch (e) { toast(errMsg(e), true); }
  };

  if (!workflows || !tasks) return <Spinner />;
  const setF = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <>
      <div className="mt"><Tabs active={tab} onChange={setTab} tabs={[
        { key: 'definitions', label: 'Workflow Definitions' }, { key: 'mytasks', label: `My Tasks${tasks.length ? ` (${tasks.length})` : ''}` },
        { key: 'runs', label: 'Runs' }, { key: 'delegations', label: 'Delegations' },
      ]} /></div>

      {tab === 'definitions' && (
        <div className="card mt">
          <div className="card-h spread">
            <h3>Workflow & automation definitions</h3>
            {can('workflow.manage') && <button className="btn sm" onClick={() => setModal({ type: 'newWorkflow' })}>New workflow</button>}
          </div>
          <DataTable
            columns={[
              { key: 'name', label: 'Workflow', render: (r) => <><b>{r.name}</b><div style={{ fontSize: 12.5, color: 'var(--muted)' }}>v{r.version}</div></> },
              { key: 'trigger_event', label: 'Trigger', render: (r) => <span className="badge blue">{r.trigger_event}</span> },
              { key: 'conditions', label: 'Conditions', render: (r) => (r.conditions || []).length ? (r.conditions || []).map((c, i) => <span key={i} className="badge amber" style={{ marginRight: 4 }}>{c.field} {c.op} {String(c.value)}</span>) : '—' },
              { key: 'steps', label: 'Steps', render: (r) => (r.steps || []).map((s, i) => <span key={i} style={{ fontSize: 12.5, marginRight: 8 }}>{i + 1}. {s.name} <span style={{ color: 'var(--muted)' }}>({s.assignee?.type === 'manager' ? 'manager' : s.assignee?.value || s.assignee?.type})</span></span>) },
              { key: 'run_count', label: 'Runs', align: 'right' },
              { key: 'active', label: 'Active', render: (r) => r.active ? '✅' : '⏸️' },
            ]}
            rows={workflows}
            emptyText="No workflows defined"
            actions={(r) => can('workflow.manage') ? (
              <>
                <button className="btn ghost sm" onClick={() => runNow(r)}>Run</button>
                <button className="btn ghost sm" onClick={() => toggleActive(r)}>{r.active ? 'Pause' : 'Activate'}</button>
                <button className="btn ghost sm danger" onClick={async () => { await api.delete(`/workflows/${r.id}`); toast('Deleted'); load(); }}>Delete</button>
              </>
            ) : null}
          />
          <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: '8px 14px 14px' }}>
            Flow: Trigger → Conditions → Approval steps (sequential) → SLA due dates → Notification → Audit. Assignees resolve to users by role or the employee's manager at run time.
          </p>
        </div>
      )}

      {tab === 'mytasks' && (
        <div className="card mt">
          <div className="card-h"><h3>Approvals assigned to me</h3></div>
          {tasks.length === 0 && <Empty icon="✅" text="No pending approvals — inbox zero!" />}
          {tasks.map((t) => (
            <div key={t.id} className="spread" style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)' }}>
              <div>
                <b>{t.workflow_name}</b> · step: {t.step_name}
                <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>
                  {t.entity_type} #{t.entity_id} · due {fmtDate(t.due_at, true)}
                  {t.context?.employeeId ? ` · employee #${t.context.employeeId}` : ''}
                </div>
              </div>
              <div className="row" style={{ gap: 8 }}>
                <button className="btn sm" onClick={() => actionTask(t.id, 'approved')}>Approve</button>
                <button className="btn sm danger ghost" onClick={() => actionTask(t.id, 'rejected')}>Reject</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {tab === 'runs' && (
        <div className="card mt">
          <div className="card-h"><h3>Workflow runs</h3></div>
          <DataTable
            columns={[
              { key: 'workflow_name', label: 'Workflow' },
              { key: 'entity', label: 'Entity', render: (r) => `${r.entity_type} #${r.entity_id}` },
              { key: 'current_step', label: 'Current step', render: (r) => r.current_step || '—' },
              { key: 'status', label: 'Status', render: (r) => <StatusBadge value={r.status} /> },
              { key: 'started_at', label: 'Started', render: (r) => fmtDate(r.started_at, true) },
              { key: 'finished_at', label: 'Finished', render: (r) => r.finished_at ? fmtDate(r.finished_at, true) : '—' },
            ]}
            rows={runs}
            emptyText="No runs yet — triggers fire automatically when matching events occur"
          />
        </div>
      )}

      {tab === 'delegations' && (
        <div className="card mt">
          <div className="card-h spread">
            <h3>Approval delegations (out-of-office)</h3>
            <button className="btn sm" onClick={() => setModal({ type: 'newDelegation' })}>Delegate my approvals</button>
          </div>
          <DataTable
            columns={[
              { key: 'from_name', label: 'From' },
              { key: 'to_name', label: 'To' },
              { key: 'base_permission', label: 'Scope', render: (r) => r.base_permission || 'All approvals' },
              { key: 'window', label: 'Window', render: (r) => `${fmtDate(r.starts_on)} → ${fmtDate(r.ends_on)}` },
              { key: 'active', label: 'Active', render: (r) => r.active ? '✅' : '—' },
            ]}
            rows={delegations}
            emptyText="No delegations"
            actions={(r) => r.from_user_id === me?.id ? (
              <button className="btn ghost sm" onClick={async () => { await api.delete(`/workflows/delegations/${r.id}`); toast('Removed'); load(); }}>Revoke</button>
            ) : null}
          />
        </div>
      )}

      {modal?.type === 'newWorkflow' && (
        <Modal title="New workflow" onClose={() => setModal(null)} wide footer={<><button className="btn secondary" onClick={() => setModal(null)}>Cancel</button><button className="btn" onClick={saveWorkflow}>Create</button></>}>
          <TextField label="Name *" value={form.name} onChange={setF('name')} />
          <div className="row">
            <SelectField label="Trigger *" value={form.triggerEvent} onChange={setF('triggerEvent')} options={TRIGGER_EVENTS.map(([v, l]) => ({ value: v, label: l }))} />
            <TextField label="Entity type" value={form.entityType} onChange={setF('entityType')} placeholder="e.g. leave_request" />
          </div>
          <h4 style={{ margin: '10px 0 6px', fontSize: 13.5 }}>Condition (optional)</h4>
          <div className="row">
            <TextField label="Field" value={form.condField} onChange={setF('condField')} placeholder="e.g. days" />
            <SelectField label="Op" value={form.condOp} onChange={setF('condOp')} options={[
              { value: 'gte', label: '≥' }, { value: 'lte', label: '≤' }, { value: 'gt', label: '>' }, { value: 'lt', label: '<' },
              { value: 'eq', label: '=' }, { value: 'ne', label: '≠' }, { value: 'contains', label: 'contains' }, { value: 'not_empty', label: 'not empty' },
            ]} />
            <TextField label="Value" value={form.condValue} onChange={setF('condValue')} placeholder="3" />
          </div>
          <h4 style={{ margin: '10px 0 6px', fontSize: 13.5 }}>Step 1 *</h4>
          <div className="row">
            <TextField label="Step name" value={form.step1} onChange={setF('step1')} placeholder="Manager approval" />
            <SelectField label="Assignee" value={form.assigneeType1} onChange={setF('assigneeType1')} options={[
              { value: 'manager', label: 'Employee\'s manager' },
              { value: 'role', label: 'Users with role…' },
              ...users.length ? [{ value: 'user', label: 'Specific user…' }] : [],
            ]} />
            {form.assigneeType1 === 'role' && <SelectField label="Role" value={form.assigneeValue1} onChange={setF('assigneeValue1')} options={ASSIGNABLE_ROLES.map((r) => ({ value: r, label: r.replace(/_/g, ' ') }))} />}
            {form.assigneeType1 === 'user' && <SelectField label="User" value={form.assigneeValue1} onChange={setF('assigneeValue1')} options={users.map((u) => ({ value: u.id, label: `${u.name} (${u.email})` }))} />}
          </div>
          <h4 style={{ margin: '10px 0 6px', fontSize: 13.5 }}>Step 2 (optional)</h4>
          <div className="row">
            <TextField label="Step name" value={form.step2} onChange={setF('step2')} placeholder="HR confirmation" />
            <SelectField label="Assignee" value={form.assigneeType2} onChange={setF('assigneeType2')} options={[
              { value: 'role', label: 'Users with role…' },
              { value: 'manager', label: 'Employee\'s manager' },
              ...users.length ? [{ value: 'user', label: 'Specific user…' }] : [],
            ]} />
            {form.assigneeType2 === 'role' && <SelectField label="Role" value={form.assigneeValue2} onChange={setF('assigneeValue2')} options={ASSIGNABLE_ROLES.map((r) => ({ value: r, label: r.replace(/_/g, ' ') }))} />}
            {form.assigneeType2 === 'user' && <SelectField label="User" value={form.assigneeValue2} onChange={setF('assigneeValue2')} options={users.map((u) => ({ value: u.id, label: `${u.name} (${u.email})` }))} />}
          </div>
        </Modal>
      )}

      {modal?.type === 'newDelegation' && (
        <Modal title="Delegate approvals" onClose={() => setModal(null)} footer={<><button className="btn secondary" onClick={() => setModal(null)}>Cancel</button><button className="btn" onClick={createDelegation}>Create</button></>}>
          <SelectField label="Delegate to *" value={form.toUserId} onChange={setF('toUserId')} options={users.filter((u) => u.id !== me?.id).map((u) => ({ value: u.id, label: `${u.name} (${u.email})` }))} />
          <div className="row">
            <TextField label="From *" type="date" value={form.startsOn} onChange={setF('startsOn')} />
            <TextField label="To *" type="date" value={form.endsOn} onChange={setF('endsOn')} />
          </div>
        </Modal>
      )}
    </>
  );
}
