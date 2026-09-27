import React, { useEffect, useRef, useState } from 'react';
import { api, errMsg, money, fmtDate } from '../api';
import { useAuth } from '../auth';
import { Spinner, StatusBadge, useToast, Modal, TextField, SelectField } from '../components/ui';

const STAGES = ['applied', 'screening', 'interview', 'offer', 'hired', 'rejected'];

export default function Recruitment() {
  const { can } = useAuth();
  const toast = useToast();
  const [requisitions, setRequisitions] = useState(null);
  const [candidates, setCandidates] = useState(null);
  const [analytics, setAnalytics] = useState(null);
  const [reqModal, setReqModal] = useState(false);
  const [candModal, setCandModal] = useState(null);
  const [reqForm, setReqForm] = useState({});
  const [candForm, setCandForm] = useState({});
  const [lookups, setLookups] = useState(null);
  const resumeRef = React.useRef(null);
  const fileRef = React.useRef(null);

  const load = async () => {
    try {
      const [r, c, a, l] = await Promise.all([
        api.get('/recruitment/requisitions'), api.get('/recruitment/candidates'),
        api.get('/recruitment/analytics'), api.get('/org/lookups'),
      ]);
      setRequisitions(r.data.data);
      setCandidates(c.data.data);
      setAnalytics(a.data.data);
      setLookups(l.data.data);
    } catch (e) { toast(errMsg(e), true); }
  };
  useEffect(() => { load(); }, []);

  const saveReq = async () => {
    try {
      await api.post('/recruitment/requisitions', {
        ...reqForm, openings: Number(reqForm.openings || 1),
        minExperience: Number(reqForm.minExperience || 0),
        budgetCtc: reqForm.budgetCtc ? Number(reqForm.budgetCtc) : null,
        departmentId: reqForm.departmentId ? Number(reqForm.departmentId) : null,
      });
      toast('Requisition created — pending approval');
      setReqModal(false);
      load();
    } catch (e) { toast(errMsg(e), true); }
  };

  const saveCandidate = async () => {
    const file = resumeRef.current?.files?.[0];
    const fd = new FormData();
    Object.entries(candForm).forEach(([k, v]) => v != null && fd.append(k, v));
    if (file) fd.append('file', file);
    try {
      await api.post('/recruitment/candidates', fd);
      toast('Candidate added to pipeline');
      setCandModal(null);
      setCandForm({});
      load();
    } catch (e) { toast(errMsg(e), true); }
  };

  const moveStage = async (cand, stage) => {
    try {
      await api.post(`/recruitment/candidates/${cand.id}/stage`, { stage });
      load();
    } catch (e) { toast(errMsg(e), true); }
  };

  if (!requisitions || !candidates) return <Spinner />;
  const setR = (k) => (v) => setReqForm((f) => ({ ...f, [k]: v }));
  const setC = (k) => (v) => setCandForm((f) => ({ ...f, [k]: v }));

  return (
    <div>
      <div className="card mb">
        <div className="card-h">
          <h3>Open requisitions ({analytics?.openPositions ?? '—'})</h3>
          {can('recruitment.manage') && <button className="btn sm" onClick={() => setReqModal(true)}>+ New requisition</button>}
        </div>
        <div className="table-wrap">
          <table className="tbl">
            <thead><tr><th>Code</th><th>Title</th><th>Department</th><th className="num">Openings</th><th className="num">Candidates</th><th className="num">Budget CTC</th><th>Status</th></tr></thead>
            <tbody>
              {requisitions.map((r) => (
                <tr key={r.id}>
                  <td><code>{r.rcode}</code></td>
                  <td><b>{r.title}</b></td>
                  <td>{r.department_name || '—'}</td>
                  <td className="num">{r.openings}</td>
                  <td className="num">{r.candidate_count}</td>
                  <td className="num">{r.budget_ctc ? money(r.budget_ctc) : '—'}</td>
                  <td><StatusBadge value={r.status} labels={{ open: ['green', 'Open'], pending_approval: ['amber', 'Pending approval'], closed: ['gray', 'Closed'] }} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <div className="card-h">
          <h3>Candidate pipeline</h3>
          {can('recruitment.manage') && <button className="btn sm" onClick={() => { setCandForm({}); setCandModal(true); }}>+ Add candidate</button>}
        </div>
        <div className="card-b">
          <div className="kanban">
            {STAGES.map((stage) => {
              const list = candidates.filter((c) => c.stage === stage);
              return (
                <div className="kan-col" key={stage}>
                  <h4>{stage} ({list.length})</h4>
                  {list.map((c) => (
                    <div className="kan-card" key={c.id}>
                      <b>{c.name}</b>
                      <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{c.requisition_title}</div>
                      <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{c.experience_years} yrs · {c.source}</div>
                      {can('recruitment.manage') && (
                        <select className="btn sm secondary" style={{ marginTop: 6, width: '100%' }} value={c.stage}
                          onChange={(e) => moveStage(c, e.target.value)}>
                          {STAGES.map((s) => <option key={s} value={s}>Move to {s}</option>)}
                        </select>
                      )}
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {reqModal && (
        <Modal title="New job requisition" onClose={() => setReqModal(false)} footer={
          <><button className="btn secondary" onClick={() => setReqModal(false)}>Cancel</button><button className="btn" onClick={saveReq}>Create</button></>
        }>
          <TextField label="Job title *" value={reqForm.title} onChange={setR('title')} />
          <div className="form-grid">
            <SelectField label="Department" value={reqForm.departmentId} onChange={setR('departmentId')} options={(lookups?.departments || []).map((d) => ({ value: d.id, label: d.name }))} />
            <SelectField label="Location" value={reqForm.locationId} onChange={setR('locationId')} options={(lookups?.locations || []).map((d) => ({ value: d.id, label: d.name }))} />
            <TextField label="Openings" type="number" value={reqForm.openings} onChange={setR('openings')} />
            <TextField label="Budget CTC (₹/yr)" type="number" value={reqForm.budgetCtc} onChange={setR('budgetCtc')} />
            <TextField label="Min experience (yrs)" type="number" value={reqForm.minExperience} onChange={setR('minExperience')} />
          </div>
          <TextField label="Description" value={reqForm.description} onChange={setR('description')} />
        </Modal>
      )}

      {candModal && (
        <Modal title="Add candidate" onClose={() => setCandModal(false)} footer={
          <><button className="btn secondary" onClick={() => setCandModal(false)}>Cancel</button><button className="btn" onClick={saveCandidate}>Add</button></>
        }>
          <SelectField label="Requisition *" value={candForm.requisitionId} onChange={setC('requisitionId')}
            options={requisitions.filter((r) => !['closed', 'cancelled'].includes(r.status)).map((r) => ({ value: r.id, label: r.title }))} />
          <div className="form-grid">
            <TextField label="Name *" value={candForm.name} onChange={setC('name')} />
            <TextField label="Email" type="email" value={candForm.email} onChange={setC('email')} />
            <TextField label="Phone" value={candForm.phone} onChange={setC('phone')} />
            <TextField label="Experience (yrs)" type="number" value={candForm.experienceYears} onChange={setC('experienceYears')} />
            <SelectField label="Source" value={candForm.source} onChange={setC('source')}
              options={['direct', 'referral', 'linkedin', 'portal', 'agency'].map((s) => ({ value: s, label: s }))} />
            <TextField label="Expected CTC" type="number" value={candForm.expectedCtc} onChange={setC('expectedCtc')} />
          </div>
          <div className="field"><label>Resume</label><input type="file" ref={resumeRef} /></div>
        </Modal>
      )}
    </div>
  );
}
