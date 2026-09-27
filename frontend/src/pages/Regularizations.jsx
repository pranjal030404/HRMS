import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, errMsg, fmtDate } from '../api';
import { useAuth } from '../auth';
import DataTable from '../components/DataTable';
import { Spinner, StatusBadge, useToast, Modal } from '../components/ui';

export default function Regularizations() {
  const { can } = useAuth();
  const toast = useToast();
  const [rows, setRows] = useState(null);
  const [comment, setComment] = useState({});

  const load = async () => {
    try {
      const { data } = await api.get('/attendance/regularizations');
      setRows(data.data);
    } catch (e) { toast(errMsg(e), true); }
  };
  useEffect(() => { load(); }, []);

  const action = async (id, act) => {
    try {
      await api.post(`/attendance/regularizations/${id}/action`, { action: act, comment: comment[id] || '' });
      toast(`Regularization ${act === 'approve' ? 'approved' : 'rejected'} — punches applied`);
      load();
    } catch (e) { toast(errMsg(e), true); }
  };

  if (!rows) return <Spinner />;

  return (
    <div>
      <DataTable
        columns={[
          { key: 'employee_code', label: 'Code' },
          { key: 'first_name', label: 'Employee', render: (r) => `${r.first_name} ${r.last_name}` },
          { key: 'adate', label: 'Date', render: (r) => fmtDate(r.adate) },
          { key: 'requested_in', label: 'Requested in', render: (r) => (r.requested_in ? fmtDate(r.requested_in, true) : '—') },
          { key: 'requested_out', label: 'Requested out', render: (r) => (r.requested_out ? fmtDate(r.requested_out, true) : '—') },
          { key: 'reason', label: 'Reason' },
          { key: 'status', label: 'Status', render: (r) => <StatusBadge value={r.status} /> },
        ]}
        rows={rows}
        emptyText="No regularization requests"
        toolbar={<Link to="/attendance" className="btn ghost sm">← Daily register</Link>}
        actions={(r) => r.status === 'pending' && can('attendance.approve') ? (
          <div className="row">
            <input className="btn sm secondary" style={{ width: 150 }} placeholder="Comment (optional)"
              value={comment[r.id] || ''} onChange={(e) => setComment((c) => ({ ...c, [r.id]: e.target.value }))} />
            <button className="btn sm success" onClick={() => action(r.id, 'approve')}>Approve</button>
            <button className="btn sm danger" onClick={() => action(r.id, 'reject')}>Reject</button>
          </div>
        ) : <span style={{ fontSize: 12, color: 'var(--muted)' }}>{r.approver_comment || ''}</span>}
      />
    </div>
  );
}

export function RegHelp() { return <Modal title="x" onClose={() => {}}> </Modal>; }
