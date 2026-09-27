import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, errMsg, fmtDate } from '../api';
import { useAuth } from '../auth';
import DataTable from '../components/DataTable';
import { Spinner, StatusBadge, useToast } from '../components/ui';

export default function LeaveAdmin() {
  const { can } = useAuth();
  const toast = useToast();
  const [rows, setRows] = useState(null);
  const [filter, setFilter] = useState('pending');

  const load = async () => {
    try {
      const { data } = await api.get('/leave/requests', { params: { status: filter || undefined } });
      setRows(data.data);
    } catch (e) { toast(errMsg(e), true); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [filter]);

  const action = async (id, act) => {
    try {
      await api.post(`/leave/requests/${id}/action`, { action: act });
      toast(`Leave ${act === 'approve' ? 'approved' : 'rejected'}`);
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
          { key: 'leave_type_name', label: 'Type', render: (r) => <span>{r.leave_type_name} {!r.is_paid && <span className="badge red">LOP</span>}</span> },
          { key: 'start_date', label: 'From', render: (r) => fmtDate(r.start_date) },
          { key: 'end_date', label: 'To', render: (r) => fmtDate(r.end_date) },
          { key: 'days', label: 'Days', align: 'right' },
          { key: 'reason', label: 'Reason' },
          { key: 'status', label: 'Status', render: (r) => <StatusBadge value={r.status} /> },
          { key: 'applied_at', label: 'Applied', render: (r) => fmtDate(r.applied_at) },
        ]}
        rows={rows}
        emptyText="No leave requests"
        toolbar={
          <div className="row">
            <select className="btn sm secondary" value={filter} onChange={(e) => setFilter(e.target.value)}>
              <option value="">All</option><option value="pending">Pending</option><option value="approved">Approved</option>
              <option value="rejected">Rejected</option><option value="cancelled">Cancelled</option>
            </select>
            {can('leave.configure') && <Link className="btn sm secondary" to="/org/leave-types">Leave policies →</Link>}
            {can('leave.configure') && <Link className="btn sm secondary" to="/leave/holidays">Holidays →</Link>}
          </div>
        }
        actions={(r) => (r.status === 'pending' && can('leave.approve') ? (
          <div className="row">
            <button className="btn sm success" onClick={() => action(r.id, 'approve')}>Approve</button>
            <button className="btn sm danger" onClick={() => action(r.id, 'reject')}>Reject</button>
          </div>
        ) : r.approver_name ? <span style={{ fontSize: 12, color: 'var(--muted)' }}>by {r.approver_name}</span> : null)}
      />
    </div>
  );
}
