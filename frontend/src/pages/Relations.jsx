import React, { useEffect, useState } from 'react';
import { api, errMsg, fmtDate } from '../api';
import { useAuth } from '../auth';
import DataTable from '../components/DataTable';
import { Spinner, StatusBadge, useToast, Modal, TextField, SelectField, Tabs, StatCard, Empty } from '../components/ui';

export default function Relations() {
  const { can } = useAuth();
  const toast = useToast();
  const [tab, setTab] = useState('cases');
  const [overview, setOverview] = useState(null);
  const [cases, setCases] = useState(null);
  const [disciplinary, setDisciplinary] = useState(null);
  const [emps, setEmps] = useState([]);
  const [detail, setDetail] = useState(null);
  const [modal, setModal] = useState(null);
  const [form, setForm] = useState({});

  const load = async () => {
    try {
      const [ov, cs, di] = await Promise.all([
        api.get('/relations/overview'), api.get('/relations/cases'), api.get('/relations/disciplinary'),
      ]);
      setOverview(ov.data.data); setCases(cs.data.data); setDisciplinary(di.data.data);
      if (can('relations.manage')) api.get('/employees?limit=200').then(({ data }) => setEmps(data.data)).catch(() => {});
    } catch (e) { toast(errMsg(e), true); }
  };
  useEffect(() => { load(); }, []); // eslint-disable-line

  const openDetail = async (c) => {
    try { const { data } = await api.get(`/relations/cases/${c.id}`); setDetail(data.data); } catch (e) { toast(errMsg(e), true); }
  };

  const createCase = async () => {
    try {
      await api.post('/relations/cases', { employeeId: Number(form.employeeId), category: form.category || 'grievance', title: form.title, description: form.description, severity: form.severity || 'medium' });
      toast('Case opened');
      setModal(null); setForm({}); load();
    } catch (e) { toast(errMsg(e), true); }
  };

  const addNote = async () => {
    try {
      await api.post(`/relations/cases/${detail.id}/notes`, { note: form.note, visibility: form.visibility });
      const { data } = await api.get(`/relations/cases/${detail.id}`);
      setDetail(data.data); setForm((f) => ({ ...f, note: '' }));
      toast('Note added');
    } catch (e) { toast(errMsg(e), true); }
  };

  const resolveCase = async () => {
    try {
      await api.put(`/relations/cases/${detail.id}`, { status: 'resolved', resolution: form.resolution });
      toast('Case resolved');
      setDetail(null); load();
    } catch (e) { toast(errMsg(e), true); }
  };

  const createDisciplinary = async () => {
    try {
      await api.post('/relations/disciplinary', { employeeId: Number(form.employeeId), caseId: form.caseId ? Number(form.caseId) : null, actionType: form.actionType || 'written_warning', reason: form.reason });
      toast('Disciplinary action recorded');
      setModal(null); setForm({}); load();
    } catch (e) { toast(errMsg(e), true); }
  };

  if (!cases || !disciplinary) return <Spinner />;
  const setF = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <>
      {overview && (
        <div className="stat-grid">
          <StatCard label="Open / investigating" value={overview.openCases} accent={overview.openCases ? 'var(--red, #b42318)' : undefined} />
          <StatCard label="Disciplinary actions YTD" value={overview.actionsYtd} />
          {(overview.byStatus || []).map((s) => <StatCard key={s.status} label={`Cases: ${s.status}`} value={s.n} />)}
        </div>
      )}

      <div className="mt"><Tabs active={tab} onChange={setTab} tabs={[
        { key: 'cases', label: 'HR Cases' }, { key: 'disciplinary', label: 'Disciplinary Actions' },
      ]} /></div>

      {tab === 'cases' && (
        <div className="card mt">
          <div className="card-h spread">
            <h3>Employee relations cases</h3>
            {can('relations.manage') && <button className="btn sm" onClick={() => setModal({ type: 'newCase' })}>Open case</button>}
          </div>
          <DataTable
            columns={[
              { key: 'case_no', label: 'Case #', render: (r) => <b>{r.case_no}</b> },
              { key: 'employee_name', label: 'Employee', render: (r) => <>{r.employee_name}<div style={{ fontSize: 12.5, color: 'var(--muted)' }}>{r.department || '—'}</div></> },
              { key: 'category', label: 'Category', render: (r) => <StatusBadge value={r.category} labels={{ grievance: ['amber', 'Grievance'], complaint: ['blue', 'Complaint'], disciplinary: ['red', 'Disciplinary'], harassment: ['red', 'Harassment'], other: ['gray', 'Other'] }} /> },
              { key: 'title', label: 'Title', render: (r) => r.title },
              { key: 'severity', label: 'Severity', render: (r) => <StatusBadge value={r.severity} /> },
              { key: 'status', label: 'Status', render: (r) => <StatusBadge value={r.status} /> },
              { key: 'assigned_to_name', label: 'Assigned', render: (r) => r.assigned_to_name || '—' },
              { key: 'created_at', label: 'Opened', render: (r) => fmtDate(r.created_at) },
            ]}
            rows={cases}
            emptyText="No cases — a healthy workplace 🎉"
            actions={(r) => <button className="btn ghost sm" onClick={() => openDetail(r)}>Open</button>}
          />
        </div>
      )}

      {tab === 'disciplinary' && (
        <div className="card mt">
          <div className="card-h spread">
            <h3>Disciplinary actions</h3>
            {can('relations.manage') && <button className="btn sm" onClick={() => setModal({ type: 'newDisciplinary' })}>Record action</button>}
          </div>
          <DataTable
            columns={[
              { key: 'employee_name', label: 'Employee', render: (r) => <>{r.employee_name}<div style={{ fontSize: 12.5, color: 'var(--muted)' }}>{r.employee_code}</div></> },
              { key: 'action_type', label: 'Action', render: (r) => <StatusBadge value={r.action_type} labels={{ verbal_warning: ['amber', 'Verbal Warning'], written_warning: ['red', 'Written Warning'], show_cause: ['red', 'Show Cause'], suspension: ['red', 'Suspension'], pip: ['amber', 'PIP'], termination: ['red', 'Termination'] }} /> },
              { key: 'case_no', label: 'Linked case', render: (r) => r.case_no || '—' },
              { key: 'reason', label: 'Reason', render: (r) => r.reason || '—' },
              { key: 'issued_by_name', label: 'Issued by', render: (r) => r.issued_by_name || '—' },
              { key: 'issued_on', label: 'Date', render: (r) => fmtDate(r.issued_on) },
              { key: 'acknowledged', label: 'Ack', render: (r) => r.acknowledged ? '✅' : '—' },
            ]}
            rows={disciplinary}
            emptyText="No disciplinary actions"
          />
        </div>
      )}

      {detail && (
        <Modal title={`${detail.case_no} — ${detail.title}`} onClose={() => setDetail(null)} wide footer={
          <>
            <button className="btn secondary" onClick={() => setDetail(null)}>Close</button>
            {can('relations.manage') && detail.status !== 'closed' && detail.status !== 'resolved' &&
              <button className="btn" onClick={resolveCase}>Resolve…</button>}
          </>
        }>
          <div className="row" style={{ gap: 8, marginBottom: 10 }}>
            <StatusBadge value={detail.status} /> <StatusBadge value={detail.severity} />
            <span style={{ color: 'var(--muted)', fontSize: 13 }}>{detail.employee_name} ({detail.employee_code}) · {detail.department}</span>
          </div>
          <p style={{ fontSize: 14 }}>{detail.description}</p>
          {detail.resolution && <div className="card" style={{ background: 'var(--bg, #f9fafb)', margin: '10px 0' }}><b>Resolution:</b> {detail.resolution}</div>}
          <h4 style={{ margin: '14px 0 6px' }}>Audit history — notes</h4>
          {!detail.notes?.length && <Empty text="No notes yet" />}
          {(detail.notes || []).map((n) => (
            <div key={n.id} style={{ padding: '8px 0', borderBottom: '1px solid var(--border)', fontSize: 13.5 }}>
              <b>{n.author_name}</b> {n.visibility === 'hr_only' && <span className="badge red">HR only</span>}
              <div>{n.note}</div>
              <span style={{ color: 'var(--muted)', fontSize: 12 }}>{fmtDate(n.created_at, true)}</span>
            </div>
          ))}
          {can('relations.manage') && (
            <div style={{ marginTop: 12 }}>
              <textarea rows={2} placeholder="Add investigation / HR note…" value={form.note || ''} onChange={(e) => setF('note')(e.target.value)} style={{ width: '100%' }} />
              <div className="row" style={{ marginTop: 8 }}>
                <select value={form.visibility || 'internal'} onChange={(e) => setF('visibility')(e.target.value)}>
                  <option value="internal">Internal (investigators)</option>
                  <option value="hr_only">HR only (confidential)</option>
                </select>
                <button className="btn sm" onClick={addNote}>Add note</button>
              </div>
            </div>
          )}
          {can('relations.manage') && (
            <div style={{ marginTop: 14 }}>
              <h4>Resolution</h4>
              <textarea rows={2} placeholder="Describe the resolution…" value={form.resolution || ''} onChange={(e) => setF('resolution')(e.target.value)} style={{ width: '100%' }} />
            </div>
          )}
        </Modal>
      )}

      {modal?.type === 'newCase' && (
        <Modal title="Open HR case" onClose={() => setModal(null)} footer={<><button className="btn secondary" onClick={() => setModal(null)}>Cancel</button><button className="btn" onClick={createCase}>Open case</button></>}>
          <SelectField label="Employee *" value={form.employeeId} onChange={setF('employeeId')} options={emps.map((e) => ({ value: e.id, label: `${e.first_name} ${e.last_name} (${e.employee_code})` }))} />
          <SelectField label="Category" value={form.category} onChange={setF('category')} options={[
            { value: 'grievance', label: 'Grievance' }, { value: 'complaint', label: 'Complaint' },
            { value: 'disciplinary', label: 'Disciplinary' }, { value: 'harassment', label: 'Harassment (POSH)' }, { value: 'other', label: 'Other' },
          ]} />
          <TextField label="Title *" value={form.title} onChange={setF('title')} />
          <div className="field"><label>Description</label><textarea rows={3} value={form.description || ''} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} /></div>
          <SelectField label="Severity" value={form.severity} onChange={setF('severity')} options={[
            { value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' }, { value: 'critical', label: 'Critical' },
          ]} />
        </Modal>
      )}

      {modal?.type === 'newDisciplinary' && (
        <Modal title="Record disciplinary action" onClose={() => setModal(null)} footer={<><button className="btn secondary" onClick={() => setModal(null)}>Cancel</button><button className="btn" onClick={createDisciplinary}>Record</button></>}>
          <SelectField label="Employee *" value={form.employeeId} onChange={setF('employeeId')} options={emps.map((e) => ({ value: e.id, label: `${e.first_name} ${e.last_name} (${e.employee_code})` }))} />
          <SelectField label="Action type" value={form.actionType} onChange={setF('actionType')} options={[
            { value: 'verbal_warning', label: 'Verbal warning' }, { value: 'written_warning', label: 'Written warning' },
            { value: 'show_cause', label: 'Show cause' }, { value: 'suspension', label: 'Suspension' },
            { value: 'pip', label: 'Performance improvement plan' }, { value: 'termination', label: 'Termination' },
          ]} />
          <div className="field"><label>Reason</label><textarea rows={3} value={form.reason || ''} onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))} /></div>
        </Modal>
      )}
    </>
  );
}
