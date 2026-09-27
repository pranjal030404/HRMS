import React, { useEffect, useState } from 'react';
import { api, errMsg, money2, MONTHS } from '../api';
import DataTable from '../components/DataTable';
import { Spinner, StatusBadge, useToast, Modal, TextField, SelectField } from '../components/ui';
import { useAuth } from '../auth';

export default function Loans() {
  const { can } = useAuth();
  const toast = useToast();
  const [rows, setRows] = useState(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({});
  const [emps, setEmps] = useState([]);
  const [schedule, setSchedule] = useState(null);

  const load = async () => {
    try {
      const { data } = await api.get('/loans');
      setRows(data.data);
    } catch (e) { toast(errMsg(e), true); }
  };
  useEffect(() => {
    load();
    if (can('loan.manage')) api.get('/employees?limit=100').then(({ data }) => setEmps(data.data)).catch(() => {});
  }, []); // eslint-disable-line

  const save = async () => {
    try {
      const now = new Date();
      await api.post('/loans', {
        ...form,
        employeeId: Number(form.employeeId),
        principal: Number(form.principal),
        emiAmount: Number(form.emiAmount),
        tenureMonths: Number(form.tenureMonths),
        interestRate: Number(form.interestRate || 0),
        startMonth: now.getMonth() + 1,
        startYear: now.getFullYear(),
      });
      toast('Loan created — EMI schedule generated, deductions begin after approval');
      setAdding(false);
      load();
    } catch (e) { toast(errMsg(e), true); }
  };

  const act = async (id, action) => {
    try {
      await api.post(`/loans/${id}/${action}`);
      toast(`Loan ${action === 'approve' ? 'approved & disbursed' : action + 'd'}`);
      load();
    } catch (e) { toast(errMsg(e), true); }
  };

  const openSchedule = async (loan) => {
    try {
      const { data } = await api.get(`/loans/${loan.id}/schedule`);
      setSchedule(data.data);
    } catch (e) { toast(errMsg(e), true); }
  };

  if (!rows) return <Spinner />;
  const setF = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <>
      <DataTable
        columns={[
          { key: 'employee_code', label: 'Code' },
          { key: 'first_name', label: 'Employee', render: (r) => `${r.first_name} ${r.last_name}` },
          { key: 'title', label: 'Loan' },
          { key: 'principal', label: 'Principal', align: 'right', render: (r) => money2(r.principal) },
          { key: 'emi_amount', label: 'EMI', align: 'right', render: (r) => money2(r.emi_amount) },
          { key: 'tenure_months', label: 'Tenure', align: 'right', render: (r) => `${r.tenure_months} mo` },
          { key: 'outstanding', label: 'Outstanding', align: 'right', render: (r) => money2(r.outstanding) },
          { key: 'status', label: 'Status', render: (r) => <StatusBadge value={r.status} labels={{ active: ['green', 'Active'], pending: ['amber', 'Pending'] }} /> },
        ]}
        rows={rows}
        emptyText="No loans or advances"
        toolbar={can('loan.manage') && <button className="btn sm" onClick={() => setAdding(true)}>+ New loan / advance</button>}
        actions={(r) => (
          <>
            <button className="btn ghost sm" onClick={() => openSchedule(r)}>Schedule</button>
            {can('loan.manage') && r.status === 'pending' && <button className="btn sm success" onClick={() => act(r.id, 'approve')}>Approve</button>}
            {can('loan.manage') && r.status === 'active' && <button className="btn sm secondary" onClick={() => act(r.id, 'pause')}>Pause</button>}
            {can('loan.manage') && r.status === 'active' && <button className="btn sm secondary" onClick={() => act(r.id, 'close')}>Close</button>}
          </>
        )}
      />
      {adding && (
        <Modal title="New loan / salary advance" onClose={() => setAdding(false)} footer={
          <><button className="btn secondary" onClick={() => setAdding(false)}>Cancel</button><button className="btn" onClick={save}>Create loan</button></>
        }>
          <SelectField label="Employee *" value={form.employeeId} onChange={setF('employeeId')} options={emps.map((e) => ({ value: e.id, label: `${e.first_name} ${e.last_name} (${e.employee_code})` }))} />
          <div className="form-grid">
            <SelectField label="Type" value={form.ltype} onChange={setF('ltype')} options={[{ value: 'loan', label: 'Loan' }, { value: 'advance', label: 'Salary advance' }]} />
            <TextField label="Title" value={form.title} onChange={setF('title')} />
            <TextField label="Principal (₹) *" type="number" value={form.principal} onChange={setF('principal')} />
            <TextField label="EMI amount (₹) *" type="number" value={form.emiAmount} onChange={setF('emiAmount')} />
            <TextField label="Tenure (months) *" type="number" value={form.tenureMonths} onChange={setF('tenureMonths')} />
            <TextField label="Interest rate (%)" type="number" value={form.interestRate} onChange={setF('interestRate')} hint="0 for interest-free" />
          </div>
          <p className="hint" style={{ fontSize: 12, color: 'var(--muted)' }}>
            EMI deductions start from the current month's payroll run (when it is calculated) and stop automatically when the loan closes.
          </p>
        </Modal>
      )}
      {schedule && (
        <Modal title="Installment schedule" onClose={() => setSchedule(null)}>
          <table className="tbl">
            <thead><tr><th>#</th><th>Due</th><th className="num">Amount</th><th>Status</th></tr></thead>
            <tbody>
              {schedule.map((li) => (
                <tr key={li.id}>
                  <td>{li.installment_no}</td>
                  <td>{MONTHS[li.due_month - 1]} {li.due_year}</td>
                  <td className="num">{money2(li.amount)}</td>
                  <td><StatusBadge value={li.status} labels={{ deducted: ['green', 'Deducted'], pending: ['amber', 'Pending'], skipped: ['gray', 'Skipped'] }} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Modal>
      )}
    </>
  );
}
