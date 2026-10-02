import React, { useEffect, useState } from 'react';
import { api, errMsg, money, fmtDate } from '../api';
import { useAuth } from '../auth';
import DataTable from '../components/DataTable';
import { Spinner, StatusBadge, useToast, Modal, TextField, SelectField, Tabs, StatCard, Empty } from '../components/ui';

export default function Travel() {
  const { can, me } = useAuth();
  const toast = useToast();
  const [tab, setTab] = useState('requests');
  const [rows, setRows] = useState(null);
  const [detail, setDetail] = useState(null);
  const [analytics, setAnalytics] = useState(null);
  const [modal, setModal] = useState(null);
  const [form, setForm] = useState({});

  const load = async () => {
    try {
      const [tr] = await Promise.all([api.get('/travel')]);
      setRows(tr.data.data);
      api.get('/travel/analytics/summary').then(({ data }) => setAnalytics(data.data)).catch(() => {});
    } catch (e) { toast(errMsg(e), true); }
  };
  useEffect(() => { load(); }, []); // eslint-disable-line

  const openDetail = async (r) => {
    try { const { data } = await api.get(`/travel/${r.id}`); setDetail(data.data); } catch (e) { toast(errMsg(e), true); }
  };

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

  const approve = async (id, action) => {
    try {
      const comment = action === 'rejected' ? (prompt('Rejection comment (optional)') || '') : '';
      await api.put(`/travel/${id}/approve`, { action, comment });
      toast(`Request ${action}`);
      setDetail(null); load();
    } catch (e) { toast(errMsg(e), true); }
  };

  if (!rows) return <Spinner />;
  const setF = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <>
      {analytics && (
        <div className="stat-grid">
          <StatCard label="Pending approvals" value={analytics.pendingApprovals} />
          <StatCard label="Total settled spend" value={money(analytics.totalSpend)} />
          {(analytics.byStatus || []).slice(0, 3).map((s) => <StatCard key={s.status} label={`Requests: ${s.status}`} value={s.n} />)}
        </div>
      )}

      <div className="mt"><Tabs active={tab} onChange={setTab} tabs={[
        { key: 'requests', label: 'Travel Requests' }, { key: 'analytics', label: 'Travel Analytics' },
      ]} /></div>

      {tab === 'requests' && (
        <div className="card mt">
          <div className="card-h spread">
            <h3>Travel requests</h3>
            {can('travel.create') && me?.employee_id && <button className="btn sm" onClick={() => setModal({ type: 'newRequest' })}>New request</button>}
          </div>
          <DataTable
            columns={[
              { key: 'trno', label: 'Ref #', render: (r) => <b>{r.trno}</b> },
              { key: 'employee_name', label: 'Traveller', render: (r) => <>{r.employee_name}<div style={{ fontSize: 12.5, color: 'var(--muted)' }}>{r.employee_code}</div></> },
              { key: 'purpose', label: 'Purpose', render: (r) => <>{r.purpose}<div style={{ fontSize: 12.5, color: 'var(--muted)' }}>{r.destination || '—'}</div></> },
              { key: 'dates', label: 'Dates', render: (r) => `${fmtDate(r.start_date)} → ${fmtDate(r.end_date)}` },
              { key: 'estimated_cost', label: 'Est. cost', align: 'right', render: (r) => money(r.estimated_cost) },
              { key: 'advance_issued', label: 'Advance', align: 'right', render: (r) => r.advance_issued ? money(r.advance_issued) : '—' },
              { key: 'status', label: 'Status', render: (r) => <StatusBadge value={r.status} /> },
              { key: 'settlement_status', label: 'Settlement', render: (r) => <StatusBadge value={r.settlement_status} labels={{ not_required: ['gray', '—'], pending: ['amber', 'Pending'], settled: ['green', 'Settled'] }} /> },
            ]}
            rows={rows}
            emptyText="No travel requests"
            actions={(r) => <button className="btn ghost sm" onClick={() => openDetail(r)}>Open</button>}
          />
        </div>
      )}

      {tab === 'analytics' && (
        <div className="grid2 mt">
          <div className="card">
            <div className="card-h"><h3>Top destinations</h3></div>
            {analytics?.topDestinations?.length ? analytics.topDestinations.map((d) => (
              <div key={d.destination} className="spread" style={{ padding: '8px 14px', borderBottom: '1px solid var(--border)' }}>
                <span>{d.destination}</span><b>{d.trips} trip(s)</b>
              </div>
            )) : <Empty text="No travel yet" />}
          </div>
          <div className="card">
            <div className="card-h"><h3>Requests by status</h3></div>
            {analytics?.byStatus?.length ? analytics.byStatus.map((s) => (
              <div key={s.status} className="spread" style={{ padding: '8px 14px', borderBottom: '1px solid var(--border)' }}>
                <StatusBadge value={s.status} /><b>{s.n}</b>
              </div>
            )) : <Empty text="No data" />}
          </div>
        </div>
      )}

      {detail && (
        <Modal title={`${detail.trno} — ${detail.purpose}`} onClose={() => setDetail(null)} wide footer={
          <>
            <button className="btn secondary" onClick={() => setDetail(null)}>Close</button>
            {can('travel.approve') && detail.status === 'pending' && <>
              <button className="btn danger" onClick={() => approve(detail.id, 'rejected')}>Reject</button>
              <button className="btn" onClick={() => approve(detail.id, 'approved')}>Approve</button>
            </>}
            {detail.employee_id === me?.employee_id && detail.status === 'approved' && detail.settlement_status !== 'settled' &&
              <button className="btn" onClick={() => { setForm({}); setModal({ type: 'settle', request: detail }); }}>Submit settlement</button>}
          </>
        }>
          <div className="row" style={{ gap: 8, marginBottom: 8 }}>
            <StatusBadge value={detail.status} />
            <span style={{ color: 'var(--muted)', fontSize: 13 }}>{detail.employee_name} · {fmtDate(detail.start_date)} → {fmtDate(detail.end_date)} · {detail.travel_mode}</span>
          </div>
          <p style={{ fontSize: 13.5, color: 'var(--muted)' }}>Estimated cost {money(detail.estimated_cost)}{detail.approver_comment ? ` · Approver: "${detail.approver_comment}"` : ''}</p>

          <h4>Advances</h4>
          {detail.advances.length === 0 && <div style={{ color: 'var(--muted)', fontSize: 13 }}>None</div>}
          {detail.advances.map((a) => (
            <div key={a.id} className="spread" style={{ padding: '6px 0', borderBottom: '1px solid var(--border)', fontSize: 13.5 }}>
              <span>{money(a.amount)} <StatusBadge value={a.status} /></span>
              {a.status === 'requested' && can('travel.manage') && (
                <button className="btn sm ghost" onClick={async () => { await api.post(`/travel/${detail.id}/advances/${a.id}/issue`, {}); toast('Advance issued'); openDetail(detail); load(); }}>Mark issued</button>
              )}
            </div>
          ))}

          <h4 style={{ marginTop: 12 }}>Bookings</h4>
          {detail.bookings.length === 0 && <div style={{ color: 'var(--muted)', fontSize: 13 }}>None</div>}
          {detail.bookings.map((b) => (
            <div key={b.id} className="spread" style={{ padding: '6px 0', borderBottom: '1px solid var(--border)', fontSize: 13.5 }}>
              <span>{b.mode} · {b.provider || '—'} · {b.reference || '—'}</span><b>{money(b.amount)}</b>
            </div>
          ))}
          {can('travel.manage') && (
            <button className="btn ghost sm" style={{ marginTop: 8 }} onClick={() => { setForm({}); setModal({ type: 'booking', request: detail }); }}>Add booking</button>
          )}

          <h4 style={{ marginTop: 12 }}>Settlements</h4>
          {detail.settlements.length === 0 && <div style={{ color: 'var(--muted)', fontSize: 13 }}>None</div>}
          {detail.settlements.map((s) => (
            <div key={s.id} className="spread" style={{ padding: '6px 0', borderBottom: '1px solid var(--border)', fontSize: 13.5 }}>
              <span>Spent {money(s.amount_spent)} · advance {money(s.advance_adjusted)} · <b>payable {money(s.payable)}</b></span>
              <span className="spread" style={{ gap: 8 }}><StatusBadge value={s.status} />
                {s.status === 'submitted' && can('travel.manage') && (
                  <button className="btn sm ghost" onClick={async () => { await api.put(`/travel/${detail.id}/settlement/${s.id}/approve`, {}); toast('Settled'); openDetail(detail); load(); }}>Approve & pay</button>
                )}
              </span>
            </div>
          ))}
        </Modal>
      )}

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
              { value: 'flight', label: 'Flight' }, { value: 'train', label: 'Train' }, { value: 'cab', label: 'Cab' }, { value: 'bus', label: 'Bus' }, { value: 'personal_vehicle', label: 'Personal vehicle (mileage)' },
            ]} />
          </div>
          <TextField label="Advance requested (₹)" type="number" value={form.advanceAmount} onChange={setF('advanceAmount')} hint="Optional — finance issues after approval" />
        </Modal>
      )}

      {modal?.type === 'booking' && (
        <Modal title="Add booking" onClose={() => setModal(null)} footer={<><button className="btn secondary" onClick={() => setModal(null)}>Cancel</button><button className="btn" onClick={async () => {
          try {
            await api.post(`/travel/${modal.request.id}/bookings`, { mode: form.mode, provider: form.provider, reference: form.reference, bookedOn: form.bookedOn, amount: Number(form.amount || 0) });
            toast('Booking added'); setModal(null); openDetail(modal.request); load();
          } catch (e) { toast(errMsg(e), true); }
        }}>Save</button></>}>
          <SelectField label="Mode" value={form.mode} onChange={setF('mode')} options={[
            { value: 'flight', label: 'Flight' }, { value: 'train', label: 'Train' }, { value: 'cab', label: 'Cab' }, { value: 'hotel', label: 'Hotel' }, { value: 'bus', label: 'Bus' },
          ]} />
          <TextField label="Provider" value={form.provider} onChange={setF('provider')} />
          <TextField label="Reference / PNR" value={form.reference} onChange={setF('reference')} />
          <div className="row">
            <TextField label="Booked on" type="date" value={form.bookedOn} onChange={setF('bookedOn')} />
            <TextField label="Amount (₹)" type="number" value={form.amount} onChange={setF('amount')} />
          </div>
        </Modal>
      )}

      {modal?.type === 'settle' && (
        <Modal title="Submit settlement" onClose={() => setModal(null)} footer={<><button className="btn secondary" onClick={() => setModal(null)}>Cancel</button><button className="btn" onClick={async () => {
          try {
            const { data } = await api.post(`/travel/${modal.request.id}/settlement`, { amountSpent: Number(form.amountSpent || 0) });
            toast(`Settlement submitted — payable ${money(data.data.payable)}`);
            setModal(null); setDetail(null); load();
          } catch (e) { toast(errMsg(e), true); }
        }}>Submit</button></>}>
          <p style={{ fontSize: 13, color: 'var(--muted)' }}>Advances issued for this trip will be adjusted automatically.</p>
          <TextField label="Total amount spent (₹) *" type="number" value={form.amountSpent} onChange={setF('amountSpent')} />
        </Modal>
      )}
    </>
  );
}
