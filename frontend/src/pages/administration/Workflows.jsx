import React, { useState } from 'react';
import { api, errMsg, fmtDate } from '../../api';
import { useAuth } from '../../auth';
import DataTable from '../../components/DataTable';
import { Confirm, Empty, Modal, Spinner, StatusBadge, Tabs, TextField, useToast } from '../../components/ui';
import { AdminSection, PageHeader, listLoader, num, useLoader } from './shared';

export default function AdminWorkflows() {
  return (
    <AdminSection sectionKey="workflows">
      <Workflows />
    </AdminSection>
  );
}

function Workflows() {
  const [tab, setTab] = useState('workflows');
  return (
    <div>
      <PageHeader
        title="Workflows"
        sub="Approval chains, SLA timers and the rules that route a request to the right approver."
      />
      <Tabs
        tabs={[
          { key: 'workflows', label: 'Workflows' },
          { key: 'rules', label: 'Approval rules' },
        ]}
        active={tab}
        onChange={setTab}
      />
      {tab === 'workflows' && <WorkflowList />}
      {tab === 'rules' && <ApprovalRules />}
    </div>
  );
}

function WorkflowList() {
  const { can } = useAuth();
  const toast = useToast();
  const { data, loading, reload } = useLoader(listLoader('/administration/workflows'), []);
  const [open, setOpen] = useState(null);
  const canManage = can('administration.workflows.manage');

  const publish = async (wf) => {
    try {
      const { data: d } = await api.post(`/administration/workflows/${wf.id}/publish`);
      toast(`Published as v${d.data?.version}`);
      reload();
    } catch (e) { toast(errMsg(e), true); }
  };

  return (
    <>
      <DataTable
        rows={data}
        loading={loading}
        onRowClick={(row) => setOpen(row.id)}
        columns={[
          { key: 'name', label: 'Workflow' },
          { key: 'entity_type', label: 'Applies to' },
          { key: 'trigger_event', label: 'Trigger', render: (r) => <code style={{ fontSize: 12 }}>{r.trigger_event || '—'}</code> },
          { key: 'active', label: 'Active', render: (r) => <span className={'badge ' + (Number(r.active) ? 'green' : 'gray')}>{Number(r.active) ? 'on' : 'off'}</span> },
          { key: 'status', label: 'Status', render: (r) => <StatusBadge value={r.status} /> },
          { key: 'version', label: 'Version', align: 'right', render: (r) => `v${r.version ?? r.latest_version ?? '—'}` },
          { key: 'sla_count', label: 'SLA rules', align: 'right', render: (r) => num(r.sla_count) },
          { key: 'published_at', label: 'Published', render: (r) => (r.published_at ? fmtDate(r.published_at) : '—') },
        ]}
        actions={(row) => (canManage
          ? <button className="btn ghost sm" onClick={() => publish(row)}>Publish</button>
          : null)}
      />

      {open && <WorkflowDetail id={open} canManage={canManage} onClose={() => setOpen(null)} onChanged={() => { setOpen(null); reload(); }} />}
    </>
  );
}

