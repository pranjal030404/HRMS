import React, { useEffect, useState } from 'react';
import { api, errMsg, fmtDate } from '../api';
import { useAuth } from '../auth';
import DataTable from '../components/DataTable';
import { Spinner, StatusBadge, useToast, Modal, TextField, SelectField, Tabs, StatCard, Empty } from '../components/ui';

const PROF = [
  { value: 'beginner', label: 'Beginner' }, { value: 'intermediate', label: 'Intermediate' },
  { value: 'advanced', label: 'Advanced' }, { value: 'expert', label: 'Expert' },
];
const READINESS = [
  { value: 'ready_now', label: 'Ready now' }, { value: 'ready_1_2_years', label: 'Ready in 1-2 years' },
  { value: 'ready_3_5_years', label: 'Ready in 3-5 years' }, { value: 'not_ready', label: 'Not ready' },
];
const CRITICALITY = [
  { value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' }, { value: 'critical', label: 'Critical' },
];

export default function Talent() {
  const { can } = useAuth();
  const toast = useToast();
  const [tab, setTab] = useState('matrix');
  const [overview, setOverview] = useState(null);
  const [matrix, setMatrix] = useState(null);
  const [skills, setSkills] = useState([]);
  const [paths, setPaths] = useState(null);
  const [plans, setPlans] = useState(null);
  const [pools, setPools] = useState(null);
  const [poolMembers, setPoolMembers] = useState(null);
  const [succession, setSuccession] = useState(null);
  const [certs, setCerts] = useState(null);
  const [training, setTraining] = useState(null);
  const [emps, setEmps] = useState([]);
  const [modal, setModal] = useState(null);
  const [form, setForm] = useState({});

  const load = async () => {
    try {
      const reqs = [
        api.get('/talent/overview'), api.get('/talent/matrix'), api.get('/talent/skills'),
        api.get('/talent/career-paths'), api.get('/talent/development-plans'), api.get('/talent/pools'),
        api.get('/talent/succession'), api.get('/talent/certifications'), api.get('/talent/training'),
      ];
      const [ov, mx, sk, cp, dp, pl, su, ce, tr] = (await Promise.all(reqs)).map((r) => r.data.data);
      setOverview(ov); setMatrix(mx); setSkills(sk); setPaths(cp); setPlans(dp); setPools(pl); setSuccession(su); setCerts(ce); setTraining(tr);
      if (can('talent.manage') || can('employee.view')) api.get('/employees?limit=200').then(({ data }) => setEmps(data.data)).catch(() => {});
    } catch (e) { toast(errMsg(e), true); }
  };
  useEffect(() => { load(); }, []); // eslint-disable-line

  const openPoolMembers = async (pool) => {
    setModal({ type: 'poolMembers', pool });
    try { const { data } = await api.get(`/talent/pools/${pool.id}/members`); setPoolMembers(data.data); } catch (e) { toast(errMsg(e), true); }
  };

  const save = async () => {
    try {
      if (modal.type === 'addSkill') {
        await api.post('/talent/matrix', { employeeId: Number(form.employeeId), skillId: Number(form.skillId), proficiency: form.proficiency, yearsExperience: Number(form.yearsExperience || 0), verified: !!form.verified });
        toast('Skill mapped');
      } else if (modal.type === 'addPlan') {
        await api.post('/talent/development-plans', { employeeId: Number(form.employeeId), title: form.title, description: form.description, mentorId: form.mentorId ? Number(form.mentorId) : null, startDate: form.startDate, targetDate: form.targetDate });
        toast('Development plan created');
      } else if (modal.type === 'addSuccession') {
        await api.post('/talent/succession', { positionTitle: form.positionTitle, employeeId: form.employeeId ? Number(form.employeeId) : null, criticality: form.criticality, risk: form.risk, successorEmployeeId: form.successorEmployeeId ? Number(form.successorEmployeeId) : null, readiness: form.readiness, developmentActions: form.developmentActions });
        toast('Succession plan created');
      } else if (modal.type === 'addCert') {
        await api.post('/talent/certifications', { employeeId: Number(form.employeeId), name: form.name, issuedBy: form.issuedBy, issuedOn: form.issuedOn, expiresOn: form.expiresOn, credentialId: form.credentialId });
        toast('Certification added');
      } else if (modal.type === 'addPoolMember') {
        if (!form.memberEmployeeId && !form.memberCandidateId) throw new Error('Pick an employee or enter a candidate id');
        await api.post(`/talent/pools/${modal.pool.id}/members`, { employeeId: form.memberEmployeeId ? Number(form.memberEmployeeId) : null, notes: form.notes });
        const { data } = await api.get(`/talent/pools/${modal.pool.id}/members`); setPoolMembers(data.data);
        toast('Added to pool');
      }
      setModal(null); setForm({}); load();
    } catch (e) { toast(errMsg(e), true); }
  };

  const updateProgress = async (plan, value) => {
    try { await api.put(`/talent/development-plans/${plan.id}`, { progress: value }); load(); } catch (e) { toast(errMsg(e), true); }
  };

  if (!matrix || !overview) return <Spinner />;
  const setF = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));
  const empOpts = emps.map((e) => ({ value: e.id, label: `${e.first_name} ${e.last_name} (${e.employee_code})` }));

  return (
    <>
      <div className="stat-grid">
        <StatCard label="Active skills" value={overview.skillCount} />
        <StatCard label="Employees with skill map" value={overview.mapped} />
        <StatCard label="Active dev plans" value={overview.activePlans} />
        <StatCard label="Critical roles" value={overview.criticalRoles} sub={`${overview.successorsReady} ready-now successors`} accent={overview.criticalRoles && !overview.successorsReady ? 'var(--red, #b42318)' : undefined} />
        <StatCard label="Certs expiring (90d)" value={overview.expiringCerts} />
      </div>

      <div className="mt">
        <Tabs active={tab} onChange={setTab} tabs={[
          { key: 'matrix', label: 'Skills Matrix' }, { key: 'paths', label: 'Career Paths' },
          { key: 'plans', label: 'Development Plans' }, { key: 'pools', label: 'Talent Pools' },
          { key: 'succession', label: 'Succession' }, { key: 'learning', label: 'Learning & Certifications' },
        ]} />
      </div>

      {tab === 'matrix' && (
        <div className="card mt">
          <div className="card-h spread">
            <h3>Employee skills matrix</h3>
            {can('talent.manage') && <button className="btn sm" onClick={() => setModal({ type: 'addSkill' })}>Map skill</button>}
          </div>
          <DataTable
            columns={[
              { key: 'employee_name', label: 'Employee', render: (r) => <><b>{r.employee_name}</b> <span style={{ color: 'var(--muted)' }}>{r.employee_code}</span></> },
              { key: 'skill_name', label: 'Skill', render: (r) => <>{r.skill_name} <span style={{ color: 'var(--muted)' }}>· {r.skill_category}</span></> },
              { key: 'proficiency', label: 'Proficiency', render: (r) => <StatusBadge value={r.proficiency} labels={{ advanced: ['green', 'Advanced'] }} /> },
              { key: 'years_experience', label: 'Years', align: 'right', render: (r) => r.years_experience ?? '—' },
              { key: 'verified', label: 'Verified', render: (r) => r.verified ? '✅' : '—' },
              { key: 'department', label: 'Department', render: (r) => r.department || '—' },
            ]}
            rows={matrix}
            emptyText="No skills mapped yet"
            actions={(r) => can('talent.manage') ? (
              <button className="btn ghost sm" onClick={async () => { await api.delete(`/talent/matrix/${r.id}`); toast('Removed'); load(); }}>Remove</button>
            ) : null}
          />
        </div>
      )}

      {tab === 'paths' && (
        <div className="grid2 mt">
          {paths.length === 0 && <Empty text="No career paths defined" />}
          {paths.map((p) => (
            <div className="card" key={p.id}>
              <div className="card-h"><h3>{p.name}</h3><StatusBadge value={p.status} labels={{ active: ['green', 'Active'], inactive: ['gray', 'Inactive'] }} /></div>
              <p style={{ color: 'var(--muted)', fontSize: 13 }}>{p.description || '—'}</p>
              <div style={{ fontSize: 12.5 }}>Track: <b>{p.track}</b></div>
              <ol style={{ margin: '10px 0 0', paddingLeft: 20, fontSize: 13.5 }}>
                {(typeof p.steps === 'string' ? JSON.parse(p.steps) : p.steps || []).map((s, i) => (
                  <li key={i} style={{ marginBottom: 4 }}><b>{s.title}</b><div style={{ color: 'var(--muted)', fontSize: 12.5 }}>{s.competency}</div></li>
                ))}
              </ol>
            </div>
          ))}
        </div>
      )}

      {tab === 'plans' && (
        <div className="card mt">
          <div className="card-h spread">
            <h3>Development plans</h3>
            {can('talent.manage') && <button className="btn sm" onClick={() => setModal({ type: 'addPlan' })}>New plan</button>}
          </div>
          <DataTable
            columns={[
              { key: 'employee_name', label: 'Employee' },
              { key: 'title', label: 'Plan', render: (r) => <><b>{r.title}</b><div style={{ color: 'var(--muted)', fontSize: 12.5 }}>{r.description}</div></> },
              { key: 'mentor_name', label: 'Mentor', render: (r) => r.mentor_name || '—' },
              { key: 'timeline', label: 'Timeline', render: (r) => `${fmtDate(r.start_date)} → ${fmtDate(r.target_date)}` },
              { key: 'progress', label: 'Progress', render: (r) => can('talent.manage') ? (
                <input type="range" min="0" max="100" step="5" value={r.progress} style={{ width: 120 }}
                  onChange={(e) => updateProgress(r, e.target.value)} />) : (
                <div className="bar-track" style={{ width: 120 }}><div className="bar-fill" style={{ width: `${r.progress}%` }} /></div>
              ) },
              { key: 'status', label: 'Status', render: (r) => <StatusBadge value={r.status} /> },
            ]}
            rows={plans}
            emptyText="No development plans"
          />
        </div>
      )}

      {tab === 'pools' && (
        <div className="grid2 mt">
          {pools.length === 0 && <Empty text="No talent pools" />}
          {pools.map((p) => (
            <div className="card" key={p.id}>
              <div className="card-h spread"><h3>{p.name}</h3><button className="btn sm ghost" onClick={() => openPoolMembers(p)}>View members</button></div>
              <p style={{ color: 'var(--muted)', fontSize: 13 }}>{p.description || '—'}</p>
            </div>
          ))}
        </div>
      )}

      {tab === 'succession' && (
        <div className="card mt">
          <div className="card-h spread">
            <h3>Succession planning — critical positions</h3>
            {can('talent.manage') && <button className="btn sm" onClick={() => setModal({ type: 'addSuccession' })}>New succession plan</button>}
          </div>
          <DataTable
            columns={[
              { key: 'position_title', label: 'Position', render: (r) => <b>{r.position_title}</b> },
              { key: 'incumbent_name', label: 'Incumbent', render: (r) => r.incumbent_name ? <>{r.incumbent_name} <span style={{ color: 'var(--muted)' }}>{r.incumbent_code}</span></> : '—' },
              { key: 'criticality', label: 'Criticality', render: (r) => <StatusBadge value={r.criticality} /> },
              { key: 'risk', label: 'Risk', render: (r) => <StatusBadge value={r.risk} /> },
              { key: 'successor_name', label: 'Successor', render: (r) => r.successor_name || '—' },
              { key: 'readiness', label: 'Readiness', render: (r) => <StatusBadge value={r.readiness} /> },
              { key: 'development_actions', label: 'Development actions', render: (r) => r.development_actions || '—' },
            ]}
            rows={succession}
            emptyText="No succession plans yet"
          />
        </div>
      )}

      {tab === 'learning' && (
        <>
          <div className="card mt">
            <div className="card-h spread">
              <h3>Certifications</h3>
              {can('talent.manage') && <button className="btn sm" onClick={() => setModal({ type: 'addCert' })}>Add certification</button>}
            </div>
            <DataTable
              columns={[
                { key: 'employee_name', label: 'Employee' },
                { key: 'name', label: 'Certification', render: (r) => <b>{r.name}</b> },
                { key: 'issued_by', label: 'Issuer', render: (r) => r.issued_by || '—' },
                { key: 'expires_on', label: 'Expires', render: (r) => r.expires_on ? fmtDate(r.expires_on) : 'No expiry' },
                { key: 'verified', label: 'Verified', render: (r) => r.verified ? '✅' : '—' },
              ]}
              rows={certs}
              emptyText="No certifications recorded"
            />
            <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: '8px 14px' }}>
              Certificates issued by the standalone Arthvex LMS arrive here automatically via the HRMS ↔ LMS sync API.
            </p>
          </div>
          <div className="card mt">
            <div className="card-h"><h3>Training records (from LMS)</h3></div>
            <DataTable
              columns={[
                { key: 'employee_name', label: 'Employee' },
                { key: 'course_name', label: 'Course', render: (r) => <b>{r.course_name}</b> },
                { key: 'provider', label: 'Provider' },
                { key: 'completed_on', label: 'Completed', render: (r) => fmtDate(r.completed_on) },
                { key: 'learning_hours', label: 'Hours', align: 'right' },
              ]}
              rows={training}
              emptyText="No training records yet"
            />
          </div>
        </>
      )}

      {modal?.type === 'addSkill' && (
        <Modal title="Map skill to employee" onClose={() => setModal(null)} footer={<><button className="btn secondary" onClick={() => setModal(null)}>Cancel</button><button className="btn" onClick={save}>Save</button></>}>
          <SelectField label="Employee *" value={form.employeeId} onChange={setF('employeeId')} options={empOpts} />
          <SelectField label="Skill *" value={form.skillId} onChange={setF('skillId')} options={skills.map((s) => ({ value: s.id, label: `${s.name} (${s.category || 'general'})` }))} />
          <SelectField label="Proficiency" value={form.proficiency} onChange={setF('proficiency')} options={PROF} />
          <TextField label="Years of experience" type="number" value={form.yearsExperience} onChange={setF('yearsExperience')} />
        </Modal>
      )}
      {modal?.type === 'addPlan' && (
        <Modal title="New development plan" onClose={() => setModal(null)} footer={<><button className="btn secondary" onClick={() => setModal(null)}>Cancel</button><button className="btn" onClick={save}>Create</button></>}>
          <SelectField label="Employee *" value={form.employeeId} onChange={setF('employeeId')} options={empOpts} />
          <TextField label="Title *" value={form.title} onChange={setF('title')} />
          <TextField label="Description" value={form.description} onChange={setF('description')} />
          <SelectField label="Mentor" value={form.mentorId} onChange={setF('mentorId')} options={empOpts} />
          <div className="row">
            <TextField label="Start date" type="date" value={form.startDate} onChange={setF('startDate')} />
            <TextField label="Target date" type="date" value={form.targetDate} onChange={setF('targetDate')} />
          </div>
        </Modal>
      )}
      {modal?.type === 'addSuccession' && (
        <Modal title="New succession plan" onClose={() => setModal(null)} footer={<><button className="btn secondary" onClick={() => setModal(null)}>Cancel</button><button className="btn" onClick={save}>Create</button></>}>
          <TextField label="Position title *" value={form.positionTitle} onChange={setF('positionTitle')} />
          <SelectField label="Incumbent" value={form.employeeId} onChange={setF('employeeId')} options={empOpts} />
          <div className="row">
            <SelectField label="Criticality" value={form.criticality} onChange={setF('criticality')} options={CRITICALITY} />
            <SelectField label="Risk" value={form.risk} onChange={setF('risk')} options={CRITICALITY.slice(0, 3)} />
          </div>
          <SelectField label="Successor" value={form.successorEmployeeId} onChange={setF('successorEmployeeId')} options={empOpts} />
          <SelectField label="Readiness" value={form.readiness} onChange={setF('readiness')} options={READINESS} />
          <TextField label="Development actions" value={form.developmentActions} onChange={setF('developmentActions')} />
        </Modal>
      )}
      {modal?.type === 'addCert' && (
        <Modal title="Add certification" onClose={() => setModal(null)} footer={<><button className="btn secondary" onClick={() => setModal(null)}>Cancel</button><button className="btn" onClick={save}>Save</button></>}>
          <SelectField label="Employee *" value={form.employeeId} onChange={setF('employeeId')} options={empOpts} />
          <TextField label="Certification name *" value={form.name} onChange={setF('name')} />
          <TextField label="Issued by" value={form.issuedBy} onChange={setF('issuedBy')} />
          <div className="row">
            <TextField label="Issued on" type="date" value={form.issuedOn} onChange={setF('issuedOn')} />
            <TextField label="Expires on" type="date" value={form.expiresOn} onChange={setF('expiresOn')} />
          </div>
        </Modal>
      )}
      {modal?.type === 'poolMembers' && (
        <Modal title={`Talent pool — ${modal.pool.name}`} onClose={() => setModal(null)} wide footer={<><button className="btn secondary" onClick={() => setModal(null)}>Close</button>{can('talent.manage') && <button className="btn" onClick={() => { setForm({}); setModal({ type: 'addPoolMember', pool: modal.pool }); }}>Add member</button>}</>}>
          {!poolMembers?.length && <Empty text="No members" />}
          {poolMembers?.map((m) => (
            <div key={m.id} className="spread" style={{ padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
              <div><b>{m.employee_name || m.candidate_name || '—'}</b> {m.employee_code && <span style={{ color: 'var(--muted)' }}>{m.employee_code}</span>}</div>
              {can('talent.manage') && <button className="btn ghost sm" onClick={async () => { await api.delete(`/talent/pools/${modal.pool.id}/members/${m.id}`); openPoolMembers(modal.pool); }}>Remove</button>}
            </div>
          ))}
        </Modal>
      )}
      {modal?.type === 'addPoolMember' && (
        <Modal title={`Add to ${modal.pool.name}`} onClose={() => setModal(null)} footer={<><button className="btn secondary" onClick={() => setModal({ type: 'poolMembers', pool: modal.pool })}>Back</button><button className="btn" onClick={save}>Add</button></>}>
          <SelectField label="Employee" value={form.memberEmployeeId} onChange={setF('memberEmployeeId')} options={empOpts} />
          <TextField label="Notes" value={form.notes} onChange={setF('notes')} />
        </Modal>
      )}
    </>
  );
}
