import React, { useEffect, useState } from 'react';
import { api, errMsg, money2, fmtDate } from '../api';
import { useAuth } from '../auth';
import DataTable from '../components/DataTable';
import { Spinner, StatusBadge, useToast, Modal, TextField, SelectField, StatCard, Tabs, downloadFile } from '../components/ui';

const ATYPES = [
  { value: 'arrears', label: 'Arrears (unpaid salary)' },
  { value: 'back_pay', label: 'Back pay' },
  { value: 'correction', label: 'Correction' },
  { value: 'bonus', label: 'Bonus' },
  { value: 'deduction', label: 'Deduction' },
  { value: 'other', label: 'Other' },
];
const STATUSES = [
  { value: '', label: 'All statuses' },
  { value: 'draft', label: 'Draft' },
  { value: 'submitted', label: 'Submitted' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'applied', label: 'Applied to run' },
];
const COMPONENTS = [
  'Arrears', 'Back Pay', 'Correction', 'Bonus', 'F&F Settlement', 'Loan Recovery', 'Other',
];

const BLANK = {
  employeeId: '', atype: 'arrears', direction: 'earning', component: 'Arrears',
  description: '', amount: '', forPeriodYear: '', forPeriodMonth: '', originalRunId: '', reason: '', submit: true,
};