function WorkflowDetail({ id, canManage, onClose, onChanged }) {
  const toast = useToast();
  const { data, loading, reload } = useLoader(
    async () => (await api.get(`/administration/workflows/${id}`)).data.data,
    [id]
  );
  const [impact, setImpact] = useState(null);
  const [restoring, setRestoring] = useState(null);

  // `/workflows/:id/steps` is a *version restore*, not a free-form editor: it takes
  // a workflow_versions.id and republishes that snapshot as a new version.
  const restore = async (version) => {
    try {
      const { data: d } = await api.post(`/administration/workflows/${id}/rollback`, { version });
      toast(`Restored v${version} as v${d.data?.version}`);
      setRestoring(null);
      reload();
    } catch (e) { toast(errMsg(e), true); }
  };

  const loadImpact = async () => {
    try {
      const { data: d } = await api.get(`/administration/workflows/${id}/impact`);
      setImpact(d.data);
    } catch (e) { toast(errMsg(e), true); }
  };

  return (
    <Modal title={data?.name || 'Workflow'} onClose={onClose} wide>
      {loading && !data ? <Spinner /> : !data ? <Empty /> : (
        <>
          <div className="row wrap mb" style={{ gap: 6 }}>
            <span className="badge blue">{data.entity_type || 'general'}</span>
            <StatusBadge value={data.status} />
            <span className="badge gray">v{data.version}</span>
            <span className="badge purple">{num((data.steps || []).length)} steps</span>
            {Object.entries(data.instanceStats || {}).map(([k, v]) => (
              <span key={k} className="badge gray">{k}: {v}</span>
            ))}
          </div>
          {data.description && <p style={{ fontSize: 13, color: 'var(--muted)' }}>{data.description}</p>}

          <div className="spread mb">
            <b style={{ fontSize: 13.5 }}>Steps</b>
            {canManage && <button className="btn ghost sm" onClick={() => setRestoring(data.versions || [])}>Restore a version</button>}
          </div>
          <div className="table-wrap">
            <table className="tbl">
              <thead><tr><th>#</th><th>Step</th><th>Approver rule</th></tr></thead>
              <tbody>
                {(data.steps || []).map((s, i) => (
                  <tr key={s.id ?? i}>
                    <td>{i + 1}</td>
                    <td>{s.name || s.title || `Step ${i + 1}`}</td>
                    <td><code style={{ fontSize: 12 }}>{s.approver_type || s.approver || '—'}</code>{s.sla_hours ? <span className="badge amber" style={{ marginLeft: 6 }}>{s.sla_hours}h</span> : null}</td>
                  </tr>
                ))}
                {!(data.steps || []).length && <tr><td colSpan={3} style={{ color: 'var(--muted)' }}>No steps defined</td></tr>}
              </tbody>
            </table>
          </div>

          {(data.slaRules || []).length > 0 && (
            <>
              <b style={{ fontSize: 13.5, display: 'block', marginTop: 14 }}>SLA timers</b>
              <div className="row wrap" style={{ gap: 6, marginTop: 6 }}>
                {data.slaRules.map((s) => <span key={s.id} className="badge amber">{s.sla_hours}h {s.action}</span>)}
              </div>
            </>
          )}

          <div className="row mt">
            <button className="btn secondary sm" onClick={loadImpact}>Check impact before publishing</button>
          </div>

          {impact && (
            <div className="info-box mt">
              <b>Current version v{impact.version} — {num(impact.inFlight)} approval(s) in flight</b>
              <p style={{ margin: '6px 0 0' }}>{impact.warning}</p>
            </div>
          )}

          {restoring && (
            <Modal title="Restore a version" onClose={() => setRestoring(null)}>
              <div className="info-box">Restoring republishes an old snapshot as a new version. Nothing is deleted.</div>
              <div className="table-wrap">
                <table className="tbl">
                  <thead><tr><th>Version</th><th>Status</th><th>Note</th><th>When</th><th></th></tr></thead>
                  <tbody>
                    {restoring.map((v) => (
                      <tr key={v.id}>
                        <td>v{v.version}</td>
                        <td><StatusBadge value={v.status} /></td>
                        <td>{v.change_note || '—'}</td>
                        <td>{fmtDate(v.created_at, true)}</td>
                        <td className="actions">
                          {canManage && v.version !== data.version && (
                            <button className="btn sm" onClick={() => restore(v.version)}>Restore</button>
                          )}
                        </td>
                      </tr>
                    ))}
                    {!restoring.length && <tr><td colSpan={5} style={{ color: 'var(--muted)' }}>No versions recorded</td></tr>}
                  </tbody>
                </table>
              </div>
            </Modal>
          )}
        </>
      )}
    </Modal>
  );
}

