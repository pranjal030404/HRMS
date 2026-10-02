import React, { useEffect, useState } from 'react';
import { api, errMsg, fmtDate } from '../api';
import { useAuth } from '../auth';
import DataTable from '../components/DataTable';
import { Spinner, StatusBadge, useToast, Modal, TextField, Tabs, StatCard, SelectField, downloadFile } from '../components/ui';

const downloadCsv = downloadFile;

// Monday of the week containing the given date string
const mondayOf = (d) => {
  const dt = new Date(`${d}T00:00:00`);
  const dow = dt.getDay(); // 0 = Sunday
  dt.setDate(dt.getDate() - (dow === 0 ? 6 : dow - 1));
  return dt.toISOString().slice(0, 10);
};
const addDays = (dateStr, n) => {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};
const fmtDay = (dateStr) =>
  new Date(`${dateStr}T00:00:00`).toLocaleDateString('en-IN', { weekday: 'short', day: '2-digit', month: 'short' });

const EMPTY_ROW = { date: '', projectId: null, hours: 8, task: '', billable: false };

export default function Timesheets() {
  const { can, me } = useAuth();
  const toast = useToast();
  const [tab, setTab] = useState(me?.employee_id ? 'my' : 'approvals');
  // The API keys a sheet by its Monday, so always anchor the picker to one.
  const [week, setWeek] = useState(() => mondayOf(new Date().toISOString().slice(0, 10)));
  const [mySheet, setMySheet] = useState(null);
  const [issues, setIssues] = useState([]);
  const [projects, setProjects] = useState([]);
  const [allSheets, setAllSheets] = useState(null);
  const [entries, setEntries] = useState([]);
  const [analytics, setAnalytics] = useState(null);
  const [groupBy, setGroupBy] = useState('employee');
  const [includeDraft, setIncludeDraft] = useState(false);
  const [modal, setModal] = useState(null);
  const [form, setForm] = useState({});
  const [busy, setBusy] = useState(false);

  const weekDays = Array.from({ length: 6 }, (_, i) => addDays(week, i)); // Mon–Sat

  const loadMy = async (w = week) => {
    try {
      const { data } = await api.get('/timesheets/my', { params: { week: w } });
      const sheet = data.data || {};
      setMySheet(sheet);
      setEntries((sheet.entries || []).map((e) => ({ ...EMPTY_ROW, ...e, projectId: e.projectId ?? null })));
      setIssues(sheet.issues || []);
    } catch (e) { toast(errMsg(e), true); }
  };

  const loadAnalytics = async () => {
    try {
      const { data } = await api.get('/timesheets/analytics', { params: { group_by: groupBy, include_draft: includeDraft ? 1 : undefined } });
      setAnalytics(data.data);
    } catch (e) { toast(errMsg(e), true); }
  };

  const load = async () => {
    try {
      const p = await api.get('/timesheets/projects');
      setProjects(p.data.data.filter((x) => x.status === 'active'));
      if (can('timesheet.view:team') || can('timesheet.view:company')) {
        const a = await api.get('/timesheets', { params: { all: 1 } });
        setAllSheets(a.data.data);
      }
      if (me?.employee_id) loadMy();
    } catch (e) { toast(errMsg(e), true); }
  };
  useEffect(() => { load(); }, []); // eslint-disable-line
  useEffect(() => { if (tab === 'analytics') loadAnalytics(); }, [tab, groupBy, includeDraft]); // eslint-disable-line

  // A sheet is read-only once approved (final) or once HR has locked the period.
  const readOnly = mySheet ? (mySheet.status === 'approved' || mySheet.status === 'submitted' || !!mySheet.locked) : false;
  const lockNote = mySheet?.locked ? 'Period locked by HR — read only.' : null;

  const addRow = () => setEntries((e) => [...e, { ...EMPTY_ROW, date: weekDays[0] }]);
  const setRow = (i, patch) => setEntries((e) => e.map((row, j) => (j === i ? { ...row, ...patch } : row)));
  const delRow = (i) => setEntries((e) => e.filter((_, j) => j !== i));
  const rowTotal = entries.reduce((a, e) => a + Number(e.hours || 0), 0);

  const save = async (submit = false) => {
    setBusy(true);
    try {
      const payload = {
        week,
        entries: entries
          .filter((e) => Number(e.hours) > 0 || e.projectId || e.task)
          .map((e) => ({ date: e.date, projectId: e.projectId, hours: Number(e.hours || 0), task: e.task || '', billable: !!e.billable })),
      };
      const { data } = await api.post('/timesheets/my', payload);
      const warn = (data.data?.issues || []).filter((i) => i.severity === 'warning');
      toast(warn.length ? `Saved with ${warn.length} warning(s)` : submit ? 'Timesheet submitted for approval' : 'Draft saved', warn.length > 0);
      if (submit) await api.post('/timesheets/my/submit', { week });
      await loadMy();
      if (tab === 'approvals') load();
    } catch (e) { toast(errMsg(e), true); }
    finally { setBusy(false); }
  };

  const action = async (id, act) => {
    try {
      const comment = act === 'rejected' ? (window.prompt('Reason for rejection (optional)') || '') : '';
      await api.put(`/timesheets/${id}/action`, { action: act, comment });
      toast(`Timesheet ${act}`); load();
    } catch (e) { toast(errMsg(e), true); }
  };

  const createProject = async () => {
    try {
      await api.post('/timesheets/projects', {
        name: form.name, code: form.code, client: form.client, billable: !!form.billable,
        billRate: form.billRate, costRate: form.costRate,
      });
      toast('Project created'); setModal(null); setForm({}); load();
    } catch (e) { toast(errMsg(e), true); }
  };

  if (!mySheet && me?.employee_id) return <Spinner />;
  const setF = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));
  const totalHours = entries.reduce((a, e) => a + Number(e.hours || 0), 0);
  const billableHours = entries.reduce((a, e) => a + (e.billable ? Number(e.hours || 0) : 0), 0);
  const canApprove = can('timesheet.approve');
  const canSeeAnalytics = can('timesheet.view:team') || can('timesheet.view:company');

  return (
    <>
      <div className="stat-grid mt">
        <StatCard label="Week" value={fmtDay(week)} sub={`→ ${fmtDay(addDays(week, 6))}`} />
        <StatCard label="Logged hours" value={totalHours} accent={rowTotal !== totalHours ? 'var(--warn)' : undefined} />
        <StatCard label="Billable hours" value={billableHours} sub={totalHours ? `${Math.round((billableHours / totalHours) * 100)}%` : ''} />
        <StatCard label="Status" value={mySheet ? mySheet.status : '—'} sub={mySheet?.locked ? 'period locked' : undefined} />
      </div>

      <div className="mt"><Tabs active={tab} onChange={setTab} tabs={[
        ...(me?.employee_id ? [{ key: 'my', label: 'My Timesheet' }] : []),
        ...(canApprove ? [{ key: 'approvals', label: 'Team Approvals' }] : []),
        ...(canSeeAnalytics ? [{ key: 'analytics', label: 'Analytics' }] : []),
        { key: 'projects', label: 'Projects' },
      ]} /></div>

      {tab === 'my' && me?.employee_id && (
        <div className="card mt">
          <div className="card-h spread">
            <div className="row" style={{ gap: 8 }}>
              <button className="btn ghost sm" onClick={() => { const w = addDays(week, -7); setWeek(w); loadMy(w); }}>← Prev</button>
              <input type="date" value={week} onChange={(e) => {
                const w = mondayOf(e.target.value); setWeek(w); loadMy(w);
              }} />
              <button className="btn ghost sm" onClick={() => { const w = addDays(week, 7); setWeek(w); loadMy(w); }}>Next →</button>
            </div>
            <div className="row" style={{ gap: 8 }}>
              {!readOnly && <button className="btn secondary sm" disabled={busy} onClick={() => save(false)}>Save draft</button>}
              {!readOnly && mySheet?.status !== 'submitted' && (
                <button className="btn sm" disabled={busy} onClick={() => save(true)}>Submit</button>
              )}
            </div>
          </div>

          {mySheet?.status === 'approved' && (
            <div style={{ padding: '8px 14px' }}>
              <StatusBadge value="approved" />{' '}
              <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>Approved — no further edits.</span>
            </div>
          )}
          {mySheet?.status === 'submitted' && (
            <div style={{ padding: '8px 14px' }}>
              <StatusBadge value="submitted" />{' '}
              <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>Awaiting approval.</span>
            </div>
          )}
          {mySheet?.status === 'rejected' && (
            <div style={{ padding: '8px 14px' }}>
              <StatusBadge value="rejected" />{' '}
              <span style={{ fontSize: 12.5 }}>{mySheet.approverComment || 'Rejected by approver'}</span>
            </div>
          )}
          {lockNote && (
            <div style={{ padding: '8px 14px' }}>
              <span className="badge amber">🔒 Locked</span>{' '}
              <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>{lockNote}</span>
            </div>
          )}

          {issues.length > 0 && (
            <div style={{ padding: '8px 14px', borderTop: '1px solid var(--border)' }}>
              {issues.map((i, n) => (
                <div key={n} style={{ fontSize: 12.5, marginBottom: 4, color: i.severity === 'error' ? 'var(--danger)' : 'var(--warn)' }}>
                  {i.severity === 'error' ? '✖' : '⚠'} {i.message}
                </div>
              ))}
            </div>
          )}

          <div className="table-wrap">
            <table className="tbl">
              <thead><tr><th>Date</th><th>Project</th><th>Task</th><th className="right">Hours</th><th>Billable</th><th></th></tr></thead>
              <tbody>
                {entries.length === 0 && (
                  <tr><td colSpan={6}><div className="empty" style={{ padding: 10 }}>No rows — add a project row to log hours.</div></td></tr>
                )}
                {entries.map((row, i) => {
                  const proj = projects.find((p) => p.id === row.projectId);
                  return (
                    <tr key={row.id ?? i}>
                      <td>
                        <select value={row.date || ''} disabled={readOnly} onChange={(e) => setRow(i, { date: e.target.value })}>
                          {weekDays.map((d) => <option key={d} value={d}>{fmtDay(d)}</option>)}
                        </select>
                      </td>
                      <td>
                        <select value={row.projectId || ''} disabled={readOnly} onChange={(e) => setRow(i, { projectId: Number(e.target.value) || null })}>
                          <option value="">— Project —</option>
                          {projects.map((p) => (
                            <option key={p.id} value={p.id}>{p.name}{p.billable ? ' (billable)' : ''}</option>
                          ))}
                        </select>
                      </td>
                      <td><input value={row.task || ''} disabled={readOnly} placeholder="What did you work on?" onChange={(e) => setRow(i, { task: e.target.value })} /></td>
                      <td className="right"><input type="number" step="0.5" min="0" max="24" style={{ width: 76, textAlign: 'right' }} value={row.hours ?? ''} disabled={readOnly} onChange={(e) => setRow(i, { hours: e.target.value === '' ? '' : Number(e.target.value) })} /></td>
                      <td><input type="checkbox" checked={!!row.billable} disabled={readOnly || proj?.billable === false} onChange={(e) => setRow(i, { billable: e.target.checked })} /></td>
                      <td>{!readOnly && <button className="btn ghost sm" onClick={() => delRow(i)}>✕</button>}</td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={3} style={{ textAlign: 'right', fontWeight: 600 }}>Total</td>
                  <td className="right" style={{ fontWeight: 700 }}>{totalHours}h</td>
                  <td colSpan={2}>{billableHours}h billable</td>
                </tr>
              </tfoot>
            </table>
          </div>
          {!readOnly && <button className="btn ghost sm" style={{ margin: '8px 14px' }} onClick={addRow}>+ Add row</button>}
        </div>
      )}

      {tab === 'approvals' && (
        <div className="card mt">
          <div className="card-h"><h3>Submitted timesheets</h3></div>
          <DataTable
            columns={[
              { key: 'employee_name', label: 'Employee', render: (r) => <><b>{r.employee_name}</b> <span style={{ color: 'var(--muted)' }}>{r.employee_code}</span></> },
              { key: 'week_start', label: 'Week of', render: (r) => fmtDate(r.week_start) },
              { key: 'total_hours', label: 'Hours', align: 'right', render: (r) => <b>{r.total_hours}</b> },
              { key: 'billable_hours', label: 'Billable', align: 'right', render: (r) => (r.billable_hours ? `${r.billable_hours}h` : '—') },
              { key: 'department_name', label: 'Department', render: (r) => r.department_name || '—' },
              { key: 'submitted_at', label: 'Submitted', render: (r) => (r.submitted_at ? fmtDate(r.submitted_at, true) : '—') },
              { key: 'status', label: 'Status', render: (r) => <StatusBadge value={r.status} /> },
            ]}
            rows={(allSheets || []).filter((r) => r.status === 'submitted')}
            emptyText="No timesheets awaiting approval"
            actions={(r) => (r.status === 'submitted' ? (
              <>
                <button className="btn sm" onClick={() => action(r.id, 'approved')}>Approve</button>
                <button className="btn sm danger ghost" onClick={() => action(r.id, 'rejected')}>Reject</button>
              </>
            ) : null)}
          />
        </div>
      )}

      {tab === 'analytics' && canSeeAnalytics && (
        <div className="card mt">
          <div className="card-h spread">
            <h3>Timesheet analytics</h3>
            <div className="row" style={{ gap: 8 }}>
              {can('timesheet.manage') && (
                <label className="check" style={{ fontSize: 12.5 }}>
                  <input type="checkbox" checked={includeDraft} onChange={(e) => setIncludeDraft(e.target.checked)} /> Include drafts
                </label>
              )}
              <SelectField value={groupBy} onChange={setGroupBy} options={[
                { value: 'employee', label: 'By employee' },
                { value: 'department', label: 'By department' },
                { value: 'project', label: 'By project' },
                { value: 'week', label: 'By week' },
              ]} />
              <button className="btn ghost sm" onClick={() => downloadCsv(`/api/timesheets/analytics?group_by=${groupBy}${includeDraft ? '&include_draft=1' : ''}&format=csv`, `timesheets-${groupBy}.csv`).catch((e) => toast(e.message, true))}>CSV</button>
            </div>
          </div>
          <div className="stat-grid">
            <StatCard label="Sheets" value={analytics?.totals?.sheets ?? 0} />
            <StatCard label="Employees" value={analytics?.totals?.employees ?? 0} />
            <StatCard label="Hours" value={analytics?.totals?.totalHours ?? 0} sub={`${analytics?.totals?.billableHours ?? 0}h billable`} />
            <StatCard label="Billable value" value={`₹${Number(analytics?.totals?.billableValue || 0).toLocaleString('en-IN')}`} sub={`margin ₹${Number(analytics?.totals?.margin || 0).toLocaleString('en-IN')}`} />
          </div>
          <DataTable
            columns={[
              { key: 'label', label: groupBy === 'week' ? 'Week' : groupBy === 'project' ? 'Project' : 'Name', render: (r) => <b>{r.label}</b> },
              { key: 'hours', label: 'Hours', align: 'right', render: (r) => <b>{r.hours ?? 0}h</b> },
              { key: 'billableHours', label: 'Billable', align: 'right', render: (r) => (r.billableHours != null ? `${r.billableHours}h` : '—') },
              { key: 'billablePct', label: 'Billable %', align: 'right', render: (r) => (r.billablePct != null ? `${r.billablePct}%` : '—') },
              { key: 'billableValue', label: 'Billable value', align: 'right', render: (r) => (r.billableValue ? `₹${Number(r.billableValue).toLocaleString('en-IN')}` : '—') },
              { key: 'costValue', label: 'Cost', align: 'right', render: (r) => (r.costValue ? `₹${Number(r.costValue).toLocaleString('en-IN')}` : '—') },
              { key: 'margin', label: 'Margin', align: 'right', render: (r) => (r.margin ? <span style={{ color: r.margin < 0 ? 'var(--danger)' : 'var(--success)' }}>₹{Number(r.margin).toLocaleString('en-IN')}</span> : '—') },
            ]}
            rows={analytics?.buckets || []}
            emptyText={includeDraft ? 'No timesheet data in range' : 'No approved timesheets in range — tick “Include drafts” to see pending time'}
          />
        </div>
      )}

      {tab === 'projects' && (
        <div className="card mt">
          <div className="card-h spread">
            <h3>Projects</h3>
            {can('timesheet.manage') && <button className="btn sm" onClick={() => setModal({ type: 'newProject' })}>New project</button>}
          </div>
          <DataTable
            columns={[
              { key: 'name', label: 'Project', render: (r) => <b>{r.name}</b> },
              { key: 'code', label: 'Code', render: (r) => r.code || '—' },
              { key: 'client', label: 'Client', render: (r) => r.client || 'Internal' },
              { key: 'billable', label: 'Billable', render: (r) => (r.billable ? '✅' : '—') },
              { key: 'bill_rate', label: 'Bill rate', align: 'right', render: (r) => (r.bill_rate ? `₹${Number(r.bill_rate).toLocaleString('en-IN')}/h` : '—') },
              { key: 'cost_rate', label: 'Cost rate', align: 'right', render: (r) => (r.cost_rate ? `₹${Number(r.cost_rate).toLocaleString('en-IN')}/h` : '—') },
              { key: 'member_count', label: 'Members', align: 'right', render: (r) => r.member_count ?? 0 },
              { key: 'hours_90d', label: 'Hours (90d)', align: 'right', render: (r) => (r.hours_90d != null ? `${r.hours_90d}h` : '—') },
              { key: 'status', label: 'Status', render: (r) => <StatusBadge value={r.status} /> },
            ]}
            rows={projects}
            emptyText="No projects yet"
          />
        </div>
      )}

      {modal?.type === 'newProject' && (
        <Modal title="New project" onClose={() => setModal(null)} footer={<><button className="btn secondary" onClick={() => setModal(null)}>Cancel</button><button className="btn" onClick={createProject}>Create</button></>}>
          <TextField label="Name *" value={form.name || ''} onChange={setF('name')} />
          <div className="row">
            <TextField label="Code" value={form.code || ''} onChange={setF('code')} />
            <TextField label="Client" value={form.client || ''} onChange={setF('client')} />
          </div>
          <div className="row">
            <TextField label="Bill rate (₹/h)" type="number" value={form.billRate || ''} onChange={setF('billRate')} />
            <TextField label="Cost rate (₹/h)" type="number" value={form.costRate || ''} onChange={setF('costRate')} />
          </div>
          <label className="check"><input type="checkbox" checked={!!form.billable} onChange={(e) => setF('billable')(e.target.checked)} /> Billable project</label>
        </Modal>
      )}
    </>
  );
}