export default function PayrollAdjustments() {
  const { can } = useAuth();
  const toast = useToast();
  const [rows, setRows] = useState([]);
  const [summary, setSummary] = useState(null);
  const [employees, setEmployees] = useState([]);
  const [runs, setRuns] = useState([]);
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [tab, setTab] = useState('list');
  const [modal, setModal] = useState(null);
  const [form, setForm] = useState(BLANK);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const { data } = await api.get('/payroll/adjustments', { params: { status: status || undefined } });
      setRows(data.data || []);
      setSummary(data.summary || null);
    } catch (e) { toast(errMsg(e), true); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [status]);
  useEffect(() => {
    (async () => {
      try {
        const [e, r] = await Promise.all([api.get('/employees', { params: { limit: 500 } }), api.get('/payroll/runs')]);
        setEmployees((e.data.data || []).map((x) => ({ id: x.id, label: `${x.employee_code} — ${x.first_name} ${x.last_name}` })));
        setRuns((r.data.data || []).map((x) => ({ id: x.id, label: `${String(x.period_month).padStart(2, '0')}/${x.period_year} · ${x.status}` })));
      } catch (e) { /* lookups are optional */ }
    })();
  }, []);

  const setF = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));
  const openCreate = () => { setForm(BLANK); setModal('create'); };
  const openEdit = (r) => {
    setForm({
      id: r.id, employeeId: r.employee_id, atype: r.atype, direction: r.direction, component: r.component,
      description: r.description || '', amount: r.amount, forPeriodYear: r.for_period_year || '',
      forPeriodMonth: r.for_period_month || '', originalRunId: r.original_run_id || '', reason: r.reason || '', submit: false,
    });
    setModal('edit');
  };

  const save = async (submit) => {
    setBusy(true);
    try {
      const payload = {
        employeeId: Number(form.employeeId) || null,
        atype: form.atype, direction: form.direction, component: form.component,
        description: form.description || null, amount: Number(form.amount) || 0,
        forPeriodYear: form.forPeriodYear ? Number(form.forPeriodYear) : null,
        forPeriodMonth: form.forPeriodMonth ? Number(form.forPeriodMonth) : null,
        originalRunId: form.originalRunId ? Number(form.originalRunId) : null,
        reason: form.reason || null,
      };
      if (form.id) {
        await api.put(`/payroll/adjustments/${form.id}`, payload);
        if (submit) await api.post(`/payroll/adjustments/${form.id}/submit`);
      } else {
        await api.post('/payroll/adjustments', { ...payload, submit });
      }
      toast(form.id ? (submit ? 'Adjustment submitted' : 'Adjustment updated') : (submit ? 'Adjustment created & submitted' : 'Draft created'));
      setModal(null); load();
    } catch (e) { toast(errMsg(e), true); }
    finally { setBusy(false); }
  };

  const act = async (r, action) => {
    const comment = action === 'rejected' ? (window.prompt('Reason for rejection') || '') : '';
    try {
      await api.post(`/payroll/adjustments/${r.id}/action`, { action, comment });
      toast(`Adjustment ${action}`); load();
    } catch (e) { toast(errMsg(e), true); }
  };

  const submit = async (r) => { try { await api.post(`/payroll/adjustments/${r.id}/submit`); toast('Submitted'); load(); } catch (e) { toast(errMsg(e), true); } };
  const remove = async (r) => {
    if (!confirm('Delete this draft adjustment?')) return;
    try { await api.delete(`/payroll/adjustments/${r.id}`); toast('Deleted'); load(); } catch (e) { toast(errMsg(e), true); }
  };

  if (!can('payroll.view')) return <div className="card card-b">You do not have access to payroll adjustments.</div>;

  const csvUrl = `/api/payroll/adjustments?format=csv${status ? `&status=${status}` : ''}`;

  return (
    <>
      <div className="spread mb">
        <div>
          <h2 style={{ fontSize: 17 }}>Payroll Adjustments</h2>
          <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>
            Arrears, back-pay and corrections are booked immutably and only reach a payslip when a locked payroll run applies them.
          </div>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button className="btn ghost sm" onClick={() => downloadFile(csvUrl, 'payroll-adjustments.csv').catch((e) => toast(e.message, true))}>CSV</button>
          {can('payroll.adjust') && <button className="btn" onClick={openCreate}>+ New adjustment</button>}
        </div>
      </div>

      <div className="stat-grid">
        <StatCard label="Total" value={summary?.count ?? 0} sub={`${rows.length} shown`} />
        <StatCard label="Earnings" value={`₹${Number(summary?.earnings || 0).toLocaleString('en-IN')}`} />
        <StatCard label="Deductions" value={`₹${Number(summary?.deductions || 0).toLocaleString('en-IN')}`} />
        <StatCard label="Awaiting approval" value={summary?.pendingApproval ?? 0} accent={summary?.pendingApproval ? 'var(--warn)' : undefined} />
      </div>

      <div className="card mt">
        <div className="card-h spread">
          <Tabs active={tab} onChange={setTab} tabs={[{ key: 'list', label: 'All adjustments' }, { key: 'pending', label: 'Awaiting approval' }]} />
          <div className="row" style={{ gap: 8 }}>
            <input placeholder="Search employee, component…" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 200 }} />
            <SelectField value={status} onChange={setStatus} options={STATUSES} />
          </div>
        </div>
        <DataTable
          columns={[
            { key: 'employee_name', label: 'Employee', render: (r) => <><b>{r.employee_name}</b> <span style={{ color: 'var(--muted)' }}>{r.employee_code}</span></> },
            { key: 'atype', label: 'Type', render: (r) => (ATYPES.find((a) => a.value === r.atype)?.label || r.atype) },
            { key: 'component', label: 'Component', render: (r) => <>{r.component}{r.for_period_month ? <span style={{ color: 'var(--muted)' }}> · for {r.for_period_month}/{r.for_period_year}</span> : null}</> },
            { key: 'direction', label: 'Direction', render: (r) => <span className={'badge ' + (r.direction === 'deduction' ? 'red' : 'green')}>{r.direction}</span> },
            { key: 'amount', label: 'Amount', align: 'right', render: (r) => <b style={{ color: r.direction === 'deduction' ? 'var(--red)' : 'var(--green)' }}>{r.direction === 'deduction' ? '−' : '+'}{money2(r.amount)}</b> },
            { key: 'source_type', label: 'Source', render: (r) => (r.source_type ? <span className="badge">{r.source_type}</span> : 'Manual') },
            { key: 'status', label: 'Status', render: (r) => <StatusBadge value={r.status} /> },
            { key: 'applied_run_id', label: 'Applied in', render: (r) => (r.applied_run_id ? `Run #${r.applied_run_id}` : '—') },
          ]}
          rows={rows
            .filter((r) => !q.trim() || [r.employee_name, r.employee_code, r.component, r.description].some((v) => String(v || '').toLowerCase().includes(q.toLowerCase())))
            .filter((r) => (tab === 'pending' ? r.status === 'submitted' : true))}
          emptyText="No adjustments"
          actions={(r) => (
            <>
              {(r.status === 'draft' || r.status === 'rejected') && can('payroll.adjust') && (
                <>
                  <button className="btn ghost sm" onClick={() => openEdit(r)}>Edit</button>
                  <button className="btn sm" onClick={() => submit(r)}>Submit</button>
                  {r.status === 'draft' && <button className="btn ghost sm danger" onClick={() => remove(r)}>Delete</button>}
                </>
              )}
              {r.status === 'submitted' && can('payroll.adjust_approve') && (
                <>
                  <button className="btn sm success" onClick={() => act(r, 'approved')}>Approve</button>
                  <button className="btn sm danger ghost" onClick={() => act(r, 'rejected')}>Reject</button>
                </>
              )}
            </>
          )}
        />
      </div>

      {modal && (
        <Modal
          title={modal === 'edit' ? `Edit adjustment #${form.id}` : 'New payroll adjustment'}
          onClose={() => setModal(null)}
          footer={(
            <>
              <button className="btn secondary" onClick={() => setModal(null)}>Cancel</button>
              <button className="btn secondary" disabled={busy} onClick={() => save(false)}>Save draft</button>
              <button className="btn" disabled={busy || !form.employeeId || !Number(form.amount)} onClick={() => save(true)}>Save & submit</button>
            </>
          )}
        >
          <SelectField label="Employee *" value={form.employeeId} onChange={setF('employeeId')} options={[{ value: '', label: '— Select —' }, ...employees]} />
          <div className="row">
            <SelectField label="Type" value={form.atype} onChange={setF('atype')} options={ATYPES} />
            <SelectField label="Direction" value={form.direction} onChange={setF('direction')} options={[{ value: 'earning', label: 'Earning (+)' }, { value: 'deduction', label: 'Deduction (−)' }]} />
          </div>
          <div className="row">
            <TextField label="Component *" value={form.component} onChange={setF('component')} />
            <TextField label="Amount *" type="number" value={form.amount} onChange={setF('amount')} />
          </div>
          <TextField label="Description" value={form.description} onChange={setF('description')} placeholder="Shown on the payslip" />
          <div className="row">
            <TextField label="For period — year" type="number" value={form.forPeriodYear} onChange={setF('forPeriodYear')} hint="Optional" />
            <TextField label="For period — month" type="number" min="1" max="12" value={form.forPeriodMonth} onChange={setF('forPeriodMonth')} hint="1–12, optional" />
          </div>
          <SelectField
            label="Corrects a locked/paid run"
            value={form.originalRunId}
            onChange={setF('originalRunId')}
            options={[{ value: '', label: '— Not a correction —' }, ...runs]}
            hint="Only locked or paid runs can be corrected"
          />
          <TextField label="Reason" value={form.reason} onChange={setF('reason')} hint="Recorded in the audit trail" />
        </Modal>
      )}
    </>
  );
}