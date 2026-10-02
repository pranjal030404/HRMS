import React, { useEffect, useState } from 'react';
import { api, errMsg, money, fmtDate } from '../../api';
import { useAuth } from '../../auth';
import DataTable from '../../components/DataTable';
import { Spinner, StatusBadge, useToast, Modal, TextField, SelectField, Empty } from '../../components/ui';

export default function MyTravel() {
  const { me } = useAuth();
  const toast = useToast();
  const [rows, setRows] = useState(null);
  const [modal, setModal] = useState(null);
  const [form, setForm] = useState({});

  const load = async () => {
    try {
      const { data } = await api.get('/travel');
      setRows(data.data.filter((r) => r.employee_id === me?.employee_id));
    } catch (e) { toast(errMsg(e), true); }
  };
  useEffect(() => { load(); }, []); // eslint-disable-line

  const createRequest = async () => {
    try {
      await api.post('/travel', {
        purpose: form.purpose, destination: form.destination, startDate: form.startDate, endDate: form.endDate,
        estimatedCost: Number(form.estimatedCost || 0), travelMode: form.travelMode, advanceAmount: Number(form.advanceAmount || 0),
      });
      toast('Travel request submitted for approval');
      setModal(null); setForm({}); load();
    } catch (e) { toast(errMsg(e), true); }
  };

  const settle = async (r) => {
    try {
      const amountSpent = prompt('Total amount spent on this trip (₹):');
      if (!amountSpent) return;
      const { data } = await api.post(`/travel/${r.id}/settlement`, { amountSpent: Number(amountSpent) });
      toast(`Settlement submitted — payable ${money(data.data.payable)}`);
      load();
    } catch (e) { toast(errMsg(e), true); }
  };

  if (!rows) return <Spinner />;
  const setF = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <>
      <div className="card">
        <div className="card-h spread">
          <h3>My travel requests</h3>
          <button className="btn sm" onClick={() => setModal({ type: 'newRequest' })}>New request</button>
        </div>
        <DataTable
          columns={[
            { key: 'trno', label: 'Ref #', render: (r) => <b>{r.trno}</b> },
            { key: 'purpose', label: 'Purpose', render: (r) => <>{r.purpose}<div style={{ fontSize: 12.5, color: 'var(--muted)' }}>{r.destination || '—'}</div></> },
            { key: 'dates', label: 'Dates', render: (r) => `${fmtDate(r.start_date)} → ${fmtDate(r.end_date)}` },
            { key: 'estimated_cost', label: 'Est. cost', align: 'right', render: (r) => money(r.estimated_cost) },
            { key: 'advance_issued', label: 'Advance', align: 'right', render: (r) => r.advance_issued ? money(r.advance_issued) : '—' },
            { key: 'status', label: 'Status', render: (r) => <StatusBadge value={r.status} /> },
            { key: 'settlement_status', label: 'Settlement', render: (r) => <StatusBadge value={r.settlement_status} labels={{ not_required: ['gray', '—'], pending: ['amber', 'Pending'], settled: ['green', 'Settled'] }} /> },
          ]}
          rows={rows}
          emptyText="No travel requests yet — raise one when you plan a work trip"
          actions={(r) => r.status === 'approved' && r.settlement_status !== 'settled' ? (
            <button className="btn ghost sm" onClick={() => settle(r)}>Submit settlement</button>
          ) : null}
        />
      </div>

      {modal?.type === 'newRequest' && (
        <Modal title="New travel request" onClose={() => setModal(null)} footer={<><button className="btn secondary" onClick={() => setModal(null)}>Cancel</button><button className="btn" onClick={createRequest}>Submit</button></>}>
          <TextField label="Purpose *" value={form.purpose} onChange={setF('purpose')} placeholder="Client visit, conference…" />
          <TextField label="Destination" value={form.destination} onChange={setF('destination')} />
          <div className="row">
            <TextField label="Start date" type="date" value={form.startDate} onChange={setF('startDate')} />
            <TextField label="End date" type="date" value={form.endDate} onChange={setF('endDate')} />
          </div>
          <div className="row">
            <TextField label="Estimated cost (₹)" type="number" value={form.estimatedCost} onChange={setF('estimatedCost')} />
            <SelectField label="Mode" value={form.travelMode} onChange={setF('travelMode')} options={[
              { value: 'flight', label: 'Flight' }, { value: 'train', label: 'Train' }, { value: 'cab', label: 'Cab' },
              { value: 'bus', label: 'Bus' }, { value: 'personal_vehicle', label: 'Personal vehicle (mileage)' },
            ]} />
          </div>
          <TextField label="Advance requested (₹)" type="number" value={form.advanceAmount} onChange={setF('advanceAmount')} hint="Optional — issued after approval" />
        </Modal>
      )}
    </>
  );
}
