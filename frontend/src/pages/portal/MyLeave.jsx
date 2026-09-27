import React, { useEffect, useState } from 'react';
import { api, errMsg, fmtDate } from '../../api';
import { useAuth } from '../../auth';
import { Spinner, StatusBadge, useToast, Modal, TextField, SelectField, StatCard } from '../../components/ui';

export default function MyLeave() {
  const { can } = useAuth();
  const toast = useToast();
  const [balances, setBalances] = useState(null);
  const [requests, setRequests] = useState(null);
  const [applying, setApplying] = useState(false);
  const [form, setForm] = useState({});
  const [lookups, setLookups] = useState(null);

  const load = async () => {
    try {
      const [b, r, l] = await Promise.all([
        api.get('/leave/balances'),
        api.get('/leave/requests', { params: { mine: 1 } }),
        api.get('/org/lookups'),
      ]);
      setBalances(b.data.data);
      setRequests(r.data.data);
      setLookups(l.data.data);
    } catch (e) { toast(errMsg(e), true); }
  };
  useEffect(() => { load(); }, []);

  const apply = async () => {
    try {
      await api.post('/leave/requests', { ...form, leaveTypeId: Number(form.leaveTypeId) });
      toast('Leave request submitted for approval');
      setApplying(false);
      load();
    } catch (e) { toast(errMsg(e), true); }
  };

  const cancel = async (id) => {
    try {
      await api.post(`/leave/requests/${id}/action`, { action: 'cancel' });
      toast('Leave cancelled');
      load();
    } catch (e) { toast(errMsg(e), true); }
  };

  if (!balances || !requests) return <Spinner />;
  const setF = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <div>
      <div className="grid c4 mb">
        {balances.slice(0, 4).map((b) => (
          <StatCard key={b.leaveTypeId} label={b.name} value={b.available} sub={`${b.used} used · ${b.accrued} accrued this year`} accent="var(--primary)" />
        ))}
      </div>

      <div className="card mb">
        <div className="card-h">
          <h3>My leave requests</h3>
          {can('leave.apply') && <button className="btn sm" onClick={() => { setForm({ dayPart: 'full' }); setApplying(true); }}>+ Apply leave</button>}
        </div>
        <div className="table-wrap">
          <table className="tbl">
            <thead><tr><th>Type</th><th>From</th><th>To</th><th className="num">Days</th><th>Reason</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {requests.length === 0 && <tr><td colSpan={7} style={{ textAlign: 'center', padding: 24, color: 'var(--muted)' }}>No leave requests yet</td></tr>}
              {requests.map((r) => (
                <tr key={r.id}>
                  <td><b>{r.leave_type_name}</b>{!r.is_paid && <span className="badge red" style={{ marginLeft: 6 }}>LOP</span>}</td>
                  <td>{fmtDate(r.start_date)}</td>
                  <td>{fmtDate(r.end_date)}</td>
                  <td className="num">{r.days}</td>
                  <td>{r.reason || '—'}</td>
                  <td><StatusBadge value={r.status} /></td>
                  <td className="actions">
                    {['pending', 'approved'].includes(r.status) && (
                      <button className="btn ghost sm" style={{ color: 'var(--red)' }} onClick={() => cancel(r.id)}>Cancel</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {applying && (
        <Modal title="Apply for leave" onClose={() => setApplying(false)} footer={
          <><button className="btn secondary" onClick={() => setApplying(false)}>Cancel</button><button className="btn" onClick={apply}>Submit request</button></>
        }>
          <SelectField label="Leave type *" value={form.leaveTypeId} onChange={setF('leaveTypeId')}
            options={(lookups?.leaveTypes || []).map((t) => ({ value: t.id, label: `${t.name}${t.is_paid ? '' : ' (unpaid)'}` }))} />
          <div className="form-grid">
            <TextField label="From *" type="date" value={form.startDate} onChange={setF('startDate')} min={new Date().toISOString().slice(0, 10)} />
            <TextField label="To *" type="date" value={form.endDate} onChange={setF('endDate')} min={form.startDate || new Date().toISOString().slice(0, 10)} />
          </div>
          <SelectField label="Half day (single-day requests only)" value={form.dayPart} onChange={setF('dayPart')}
            options={[{ value: 'full', label: 'Full day' }, { value: 'first_half', label: 'First half' }, { value: 'second_half', label: 'Second half' }]} />
          <TextField label="Reason" value={form.reason} onChange={setF('reason')} />
          <TextField label="Contact during leave" value={form.contactDuringLeave} onChange={setF('contactDuringLeave')} />
          <p className="hint" style={{ fontSize: 12, color: 'var(--muted)' }}>
            Balances, holidays, weekly-offs, notice periods and overlapping requests are validated server-side.
          </p>
        </Modal>
      )}
    </div>
  );
}
