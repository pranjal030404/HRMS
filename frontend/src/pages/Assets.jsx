import React, { useEffect, useState } from 'react';
import { api, errMsg, money, fmtDate } from '../api';
import { useAuth } from '../auth';
import DataTable from '../components/DataTable';
import { Spinner, StatusBadge, useToast, Modal, TextField, SelectField } from '../components/ui';

export default function Assets() {
  const { can } = useAuth();
  const toast = useToast();
  const [rows, setRows] = useState(null);
  const [assignments, setAssignments] = useState(null);
  const [emps, setEmps] = useState([]);
  const [assignModal, setAssignModal] = useState(null);
  const [form, setForm] = useState({});

  const load = async () => {
    try {
      const [a, as] = await Promise.all([api.get('/assets'), api.get('/assets/assignments')]);
      setRows(a.data.data);
      setAssignments(as.data.data);
      if (can('asset.manage')) api.get('/employees?limit=100').then(({ data }) => setEmps(data.data)).catch(() => {});
    } catch (e) { toast(errMsg(e), true); }
  };
  useEffect(() => { load(); }, []); // eslint-disable-line

  const assign = async () => {
    try {
      await api.post('/assets/assign', { assetId: assignModal.id, employeeId: Number(form.employeeId) });
      toast('Asset assigned');
      setAssignModal(null);
      setForm({});
      load();
    } catch (e) { toast(errMsg(e), true); }
  };

  const returnAsset = async (asg) => {
    try {
      await api.post(`/assets/assignments/${asg.id}/return`, {});
      toast('Asset returned');
      load();
    } catch (e) { toast(errMsg(e), true); }
  };

  if (!rows || !assignments) return <Spinner />;
  const setF = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <>
      <DataTable
        columns={[
          { key: 'asset_code', label: 'Code' },
          { key: 'name', label: 'Asset' },
          { key: 'category', label: 'Category' },
          { key: 'serial_no', label: 'Serial' },
          { key: 'current_holder', label: 'Assigned to', render: (r) => r.current_holder || '—' },
          { key: 'purchase_value', label: 'Value', align: 'right', render: (r) => (r.purchase_value ? money(r.purchase_value) : '—') },
          { key: 'status', label: 'Status', render: (r) => <StatusBadge value={r.status} /> },
        ]}
        rows={rows}
        emptyText="No assets in inventory"
        actions={(r) => r.status === 'available' && can('asset.manage') ? (
          <button className="btn sm" onClick={() => setAssignModal(r)}>Assign</button>
        ) : null}
      />
      <div className="card mt">
        <div className="card-h"><h3>Assignment history</h3></div>
        <div className="table-wrap">
          <table className="tbl">
            <thead><tr><th>Asset</th><th>Employee</th><th>Assigned</th><th>Returned</th><th>Condition</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {assignments.map((a) => (
                <tr key={a.id}>
                  <td><b>{a.asset_code}</b> · {a.asset_name}</td>
                  <td>{a.first_name} {a.last_name}</td>
                  <td>{fmtDate(a.assigned_on)}</td>
                  <td>{a.returned_on ? fmtDate(a.returned_on) : '—'}</td>
                  <td>{a.condition_on_return || a.condition_on_issue || '—'}</td>
                  <td><StatusBadge value={a.status} /></td>
                  <td className="actions">{a.status === 'assigned' && can('asset.manage') && <button className="btn ghost sm" onClick={() => returnAsset(a)}>Return</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {assignModal && (
        <Modal title={`Assign ${assignModal.asset_code} — ${assignModal.name}`} onClose={() => setAssignModal(null)} footer={
          <><button className="btn secondary" onClick={() => setAssignModal(null)}>Cancel</button><button className="btn" onClick={assign}>Assign</button></>
        }>
          <SelectField label="Employee *" value={form.employeeId} onChange={setF('employeeId')}
            options={emps.map((e) => ({ value: e.id, label: `${e.first_name} ${e.last_name} (${e.employee_code})` }))} />
        </Modal>
      )}
    </>
  );
}
