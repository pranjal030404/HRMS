import React, { useEffect, useState } from 'react';
import { api, errMsg, money } from '../api';
import { useAuth } from '../auth';
import DataTable from '../components/DataTable';
import { Spinner, useToast, Modal, TextField, SelectField, Tabs, StatCard, Empty, BarList } from '../components/ui';

export default function WorkforcePlanning() {
  const { can } = useAuth();
  const toast = useToast();
  const [tab, setTab] = useState('plan');
  const [year, setYear] = useState(new Date().getFullYear());
  const [rows, setRows] = useState(null);
  const [summary, setSummary] = useState(null);
  const [vacancies, setVacancies] = useState(null);
  const [departments, setDepartments] = useState([]);
  const [designations, setDesignations] = useState([]);
  const [modal, setModal] = useState(null);
  const [form, setForm] = useState({});

  const load = async () => {
    try {
      const [r, s, v] = await Promise.all([
        api.get(`/workforce?year=${year}`), api.get(`/workforce/summary?year=${year}`), api.get('/workforce/vacancies'),
      ]);
      setRows(r.data.data); setSummary(s.data.data); setVacancies(v.data.data);
      const lk = await api.get('/org/lookups');
      setDepartments(lk.data.data.departments); setDesignations(lk.data.data.designations);
    } catch (e) { toast(errMsg(e), true); }
  };
  useEffect(() => { load(); }, [year]); // eslint-disable-line

  const upsert = async () => {
    try {
      await api.post('/workforce', {
        planYear: Number(form.planYear || year), quarter: Number(form.quarter || 1),
        departmentId: Number(form.departmentId), designationId: form.designationId ? Number(form.designationId) : null,
        plannedCount: Number(form.plannedCount || 0), budgetCtc: Number(form.budgetCtc || 0),
        scenario: form.scenario || 'base', notes: form.notes,
      });
      toast('Plan saved'); setModal(null); setForm({}); load();
    } catch (e) { toast(errMsg(e), true); }
  };

  if (!rows || !summary) return <Spinner />;
  const setF = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <>
      <div className="spread mt">
        <div className="row" style={{ gap: 10 }}>
          <select value={year} onChange={(e) => setYear(Number(e.target.value))}>
            {[year - 1, year, year + 1].map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>
        {can('workforce.manage') && <button className="btn sm" onClick={() => { setForm({ planYear: year }); setModal({ type: 'upsert' }); }}>Add / update plan</button>}
      </div>

      <div className="stat-grid mt">
        <StatCard label="Planned headcount" value={summary.plannedTotal} />
        <StatCard label="Actual headcount" value={summary.actualTotal} />
        <StatCard label="Vacancies (planned − actual)" value={summary.vacancies} accent={summary.vacancies > 0 ? 'var(--red, #b42318)' : '#067647'} />
        <StatCard label="Planned workforce cost" value={money(summary.plannedCost)} />
        <StatCard label="Actual workforce cost" value={money(summary.actualCost)} />
      </div>

      <div className="mt"><Tabs active={tab} onChange={setTab} tabs={[
        { key: 'plan', label: 'Headcount Plan' }, { key: 'scenarios', label: 'Planned vs Actual' }, { key: 'vacancies', label: 'Open Positions' },
      ]} /></div>

      {tab === 'plan' && (
        <div className="card mt">
          <div className="card-h"><h3>Headcount plan {year}</h3></div>
          <DataTable
            columns={[
              { key: 'quarter', label: 'Qtr', render: (r) => `Q${r.quarter}` },
              { key: 'department_name', label: 'Department' },
              { key: 'designation_name', label: 'Designation', render: (r) => r.designation_name || 'All roles' },
              { key: 'scenario', label: 'Scenario', render: (r) => r.scenario },
              { key: 'planned_count', label: 'Planned', align: 'right' },
              { key: 'actual_count', label: 'Actual', align: 'right' },
              { key: 'variance', label: 'Variance', align: 'right', render: (r) => {
                const v = r.actual_count - r.planned_count;
                return <span style={{ color: v < 0 ? '#b42318' : '#067647' }}>{v > 0 ? '+' : ''}{v}</span>;
              } },
              { key: 'budget_ctc', label: 'Budget CTC', align: 'right', render: (r) => money(r.budget_ctc) },
            ]}
            rows={rows}
            emptyText="No headcount plan rows for this year"
            actions={(r) => can('workforce.manage') ? (
              <button className="btn ghost sm" onClick={async () => { await api.delete(`/workforce/${r.id}`); toast('Removed'); load(); }}>Delete</button>
            ) : null}
          />
        </div>
      )}

      {tab === 'scenarios' && (
        <div className="grid2 mt">
          <div className="card">
            <div className="card-h"><h3>Planned vs actual by department</h3></div>
            {summary.actuals.length === 0 && <Empty text="No departments" />}
            {summary.actuals.map((a) => {
              const plannedQ = summary.rows.filter((r) => r.department === a.department).reduce((x, r) => x + Number(r.planned || 0), 0) || null;
              return (
                <div key={a.department} className="bar-row">
                  <div className="bar-lbl" title={a.department}>{a.department}</div>
                  <div className="bar-track">
                    <div className="bar-fill" style={{ width: `${(a.actual / Math.max(1, plannedQ || a.actual)) * 100}%`, background: 'var(--primary)' }} />
                    {plannedQ && <div style={{ position: 'absolute', left: `${Math.min(100, (plannedQ / Math.max(1, plannedQ)) * 100)}%`, top: -2, bottom: -2, width: 2, background: '#f79009' }} />}
                  </div>
                  <div className="bar-val">{a.actual}{plannedQ ? ` / ${plannedQ}` : ''}</div>
                </div>
              );
            })}
            <p style={{ fontSize: 12, color: 'var(--muted)', padding: '6px 14px' }}>Orange marker = planned level. Bars = actual headcount.</p>
          </div>
          <div className="card">
            <div className="card-h"><h3>Planned workforce cost by quarter</h3></div>
            <BarList valueFormat={(v) => money(v)} data={[1, 2, 3, 4].map((q) => ({
              label: `Q${q}`,
              value: summary.rows.filter((r) => r.quarter === q).reduce((a, r) => a + Number(r.budget || 0), 0),
            }))} />
          </div>
        </div>
      )}

      {tab === 'vacancies' && (
        <div className="card mt">
          <div className="card-h"><h3>Open positions (planned beyond current headcount)</h3></div>
          <DataTable
            columns={[
              { key: 'plan_year', label: 'Year' },
              { key: 'quarter', label: 'Qtr', render: (r) => `Q${r.quarter}` },
              { key: 'department', label: 'Department' },
              { key: 'designation', label: 'Role', render: (r) => r.designation || 'All roles' },
              { key: 'planned_count', label: 'Planned', align: 'right' },
              { key: 'actual_count', label: 'Actual', align: 'right' },
              { key: 'gap', label: 'Gap', align: 'right', render: (r) => <b style={{ color: '#b42318' }}>{r.planned_count - r.actual_count}</b> },
              { key: 'open_requisitions', label: 'Reqs open', align: 'right' },
            ]}
            rows={vacancies}
            emptyText="No gaps — plan fully staffed"
          />
        </div>
      )}

      {modal?.type === 'upsert' && (
        <Modal title="Add / update headcount plan" onClose={() => setModal(null)} footer={<><button className="btn secondary" onClick={() => setModal(null)}>Cancel</button><button className="btn" onClick={upsert}>Save</button></>}>
          <div className="row">
            <TextField label="Year *" type="number" value={form.planYear} onChange={setF('planYear')} />
            <SelectField label="Quarter" value={form.quarter} onChange={setF('quarter')} options={[1, 2, 3, 4].map((q) => ({ value: q, label: `Q${q}` }))} />
          </div>
          <SelectField label="Department *" value={form.departmentId} onChange={setF('departmentId')} options={departments.map((d) => ({ value: d.id, label: d.name }))} />
          <SelectField label="Designation (optional)" value={form.designationId} onChange={setF('designationId')} options={designations.map((d) => ({ value: d.id, label: d.name }))} />
          <div className="row">
            <TextField label="Planned headcount" type="number" value={form.plannedCount} onChange={setF('plannedCount')} />
            <TextField label="Budget CTC (₹/yr)" type="number" value={form.budgetCtc} onChange={setF('budgetCtc')} />
          </div>
          <SelectField label="Scenario" value={form.scenario} onChange={setF('scenario')} options={[
            { value: 'base', label: 'Base' }, { value: 'aggressive', label: 'Aggressive growth' }, { value: 'conservative', label: 'Conservative' },
          ]} />
          <TextField label="Notes" value={form.notes} onChange={setF('notes')} />
        </Modal>
      )}
    </>
  );
}