function ApprovalRules() {
  const { can } = useAuth();
  const toast = useToast();
  const { data, loading, reload } = useLoader(listLoader('/administration/approval-rules'), []);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState(null);
  const canManage = can('administration.workflows.manage');

  const doDelete = async () => {
    try {
      await api.delete(`/administration/approval-rules/${deleting.id}`);
      toast('Rule deleted');
      setDeleting(null);
      reload();
    } catch (e) { toast(errMsg(e), true); }
  };

  return (
    <>
      <div className="row mb" style={{ justifyContent: 'flex-end' }}>
        {canManage && <button className="btn sm" onClick={() => setCreating(true)}>+ Create rule</button>}
      </div>
      <DataTable
        rows={data}
        loading={loading}
        columns={[
          { key: 'name', label: 'Rule' },
          { key: 'entity_type', label: 'Applies to' },
          { key: 'description', label: 'Description' },
          { key: 'steps', label: 'Steps', render: (r) => <span className="badge gray">{num((r.steps || []).length)}</span> },
          { key: 'is_system', label: 'Type', render: (r) => (r.is_system ? <span className="badge gray">system</span> : <span className="badge purple">custom</span>) },
          { key: 'status', label: 'Status', render: (r) => <StatusBadge value={r.status} /> },
        ]}
        actions={(row) => (canManage && !row.is_system ? <button className="btn ghost sm" style={{ color: 'var(--red)' }} onClick={() => setDeleting(row)}>Delete</button> : null)}
      />

      {creating && <CreateRule onClose={() => setCreating(false)} onDone={() => { setCreating(false); reload(); }} />}
      {deleting && <Confirm title="Delete rule?" message={`“${deleting.name}” will no longer route approvals.`} danger onYes={doDelete} onClose={() => setDeleting(null)} />}
    </>
  );
}

function CreateRule({ onClose, onDone }) {
  const toast = useToast();
  const [form, setForm] = useState({
    name: '', description: '', entity_type: 'leave', conditions: '[]',
    steps: JSON.stringify([{ name: 'Manager approval', approver: { type: 'reporting_manager' }, slaHours: 24, mandatory: true }], null, 2),
  });
  const submit = async () => {
    let conditions; let steps;
    try { conditions = JSON.parse(form.conditions || '[]'); steps = JSON.parse(form.steps || '[]'); }
    catch (_) { toast('Conditions and steps must be valid JSON', true); return; }
    if (!steps.length) { toast('Add at least one approval step', true); return; }
    try {
      await api.post('/administration/approval-rules', {
        name: form.name, description: form.description, entity_type: form.entity_type, conditions, steps,
      });
      toast('Rule created');
      onDone();
    } catch (e) { toast(errMsg(e), true); }
  };
  return (
    <Modal title="Create approval rule" onClose={onClose}
      footer={<><button className="btn secondary" onClick={onClose}>Cancel</button><button className="btn" onClick={submit} disabled={!form.name}>Create</button></>}>
      <div className="info-box">A rule routes a request to approvers by condition. Steps run in order; <code>approver.type</code> may be <code>reporting_manager</code>, <code>role</code>, <code>user</code> or <code>department_head</code>.</div>
      <div className="form-grid">
        <TextField label="Name" value={form.name} onChange={(v) => setForm((f) => ({ ...f, name: v }))} />
        <TextField label="Applies to" value={form.entity_type} onChange={(v) => setForm((f) => ({ ...f, entity_type: v }))} />
        <div style={{ gridColumn: '1 / -1' }}>
          <TextField label="Description" value={form.description} onChange={(v) => setForm((f) => ({ ...f, description: v }))} />
        </div>
        <div className="field">
          <label>Conditions (JSON array)</label>
          <textarea rows={4} value={form.conditions} onChange={(e) => setForm((f) => ({ ...f, conditions: e.target.value }))} />
        </div>
        <div className="field">
          <label>Steps (JSON array, at least one)</label>
          <textarea rows={8} value={form.steps} onChange={(e) => setForm((f) => ({ ...f, steps: e.target.value }))} />
        </div>
      </div>
    </Modal>
  );
}