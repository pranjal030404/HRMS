import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, errMsg, money2, fmtDate } from '../api';
import { useAuth } from '../auth';
import DataTable from '../components/DataTable';
import { Spinner, StatusBadge, useToast } from '../components/ui';

export default function Expenses() {
  const { can } = useAuth();
  const toast = useToast();
  const [rows, setRows] = useState(null);
  const [filter, setFilter] = useState('submitted');

  const load = async () => {
    try {
      const { data } = await api.get('/expenses', { params: { status: filter || undefined } });
      setRows(data.data);
    } catch (e) { toast(errMsg(e), true); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [filter]);

  const action = async (id, act) => {
    try {
      await api.post(`/expenses/${id}/action`, { action: act });
      toast(`Claim ${act === 'approve' ? 'approved' : 'rejected'} — reimbursements flow into the next payroll run`);
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
          { key: 'title', label: 'Claim' },
          { key: 'category_name', label: 'Category' },
          { key: 'expense_date', label: 'Date', render: (r) => fmtDate(r.expense_date) },
          { key: 'amount', label: 'Amount', align: 'right', render: (r) => money2(r.amount) },
          { key: 'status', label: 'Status', render: (r) => <StatusBadge value={r.status} /> },
        ]}
        rows={rows}
        emptyText="No expense claims"
        toolbar={
          <div className="row">
            <select className="btn sm secondary" value={filter} onChange={(e) => setFilter(e.target.value)}>
              <option value="">All</option><option value="submitted">Submitted</option><option value="approved">Approved</option>
              <option value="reimbursed">Reimbursed</option><option value="rejected">Rejected</option>
            </select>
            <Link to="/org/expense-categories" className="btn ghost sm">Categories →</Link>
          </div>
        }
        actions={(r) => (
          <>
            {r.receipt_path && <a className="btn ghost sm" href={`/api/files/${r.receipt_path}`} target="_blank" rel="noreferrer">Receipt</a>}
            {r.status === 'submitted' && can('expense.approve') && Number(r.employee_id) !== Number(localStorage.getItem('empId')) && (
              <>
                <button className="btn sm success" onClick={() => action(r.id, 'approve')}>Approve</button>
                <button className="btn sm danger" onClick={() => action(r.id, 'reject')}>Reject</button>
              </>
            )}
          </>
        )}
      />
    </>
  );
}
