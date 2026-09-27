import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, errMsg, money, MONTHS } from '../api';
import { useAuth } from '../auth';
import DataTable from '../components/DataTable';
import { Spinner, StatusBadge, useToast, Modal, TextField, SelectField } from '../components/ui';

export default function PayrollRuns() {
  const { can } = useAuth();
  const nav = useNavigate();
  const toast = useToast();
  const [rows, setRows] = useState(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({});

  const load = async () => {
    try {
      const { data } = await api.get('/payroll/runs');
      setRows(data.data);
    } catch (e) { toast(errMsg(e), true); }
  };
  useEffect(() => { load(); }, []);

  const create = async () => {
    try {
      const { data } = await api.post('/payroll/runs', form);
      toast('Payroll period opened — now run calculation');
      setCreating(false);
      nav(`/payroll/${data.data.id}`);
    } catch (e) { toast(errMsg(e), true); }
  };

  if (!rows) return <Spinner />;

  return (
    <>
      <DataTable
        columns={[
          { key: 'period_month', label: 'Period', render: (r) => `${MONTHS[r.period_month - 1]} ${r.period_year}`, sortValue: (r) => r.period_year * 100 + r.period_month },
          { key: 'status', label: 'Status', render: (r) => <StatusBadge value={r.status} /> },
          { key: 'headcount', label: 'Headcount', align: 'right', render: (r) => r.totals?.headcount ?? '—' },
          { key: 'gross', label: 'Gross', align: 'right', render: (r) => (r.totals?.gross != null ? money(r.totals.gross) : '—') },
          { key: 'net_paid', label: 'Net paid', align: 'right', render: (r) => (r.totals?.net != null ? money(r.totals.net) : '—') },
          { key: 'employer_cost', label: 'Employer cost', align: 'right', render: (r) => (r.totals?.employerCost != null ? money(r.totals.employerCost) : '—') },
          { key: 'exceptions', label: 'Exceptions', render: (r) => (r.exceptions?.length ? <span className="badge amber">{r.exceptions.length}</span> : <span className="badge green">Clean</span>) },
        ]}
        rows={rows}
        emptyText="No payroll runs yet"
        toolbar={can('payroll.calculate') && <button className="btn sm" onClick={() => { const n = new Date(); setForm({ month: n.getMonth() + 1, year: n.getFullYear() }); setCreating(true); }}>+ Open payroll period</button>}
        onRowClick={(r) => nav(`/payroll/${r.id}`)}
        actions={(r) => <button className="btn ghost sm" onClick={() => nav(`/payroll/${r.id}`)}>Open</button>}
      />
      {creating && (
        <Modal title="Open payroll period" onClose={() => setCreating(false)} footer={
          <><button className="btn secondary" onClick={() => setCreating(false)}>Cancel</button><button className="btn" onClick={create}>Open</button></>
        }>
          <SelectField label="Month" value={form.month} onChange={(v) => setForm((f) => ({ ...f, month: Number(v) }))} options={MONTHS.map((m, i) => ({ value: i + 1, label: m }))} />
          <SelectField label="Year" value={form.year} onChange={(v) => setForm((f) => ({ ...f, year: Number(v) }))} options={[new Date().getFullYear(), new Date().getFullYear() - 1].map((y) => ({ value: y, label: y }))} />
        </Modal>
      )}
    </>
  );
}
