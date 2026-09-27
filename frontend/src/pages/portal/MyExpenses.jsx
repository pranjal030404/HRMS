import React, { useEffect, useState } from 'react';
import { api, errMsg, money2, fmtDate } from '../../api';
import { Spinner, StatusBadge, useToast, Modal, TextField, SelectField, StatCard, downloadFile } from '../../components/ui';

export default function MyExpenses() {
  const toast = useToast();
  const [rows, setRows] = useState(null);
  const [lookups, setLookups] = useState(null);
  const [applying, setApplying] = useState(false);
  const [form, setForm] = useState({});
  const fileRef = React.useRef(null);

  const load = async () => {
    try {
      const [r, l] = await Promise.all([api.get('/expenses', { params: { mine: 1 } }), api.get('/org/lookups')]);
      setRows(r.data.data);
      setLookups(l.data.data);
    } catch (e) { toast(errMsg(e), true); }
  };
  useEffect(() => { load(); }, []);

  const submit = async () => {
    const file = fileRef.current?.files?.[0];
    const fd = new FormData();
    Object.entries(form).forEach(([k, v]) => v != null && fd.append(k, v));
    if (file) fd.append('file', file);
    try {
      await api.post('/expenses', fd);
      toast('Expense submitted for approval');
      setApplying(false);
      setForm({});
      load();
    } catch (e) { toast(errMsg(e), true); }
  };

  if (!rows) return <Spinner />;
  const totalApproved = rows.filter((r) => ['approved', 'reimbursed'].includes(r.status)).reduce((s, r) => s + Number(r.amount), 0);
  const setF = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <div>
      <div className="grid c3 mb">
        <StatCard label="Total approved / reimbursed" value={money2(totalApproved)} accent="var(--green)" />
        <StatCard label="Pending approval" value={rows.filter((r) => r.status === 'submitted').length} />
        <StatCard label="Claims this year" value={rows.length} />
      </div>
      <div className="card">
        <div className="card-h">
          <h3>My expense claims</h3>
          <button className="btn sm" onClick={() => { setForm({ expenseDate: new Date().toISOString().slice(0, 10) }); setApplying(true); }}>+ Submit claim</button>
        </div>
        <div className="table-wrap">
          <table className="tbl">
            <thead><tr><th>Date</th><th>Claim</th><th>Category</th><th className="num">Amount</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={6} style={{ textAlign: 'center', padding: 24, color: 'var(--muted)' }}>No claims yet</td></tr>}
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>{fmtDate(r.expense_date)}</td>
                  <td><b>{r.title}</b>{r.description && <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{r.description}</div>}</td>
                  <td>{r.category_name}</td>
                  <td className="num">{money2(r.amount)}</td>
                  <td><StatusBadge value={r.status} /></td>
                  <td className="actions">{r.receipt_path && <a className="btn ghost sm" href={`/api/files/${r.receipt_path}`} target="_blank" rel="noreferrer">Receipt</a>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {applying && (
        <Modal title="Submit expense claim" onClose={() => setApplying(false)} footer={
          <><button className="btn secondary" onClick={() => setApplying(false)}>Cancel</button><button className="btn" onClick={submit}>Submit</button></>
        }>
          <SelectField label="Category *" value={form.categoryId} onChange={setF('categoryId')}
            options={(lookups?.expenseCategories || []).map((c) => ({ value: c.id, label: c.name }))} />
          <TextField label="Title *" value={form.title} onChange={setF('title')} />
          <div className="form-grid">
            <TextField label="Amount (₹) *" type="number" value={form.amount} onChange={setF('amount')} />
            <TextField label="Expense date" type="date" value={form.expenseDate} onChange={setF('expenseDate')} />
          </div>
          <TextField label="Description" value={form.description} onChange={setF('description')} />
          <div className="field"><label>Receipt</label><input type="file" ref={fileRef} /></div>
        </Modal>
      )}
    </div>
  );
}
