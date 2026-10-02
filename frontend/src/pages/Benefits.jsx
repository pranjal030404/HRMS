import React, { useEffect, useState } from 'react';
import { api, errMsg, money, fmtDate } from '../api';
import { useAuth } from '../auth';
import DataTable from '../components/DataTable';
import { Spinner, StatusBadge, useToast, Modal, TextField, SelectField, Tabs, StatCard, Empty } from '../components/ui';

export default function Benefits() {
  const { can, me } = useAuth();
  const toast = useToast();
  const [tab, setTab] = useState('plans');
  const [plans, setPlans] = useState(null);
  const [enrollments, setEnrollments] = useState(null);
  const [mine, setMine] = useState(null);
  const [overview, setOverview] = useState(null);
  const [emps, setEmps] = useState([]);
  const [modal, setModal] = useState(null);
  const [form, setForm] = useState({});

  const load = async () => {
    try {
      const [p, en, mn] = await Promise.all([
        api.get('/benefits/plans'), api.get('/benefits/enrollments'), api.get('/benefits/mine'),
      ]);
      setPlans(p.data.data); setEnrollments(en.data.data); setMine(mn.data.data);
      api.get('/benefits/overview').then(({ data }) => setOverview(data.data)).catch(() => {});
      if (can('benefit.manage')) api.get('/employees?limit=200').then(({ data }) => setEmps(data.data)).catch(() => {});
    } catch (e) { toast(errMsg(e), true); }
  };
  useEffect(() => { load(); }, []); // eslint-disable-line

  const createPlan = async () => {
    try {
      const eligibility = {};
      if (form.employmentTypes?.length) eligibility.employmentTypes = form.employmentTypes;
      if (form.minTenureMonths) eligibility.minTenureMonths = Number(form.minTenureMonths);
      await api.post('/benefits/plans', {
        name: form.name, btype: form.btype || 'insurance', provider: form.provider, description: form.description,
        eligibility, employerCost: Number(form.employerCost || 0), employeeCost: Number(form.employeeCost || 0),
        effectiveFrom: form.effectiveFrom || null,
      });
      toast('Plan created'); setModal(null); setForm({}); load();
    } catch (e) { toast(errMsg(e), true); }
  };

  const enroll = async () => {
    try {
      await api.post('/benefits/enroll', {
        planId: Number(modal.plan.id), employeeId: Number(form.employeeId),
        nomineeName: form.nomineeName, nomineeRelation: form.nomineeRelation, nomineeDob: form.nomineeDob,
        coverageDetails: form.policyNo ? { policyNo: form.policyNo, sumInsured: Number(form.sumInsured || 0) } : null,
        enrolledOn: form.enrolledOn || new Date().toISOString().slice(0, 10),
      });
      toast('Enrolled');
      setModal(null); setForm({}); load();
    } catch (e) { toast(errMsg(e), true); }
  };

  if (!plans || !enrollments) return <Spinner />;
  const setF = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <>
      {overview && (
        <div className="stat-grid">
          <StatCard label="Active plans" value={overview.activePlans} />
          <StatCard label="Active enrollments" value={overview.enrolled} />
          <StatCard label="Monthly employer cost" value={money(overview.monthlyCost)} />
          <StatCard label="Eligible, not enrolled" value={overview.eligibleUnenrolled} />
        </div>
      )}

      <div className="mt"><Tabs active={tab} onChange={setTab} tabs={[
        { key: 'plans', label: 'Benefit Plans' }, { key: 'enrollments', label: 'Enrollments' },
        { key: 'mine', label: 'My Benefits' },
      ]} /></div>

      {tab === 'plans' && (
        <div className="grid2 mt">
          {plans.length === 0 && <Empty text="No benefit plans" />}
          {plans.map((p) => {
            const eligibility = typeof p.eligibility === 'string' ? JSON.parse(p.eligibility || '{}') : (p.eligibility || {});
            const count = enrollments.filter((e) => e.plan_id === p.id && e.status === 'active').length;
            return (
              <div className="card" key={p.id}>
                <div className="card-h spread">
                  <h3>{p.name}</h3>
                  <StatusBadge value={p.status} />
                </div>
                <div className="row" style={{ gap: 8, marginBottom: 6 }}>
                  <StatusBadge value={p.btype} labels={{ insurance: ['blue', 'Insurance'], allowance: ['green', 'Allowance'], wellness: ['purple', 'Wellness'], retirement: ['amber', 'Retirement'], other: ['gray', 'Other'] }} />
                  {p.provider && <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>by {p.provider}</span>}
                </div>
                <p style={{ color: 'var(--muted)', fontSize: 13 }}>{p.description || '—'}</p>
                <div style={{ fontSize: 12.5 }}>
                  Employer cost: <b>{money(p.employer_cost)}/mo</b> · Employee: <b>{money(p.employee_cost)}/mo</b><br />
                  Eligibility: {eligibility.employmentTypes?.length ? eligibility.employmentTypes.join(', ') : 'All employees'}
                  {eligibility.minTenureMonths ? ` · min ${eligibility.minTenureMonths} months` : ''}
                </div>
                <div className="spread" style={{ marginTop: 10 }}>
                  <span style={{ fontSize: 13 }}><b>{count}</b> enrolled</span>
                  {can('benefit.manage') && <button className="btn sm" onClick={() => { setForm({}); setModal({ type: 'enroll', plan: p }); }}>Enroll employee</button>}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {tab === 'enrollments' && (
        <div className="card mt">
          <div className="card-h spread">
            <h3>All enrollments</h3>
            {can('benefit.manage') && <button className="btn sm" onClick={() => setModal({ type: 'newPlan' })}>New plan</button>}
          </div>
          <DataTable
            columns={[
              { key: 'employee_name', label: 'Employee', render: (r) => <><b>{r.employee_name}</b> <span style={{ color: 'var(--muted)' }}>{r.employee_code}</span><div style={{ fontSize: 12.5, color: 'var(--muted)' }}>{r.department || '—'}</div></> },
              { key: 'plan_name', label: 'Plan', render: (r) => <>{r.plan_name}<div style={{ fontSize: 12.5, color: 'var(--muted)' }}>{r.provider}</div></> },
              { key: 'nominee_name', label: 'Nominee', render: (r) => r.nominee_name ? `${r.nominee_name} (${r.nominee_relation || '—'})` : '—' },
              { key: 'coverage', label: 'Coverage', render: (r) => { const c = typeof r.coverage_details === 'string' ? JSON.parse(r.coverage_details || '{}') : (r.coverage_details || {}); return c.policyNo ? <>{c.policyNo}{c.sumInsured ? ` · ${money(c.sumInsured)}` : ''}</> : '—'; } },
              { key: 'enrolled_on', label: 'Enrolled', render: (r) => fmtDate(r.enrolled_on) },
              { key: 'status', label: 'Status', render: (r) => <StatusBadge value={r.status} /> },
            ]}
            rows={enrollments}
            emptyText="No enrollments yet"
            actions={(r) => can('benefit.manage') && r.status === 'active' ? (
              <button className="btn ghost sm" onClick={async () => { await api.put(`/benefits/enrollments/${r.id}/close`); toast('Closed'); load(); }}>Close</button>
            ) : null}
          />
        </div>
      )}

      {tab === 'mine' && (
        <div className="grid2 mt">
          {mine.length === 0 && <Empty icon="🏥" text="You are not enrolled in any benefit plans yet" />}
          {mine.map((b) => (
            <div className="card" key={b.id}>
              <div className="card-h"><h3>{b.plan_name}</h3></div>
              <p style={{ color: 'var(--muted)', fontSize: 13 }}>{b.description}</p>
              <div style={{ fontSize: 13 }}>
                Provider: <b>{b.provider || '—'}</b><br />
                Nominee: <b>{b.nominee_name || '—'}</b> {b.nominee_relation && `(${b.nominee_relation})`}<br />
                Enrolled: {fmtDate(b.enrolled_on)}
              </div>
            </div>
          ))}
        </div>
      )}

      {modal?.type === 'newPlan' && (
        <Modal title="New benefit plan" onClose={() => setModal(null)} footer={<><button className="btn secondary" onClick={() => setModal(null)}>Cancel</button><button className="btn" onClick={createPlan}>Create</button></>}>
          <TextField label="Plan name *" value={form.name} onChange={setF('name')} />
          <div className="row">
            <SelectField label="Type" value={form.btype} onChange={setF('btype')} options={[
              { value: 'insurance', label: 'Insurance' }, { value: 'allowance', label: 'Allowance' }, { value: 'wellness', label: 'Wellness' }, { value: 'retirement', label: 'Retirement' },
            ]} />
            <TextField label="Provider" value={form.provider} onChange={setF('provider')} />
          </div>
          <div className="field"><label>Description</label><textarea rows={2} value={form.description || ''} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} /></div>
          <div className="row">
            <TextField label="Employer cost (₹/mo)" type="number" value={form.employerCost} onChange={setF('employerCost')} />
            <TextField label="Employee cost (₹/mo)" type="number" value={form.employeeCost} onChange={setF('employeeCost')} />
          </div>
          <SelectField label="Eligible employment types (multi)" value={form.employmentTypes} onChange={setF('employmentTypes')} options={[
            { value: 'full_time', label: 'Full time' }, { value: 'part_time', label: 'Part time' }, { value: 'contract', label: 'Contract' }, { value: 'intern', label: 'Intern' },
          ]} />
          <TextField label="Min tenure (months)" type="number" value={form.minTenureMonths} onChange={setF('minTenureMonths')} />
        </Modal>
      )}

      {modal?.type === 'enroll' && (
        <Modal title={`Enroll — ${modal.plan.name}`} onClose={() => setModal(null)} footer={<><button className="btn secondary" onClick={() => setModal(null)}>Cancel</button><button className="btn" onClick={enroll}>Enroll</button></>}>
          <SelectField label="Employee *" value={form.employeeId} onChange={setF('employeeId')} options={emps.map((e) => ({ value: e.id, label: `${e.first_name} ${e.last_name} (${e.employee_code})` }))} />
          <div className="row">
            <TextField label="Nominee name" value={form.nomineeName} onChange={setF('nomineeName')} />
            <SelectField label="Relation" value={form.nomineeRelation} onChange={setF('nomineeRelation')} options={[
              { value: 'spouse', label: 'Spouse' }, { value: 'father', label: 'Father' }, { value: 'mother', label: 'Mother' }, { value: 'son', label: 'Son' }, { value: 'daughter', label: 'Daughter' },
            ]} />
          </div>
          <div className="row">
            <TextField label="Policy number" value={form.policyNo} onChange={setF('policyNo')} />
            <TextField label="Sum insured (₹)" type="number" value={form.sumInsured} onChange={setF('sumInsured')} />
          </div>
        </Modal>
      )}
    </>
  );
}
