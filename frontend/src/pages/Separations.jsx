import React, { useEffect, useState } from 'react';
import { api, errMsg, money2, fmtDate } from '../api';
import { useAuth } from '../auth';
import DataTable from '../components/DataTable';
import { Spinner, StatusBadge, useToast, Modal, TextField, SelectField } from '../components/ui';

const DEPTS = ['IT', 'Admin', 'Finance', 'HR'];

export default function Separations() {
  const { can } = useAuth();
  const toast = useToast();
  const [rows, setRows] = useState(null);
  const [fnfModal, setFnfModal] = useState(null);
  const [fnfItems, setFnfItems] = useState([]);
  const [form, setForm] = useState({});
  const [clearance, setClearance] = useState({});

  const load = async () => {
    try {
      const { data } = await api.get('/lifecycle/separations');
      setRows(data.data);
    } catch (e) { toast(errMsg(e), true); }
  };
  useEffect(() => { load(); }, []);

  const action = async (id, act) => {
    try {
      await api.post(`/lifecycle/separations/${id}/action`, { action: act });
      toast(`Separation ${act === 'approve' ? 'approved — clearance checklist created' : act + 'ed'}`);
      load();
    } catch (e) { toast(errMsg(e), true); }
  };

  const signClearance = async (sepId, dept) => {
    try {
      await api.post(`/lifecycle/separations/${sepId}/clearance/${dept}`, { remarks: clearance[`${sepId}-${dept}`] || '' });
      toast(`${dept} clearance signed`);
      load();
      if (fnfModal) openFnf({ id: sepId });
    } catch (e) { toast(errMsg(e), true); }
  };

  const openFnf = async (sep) => {
    try {
      const { data } = await api.get(`/lifecycle/separations/${sep.id}/fnf`);
      setFnfModal({ ...sep, total: data.total });
      setFnfItems(data.data);
      setForm({});
    } catch (e) { toast(errMsg(e), true); }
  };

  const addFnfItem = async () => {
    try {
      await api.post(`/lifecycle/separations/${fnfModal.id}/fnf`, { ...form, amount: Number(form.amount) });
      openFnf(fnfModal);
      load();
    } catch (e) { toast(errMsg(e), true); }
  };

  const complete = async (id) => {
    try {
      await api.post(`/lifecycle/separations/${id}/complete`);
      toast('Separation completed — employee archived');
      setFnfModal(null);
      load();
    } catch (e) { toast(errMsg(e), true); }
  };

  if (!rows) return <Spinner />;

  return (
    <>
      <DataTable
        columns={[
          { key: 'employee_code', label: 'Code' },
          { key: 'first_name', label: 'Employee', render: (r) => `${r.first_name} ${r.last_name}` },
          { key: 'sep_type', label: 'Type' },
          { key: 'requested_on', label: 'Requested', render: (r) => fmtDate(r.requested_on) },
          { key: 'last_working_day', label: 'LWD', render: (r) => fmtDate(r.last_working_day) },
          { key: 'notice_days', label: 'Notice', align: 'right', render: (r) => `${r.notice_days} d` },
          { key: 'status', label: 'Status', render: (r) => <StatusBadge value={r.status} labels={{
            requested: ['amber', 'Requested'], in_notice: ['blue', 'In notice'], clearance: ['blue', 'Clearance'],
            fnf_pending: ['amber', 'F&F pending'], completed: ['green', 'Completed'],
          }} /> },
        ]}
        rows={rows}
        emptyText="No separations"
        actions={(r) => (
          <div className="row">
            {r.status === 'requested' && can('separation.approve') && (
              <>
                <button className="btn sm success" onClick={() => action(r.id, 'approve')}>Approve</button>
                <button className="btn sm danger" onClick={() => action(r.id, 'reject')}>Reject</button>
              </>
            )}
            {['in_notice', 'fnf_pending'].includes(r.status) && can('separation.manage') && (
              <button className="btn sm secondary" onClick={() => openFnf(r)}>Clearance & F&F</button>
            )}
          </div>
        )}
      />
      {fnfModal && (
        <Modal wide title={`Clearance & Full & Final — ${fnfModal.first_name} ${fnfModal.last_name}`} onClose={() => setFnfModal(null)} footer={
          can('separation.manage') && fnfModal.status === 'fnf_pending' ? <button className="btn success" onClick={() => complete(fnfModal.id)}>Complete separation & archive</button> : null
        }>
          <h4 style={{ fontSize: 13.5, marginBottom: 8 }}>Department clearances</h4>
          {DEPTS.map((d) => {
            const cleared = fnfModal.clearances_done != null && false; // statuses come from reload; render from parent row when available
            return (
              <div className="spread" key={d} style={{ padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
                <b style={{ fontSize: 13.5 }}>{d}</b>
                {can('separation.manage') ? (
                  <div className="row">
                    <input className="btn sm secondary" style={{ width: 170 }} placeholder="Remarks"
                      value={clearance[`${fnfModal.id}-${d}`] || ''}
                      onChange={(e) => setClearance((c) => ({ ...c, [`${fnfModal.id}-${d}`]: e.target.value }))} />
                    <button className="btn sm success" onClick={() => signClearance(fnfModal.id, d)}>Clear</button>
                  </div>
                ) : null}
              </div>
            );
          })}
          <h4 style={{ fontSize: 13.5, margin: '16px 0 8px' }}>Full & Final components</h4>
          <table className="tbl">
            <thead><tr><th>Component</th><th>Type</th><th className="num">Amount</th></tr></thead>
            <tbody>
              {fnfItems.length === 0 && <tr><td colSpan={3} style={{ textAlign: 'center', padding: 16, color: 'var(--muted)' }}>No F&F entries yet</td></tr>}
              {fnfItems.map((i) => (
                <tr key={i.id}>
                  <td>{i.component}</td>
                  <td><span className={'badge ' + (i.ftype === 'payment' ? 'green' : 'red')}>{i.ftype}</span></td>
                  <td className="num" style={{ color: i.ftype === 'payment' ? 'var(--green)' : 'var(--red)' }}>
                    {i.ftype === 'payment' ? '+' : '−'}{money2(i.amount)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p style={{ textAlign: 'right', fontWeight: 700, marginTop: 8 }}>Net settlement: {money2(fnfModal.total ?? 0)}</p>
          {can('separation.manage') && (
            <div className="form-grid mt">
              <TextField label="Component (e.g. Leave encashment)" value={form.component} onChange={(v) => setForm((f) => ({ ...f, component: v }))} />
              <TextField label="Amount (₹)" type="number" value={form.amount} onChange={(v) => setForm((f) => ({ ...f, amount: v }))} />
              <SelectField label="Type" value={form.ftype} onChange={(v) => setForm((f) => ({ ...f, ftype: v }))}
                options={[{ value: 'payment', label: 'Payment to employee' }, { value: 'recovery', label: 'Recovery from employee' }]} />
              <div style={{ display: 'flex', alignItems: 'flex-end' }}><button className="btn sm" onClick={addFnfItem} disabled={!form.component || !form.amount}>+ Add</button></div>
            </div>
          )}
        </Modal>
      )}
    </>
  );
}
