import React, { useEffect, useState } from 'react';
import { api, errMsg, money, fmtDate } from '../api';
import { useAuth } from '../auth';
import DataTable from '../components/DataTable';
import { Spinner, StatusBadge, useToast, Modal, TextField, SelectField, Tabs, StatCard, Empty } from '../components/ui';

export default function Compensation() {
  const { can } = useAuth();
  const toast = useToast();
  const [tab, setTab] = useState('bands');
  const [bands, setBands] = useState(null);
  const [cycles, setCycles] = useState(null);
  const [activeCycle, setActiveCycle] = useState(null);
  const [reviews, setReviews] = useState(null);
  const [totals, setTotals] = useState(null);
  const [bonusPlans, setBonusPlans] = useState(null);
  const [awards, setAwards] = useState(null);
  const [equity, setEquity] = useState(null);
  const [emps, setEmps] = useState([]);
  const [grades, setGrades] = useState([]);
  const [designations, setDesignations] = useState([]);
  const [modal, setModal] = useState(null);
  const [form, setForm] = useState({});

  const load = async () => {
    try {
      const [b, c, eq] = await Promise.all([
        api.get('/compensation/bands'), api.get('/compensation/cycles'), api.get('/compensation/analytics/equity'),
      ]);
      setBands(b.data.data); setCycles(c.data.data); setEquity(eq.data.data);
      const bp = await api.get('/compensation/bonus/plans');
      setBonusPlans(bp.data.data);
      if (c.data.data[0]) selectCycle(c.data.data[0]);
      const lk = await api.get('/org/lookups');
      setGrades(lk.data.data.grades); setDesignations(lk.data.data.designations);
      if (can('compensation.manage') || can('bonus.manage')) api.get('/employees?limit=200').then(({ data }) => setEmps(data.data)).catch(() => {});
    } catch (e) { toast(errMsg(e), true); }
  };
  useEffect(() => { load(); }, []); // eslint-disable-line

  const selectCycle = async (cycle) => {
    setActiveCycle(cycle);
    try { const { data } = await api.get(`/compensation/cycles/${cycle.id}/reviews`); setReviews(data.data); setTotals(data.totals); } catch (e) { toast(errMsg(e), true); }
  };

  const createBand = async () => {
    try {
      await api.post('/compensation/bands', { name: form.name, gradeId: form.gradeId ? Number(form.gradeId) : null, minAmount: Number(form.minAmount || 0), midAmount: Number(form.midAmount || 0), maxAmount: Number(form.maxAmount || 0), effectiveFrom: form.effectiveFrom || null });
      toast('Band created'); setModal(null); setForm({}); load();
    } catch (e) { toast(errMsg(e), true); }
  };

  const initCycle = async () => {
    try {
      const { data } = await api.post(`/compensation/cycles/${activeCycle.id}/init`);
      toast(`Initialized ${data.created} review(s) for ${data.total} employees`);
      selectCycle(activeCycle);
    } catch (e) { toast(errMsg(e), true); }
  };

  const saveReview = async (review, patch) => {
    try { await api.put(`/compensation/reviews/${review.id}`, patch); selectCycle(activeCycle); } catch (e) { toast(errMsg(e), true); }
  };

  const applyCycle = async () => {
    try {
      const eff = prompt('Effective date for new salaries (YYYY-MM-DD):', activeCycle.effective_date || new Date().toISOString().slice(0, 10));
      if (!eff) return;
      const { data } = await api.post(`/compensation/cycles/${activeCycle.id}/apply`, { effectiveDate: eff });
      toast(`Applied ${data.data.applied} increment(s) as new salary revisions`);
      selectCycle(activeCycle);
    } catch (e) { toast(errMsg(e), true); }
  };

  const createBonusPlan = async () => {
    try {
      await api.post('/compensation/bonus/plans', { name: form.name, planYear: Number(form.planYear || new Date().getFullYear()), btype: form.btype || 'performance', budget: Number(form.budget || 0) });
      toast('Bonus plan created'); setModal(null); setForm({}); load();
    } catch (e) { toast(errMsg(e), true); }
  };

  const addAward = async () => {
    try {
      await api.post(`/compensation/bonus/plans/${modal.plan.id}/awards`, { employeeId: Number(form.employeeId), amount: Number(form.amount || 0), reason: form.reason });
      toast('Award saved'); setModal(null); setForm({}); load();
    } catch (e) { toast(errMsg(e), true); }
  };

  if (!bands || !cycles) return <Spinner />;
  const setF = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <>
      <div className="mt"><Tabs active={tab} onChange={setTab} tabs={[
        { key: 'bands', label: 'Salary Bands' }, { key: 'cycles', label: 'Increment Cycles' },
        { key: 'bonus', label: 'Bonus Plans' }, { key: 'equity', label: 'Pay Equity' },
      ]} /></div>

      {tab === 'bands' && (
        <div className="card mt">
          <div className="card-h spread">
            <h3>Salary bands by grade</h3>
            {can('compensation.manage') && <button className="btn sm" onClick={() => setModal({ type: 'newBand' })}>New band</button>}
          </div>
          <DataTable
            columns={[
              { key: 'name', label: 'Band', render: (r) => <b>{r.name}</b> },
              { key: 'grade_id', label: 'Grade', render: (r) => grades.find((g) => g.id === r.grade_id)?.name || '—' },
              { key: 'min_amount', label: 'Min', align: 'right', render: (r) => money(r.min_amount) },
              { key: 'mid_amount', label: 'Mid', align: 'right', render: (r) => money(r.mid_amount) },
              { key: 'max_amount', label: 'Max', align: 'right', render: (r) => money(r.max_amount) },
              { key: 'effective_from', label: 'Effective', render: (r) => r.effective_from ? fmtDate(r.effective_from) : '—' },
              { key: 'status', label: 'Status', render: (r) => <StatusBadge value={r.status} /> },
            ]}
            rows={bands}
            emptyText="No salary bands defined"
          />
        </div>
      )}

      {tab === 'cycles' && (
        <>
          <div className="row mt" style={{ gap: 10, flexWrap: 'wrap' }}>
            {cycles.map((c) => (
              <button key={c.id} className={'btn sm' + (activeCycle?.id === c.id ? '' : ' secondary')} onClick={() => selectCycle(c)}>
                {c.name} · {c.status}
              </button>
            ))}
            {can('compensation.manage') && <button className="btn sm ghost" onClick={() => setModal({ type: 'newCycle' })}>New cycle</button>}
          </div>
          {activeCycle && (
            <div className="card mt">
              <div className="card-h spread">
                <h3>{activeCycle.name} — reviews {reviews ? `(${reviews.length})` : ''}</h3>
                <div className="row" style={{ gap: 8 }}>
                  {can('compensation.manage') && <>
                    <button className="btn sm secondary" onClick={initCycle}>Init from current salaries</button>
                    <button className="btn sm" onClick={applyCycle}>Apply approved increments</button>
                  </>}
                </div>
              </div>
              {totals && (
                <div className="stat-grid" style={{ padding: '0 14px' }}>
                  <StatCard label="Total current CTC" value={money(totals.totalCurrent)} />
                  <StatCard label="Total proposed CTC" value={money(totals.totalNew)} />
                  <StatCard label="Proposed bonus" value={money(totals.totalBonus)} />
                  <StatCard label="Promotions" value={totals.promotions} />
                </div>
              )}
              <DataTable
                columns={[
                  { key: 'employee_name', label: 'Employee', render: (r) => <><b>{r.employee_name}</b><div style={{ fontSize: 12.5, color: 'var(--muted)' }}>{r.designation} · {r.grade || '—'}</div></> },
                  { key: 'current_ctc', label: 'Current CTC', align: 'right', render: (r) => money(r.current_ctc) },
                  { key: 'proposed_increment_pct', label: 'Increment %', render: (r) => can('compensation.manage') && r.status === 'pending' ? (
                    <input type="number" step="0.5" defaultValue={r.proposed_increment_pct} style={{ width: 70 }}
                      onBlur={(e) => Number(e.target.value) !== Number(r.proposed_increment_pct) && saveReview(r, { proposed_increment_pct: Number(e.target.value) })} />
                  ) : `${r.proposed_increment_pct}%` },
                  { key: 'new_ctc', label: 'New CTC', align: 'right', render: (r) => money(r.new_ctc || (r.current_ctc * (1 + r.proposed_increment_pct / 100))) },
                  { key: 'proposed_bonus', label: 'Bonus', align: 'right', render: (r) => money(r.proposed_bonus) },
                  { key: 'promotion_flag', label: 'Promotion', render: (r) => can('compensation.manage') && r.status === 'pending' ? (
                    <input type="checkbox" checked={!!r.promotion_flag} onChange={(e) => saveReview(r, { promotion_flag: e.target.checked, new_designation_id: e.target.checked ? (designations[0]?.id || null) : null })} />
                  ) : (r.promotion_flag ? `→ ${r.proposed_designation || 'Yes'}` : '—') },
                  { key: 'status', label: 'Status', render: (r) => <StatusBadge value={r.status} labels={{ pending: ['amber', 'Pending'], approved: ['green', 'Approved'], rejected: ['red', 'Rejected'], applied: ['purple', 'Applied'] }} /> },
                ]}
                rows={reviews || []}
                emptyText="Click 'Init from current salaries' to populate reviews"
                actions={(r) => can('compensation.manage') && r.status === 'pending' ? (
                  <>
                    <button className="btn sm" onClick={() => saveReview(r, { status: 'approved' })}>Approve</button>
                    <button className="btn sm danger ghost" onClick={() => saveReview(r, { status: 'rejected' })}>Reject</button>
                  </>
                ) : null}
              />
            </div>
          )}
        </>
      )}

      {tab === 'bonus' && (
        <div className="card mt">
          <div className="card-h spread">
            <h3>Bonus plans</h3>
            {can('bonus.manage') && <button className="btn sm" onClick={() => setModal({ type: 'newBonusPlan' })}>New plan</button>}
          </div>
          <DataTable
            columns={[
              { key: 'name', label: 'Plan', render: (r) => <b>{r.name}</b> },
              { key: 'plan_year', label: 'Year' },
              { key: 'btype', label: 'Type', render: (r) => <StatusBadge value={r.btype} labels={{ performance: ['blue', 'Performance'], festival: ['amber', 'Festival'], incentive: ['green', 'Incentive'], retention: ['purple', 'Retention'], referral: ['gray', 'Referral'] }} /> },
              { key: 'budget', label: 'Budget', align: 'right', render: (r) => money(r.budget) },
              { key: 'status', label: 'Status', render: (r) => <StatusBadge value={r.status} /> },
            ]}
            rows={bonusPlans}
            emptyText="No bonus plans"
            actions={(r) => <button className="btn ghost sm" onClick={async () => {
              const { data } = await api.get(`/compensation/bonus/plans/${r.id}/awards`);
              setModal({ type: 'awards', plan: r, awards: data.data, total: data.total });
            }}>Awards</button>}
          />
        </div>
      )}

      {tab === 'equity' && (
        <div className="card mt">
          <div className="card-h"><h3>Pay equity — average CTC by designation, grade & gender</h3></div>
          {equity.length === 0 && <Empty text="No data" />}
          <div className="table-wrap">
            <table className="tbl">
              <thead><tr><th>Designation</th><th>Grade</th><th>Headcount</th><th>Avg CTC — Male</th><th>Avg CTC — Female</th><th>Gap</th></tr></thead>
              <tbody>
                {equity.map((r, i) => {
                  const gap = r.male && r.female ? Math.round(((r.female - r.male) / r.male) * 100) : null;
                  return (
                    <tr key={i}>
                      <td>{r.designation}</td><td>{r.grade || '—'}</td><td>{r.n}</td>
                      <td>{r.male ? money(r.male) : '—'}</td>
                      <td>{r.female ? money(r.female) : '—'}</td>
                      <td>{gap === null ? '—' : <span style={{ color: Math.abs(gap) > 10 ? '#b42318' : '#067647' }}>{gap > 0 ? '+' : ''}{gap}%</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: '8px 14px' }}>Small-n rows reflect demo data. Use with adequate population sizes for real decisions.</p>
        </div>
      )}

      {modal?.type === 'newBand' && (
        <Modal title="New salary band" onClose={() => setModal(null)} footer={<><button className="btn secondary" onClick={() => setModal(null)}>Cancel</button><button className="btn" onClick={createBand}>Create</button></>}>
          <TextField label="Band name *" value={form.name} onChange={setF('name')} />
          <SelectField label="Grade" value={form.gradeId} onChange={setF('gradeId')} options={grades.map((g) => ({ value: g.id, label: g.name }))} />
          <div className="row">
            <TextField label="Min (₹/yr)" type="number" value={form.minAmount} onChange={setF('minAmount')} />
            <TextField label="Mid (₹/yr)" type="number" value={form.midAmount} onChange={setF('midAmount')} />
            <TextField label="Max (₹/yr)" type="number" value={form.maxAmount} onChange={setF('maxAmount')} />
          </div>
          <TextField label="Effective from" type="date" value={form.effectiveFrom} onChange={setF('effectiveFrom')} />
        </Modal>
      )}

      {modal?.type === 'newCycle' && (
        <Modal title="New compensation cycle" onClose={() => setModal(null)} footer={<><button className="btn secondary" onClick={() => setModal(null)}>Cancel</button><button className="btn" onClick={async () => {
          try {
            await api.post('/compensation/cycles', { name: form.name, cycleYear: Number(form.cycleYear || new Date().getFullYear()), effectiveDate: form.effectiveDate, incrementBudgetPct: Number(form.budgetPct || 10) });
            toast('Cycle created'); setModal(null); setForm({}); load();
          } catch (e) { toast(errMsg(e), true); }
        }}>Create</button></>}>
          <TextField label="Cycle name *" value={form.name} onChange={setF('name')} placeholder={`Annual Increment ${new Date().getFullYear()}`} />
          <div className="row">
            <TextField label="Year *" type="number" value={form.cycleYear} onChange={setF('cycleYear')} />
            <TextField label="Effective date" type="date" value={form.effectiveDate} onChange={setF('effectiveDate')} />
          </div>
          <TextField label="Increment budget (%)" type="number" value={form.budgetPct} onChange={setF('budgetPct')} />
        </Modal>
      )}

      {modal?.type === 'newBonusPlan' && (
        <Modal title="New bonus plan" onClose={() => setModal(null)} footer={<><button className="btn secondary" onClick={() => setModal(null)}>Cancel</button><button className="btn" onClick={createBonusPlan}>Create</button></>}>
          <TextField label="Plan name *" value={form.name} onChange={setF('name')} />
          <div className="row">
            <TextField label="Year *" type="number" value={form.planYear} onChange={setF('planYear')} />
            <SelectField label="Type" value={form.btype} onChange={setF('btype')} options={[
              { value: 'performance', label: 'Performance' }, { value: 'festival', label: 'Festival' }, { value: 'incentive', label: 'Incentive' },
            ]} />
          </div>
          <TextField label="Budget (₹)" type="number" value={form.budget} onChange={setF('budget')} />
        </Modal>
      )}

      {modal?.type === 'awards' && (
        <Modal title={`Awards — ${modal.plan.name} (${money(modal.total)})`} onClose={() => setModal(null)} wide footer={
          <>
            <button className="btn secondary" onClick={() => setModal(null)}>Close</button>
            {can('bonus.manage') && <button className="btn" onClick={() => { setForm({}); setModal({ type: 'addAward', plan: modal.plan }); }}>Add award</button>}
          </>
        }>
          <DataTable
            columns={[
              { key: 'employee_name', label: 'Employee' },
              { key: 'amount', label: 'Amount', align: 'right', render: (r) => money(r.amount) },
              { key: 'pct_of_ctc', label: '% of CTC', render: (r) => r.pct_of_ctc ? `${r.pct_of_ctc}%` : '—' },
              { key: 'reason', label: 'Reason', render: (r) => r.reason || '—' },
              { key: 'status', label: 'Status', render: (r) => <StatusBadge value={r.status} labels={{ proposed: ['amber', 'Proposed'], approved: ['green', 'Approved'], paid: ['purple', 'Paid'] }} /> },
            ]}
            rows={modal.awards}
            emptyText="No awards yet"
            actions={(r) => can('bonus.manage') && r.status !== 'paid' ? (
              <button className="btn ghost sm" onClick={async () => {
                await api.put(`/compensation/bonus/awards/${r.id}/status`, { status: r.status === 'proposed' ? 'approved' : 'paid' });
                const { data } = await api.get(`/compensation/bonus/plans/${modal.plan.id}/awards`);
                setModal({ type: 'awards', plan: modal.plan, awards: data.data, total: data.total });
              }}>{r.status === 'proposed' ? 'Approve' : 'Mark paid'}</button>
            ) : null}
          />
        </Modal>
      )}

      {modal?.type === 'addAward' && (
        <Modal title={`Add award — ${modal.plan.name}`} onClose={() => setModal(null)} footer={<><button className="btn secondary" onClick={() => setModal(null)}>Back</button><button className="btn" onClick={addAward}>Save</button></>}>
          <SelectField label="Employee *" value={form.employeeId} onChange={setF('employeeId')} options={emps.map((e) => ({ value: e.id, label: `${e.first_name} ${e.last_name} (${e.employee_code})` }))} />
          <TextField label="Amount (₹)" type="number" value={form.amount} onChange={setF('amount')} />
          <TextField label="Reason" value={form.reason} onChange={setF('reason')} />
        </Modal>
      )}
    </>
  );
}
