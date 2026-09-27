import React, { useEffect, useState } from 'react';
import { api, errMsg, money2, fmtDate } from '../api';
import { useAuth } from '../auth';
import DataTable from '../components/DataTable';
import { Spinner, StatusBadge, useToast, Modal, TextField, SelectField, StatCard, downloadFile } from '../components/ui';

export default function Billing() {
  const { can } = useAuth();
  const toast = useToast();
  const [invoices, setInvoices] = useState(null);
  const [customers, setCustomers] = useState(null);
  const [summary, setSummary] = useState(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ items: [{ description: '', quantity: 1, rate: '', gstRate: 18 }] });
  const [payModal, setPayModal] = useState(null);
  const [payForm, setPayForm] = useState({});

  const load = async () => {
    try {
      const [i, s] = await Promise.all([api.get('/billing/invoices'), api.get('/billing/summary')]);
      setInvoices(i.data.data);
      setSummary(s.data.data);
      api.get('/org/customers').then(({ data }) => setCustomers(data.data)).catch(() => {});
    } catch (e) { toast(errMsg(e), true); }
  };
  useEffect(() => { load(); }, []);

  const createInvoice = async () => {
    try {
      const items = form.items.filter((it) => it.description && it.rate).map((it) => ({
        description: it.description, quantity: Number(it.quantity || 1), rate: Number(it.rate), gstRate: Number(it.gstRate ?? 18), hsnSac: it.hsnSac,
      }));
      const { data } = await api.post('/billing/invoices', { customerId: Number(form.customerId), items, invoiceDate: form.invoiceDate, notes: form.notes });
      toast(`Invoice ${data.data.invoiceNo} created — totals & GST computed server-side`);
      setCreating(false);
      setForm({ items: [{ description: '', quantity: 1, rate: '', gstRate: 18 }] });
      load();
    } catch (e) { toast(errMsg(e), true); }
  };

  const recordPayment = async () => {
    try {
      await api.post(`/billing/invoices/${payModal.id}/payments`, { ...payForm, amount: Number(payForm.amount) });
      toast('Payment recorded');
      setPayModal(null);
      setPayForm({});
      load();
    } catch (e) { toast(errMsg(e), true); }
  };

  const sendOrCancel = async (inv, status) => {
    try {
      await api.post(`/billing/invoices/${inv.id}/status`, { status });
      toast(`Invoice ${status}`);
      load();
    } catch (e) { toast(errMsg(e), true); }
  };

  if (!invoices || !summary) return <Spinner />;
  const setF = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));
  const setItem = (i, k) => (v) => setForm((f) => {
    const items = [...f.items];
    items[i] = { ...items[i], [k]: v };
    return { ...f, items };
  });

  const subtotal = form.items.reduce((s, it) => s + (Number(it.quantity || 0) * Number(it.rate || 0)), 0);
  const tax = form.items.reduce((s, it) => s + (Number(it.quantity || 0) * Number(it.rate || 0) * Number(it.gstRate || 0)) / 100, 0);

  return (
    <div>
      <div className="grid c4 mb">
        <StatCard label="Total billed" value={money2(summary.billed)} />
        <StatCard label="Collected" value={money2(summary.collected)} accent="var(--green)" />
        <StatCard label="Outstanding" value={money2(summary.outstanding)} accent="var(--red)" />
        <StatCard label="GST payable" value={money2(summary.gst.intra + summary.gst.inter)} sub={`Intra ${money2(summary.gst.intra)} · Inter ${money2(summary.gst.inter)}`} />
      </div>

      <DataTable
        columns={[
          { key: 'invoice_no', label: 'Invoice #' },
          { key: 'customer_name', label: 'Customer' },
          { key: 'invoice_date', label: 'Date', render: (r) => fmtDate(r.invoice_date) },
          { key: 'due_date', label: 'Due', render: (r) => fmtDate(r.due_date) },
          { key: 'total', label: 'Total', align: 'right', render: (r) => money2(r.total) },
          { key: 'amount_paid', label: 'Paid', align: 'right', render: (r) => money2(r.amount_paid) },
          { key: 'status', label: 'Status', render: (r) => <StatusBadge value={r.status} /> },
        ]}
        rows={invoices}
        emptyText="No invoices yet"
        toolbar={can('billing.manage') && <button className="btn sm" onClick={() => setCreating(true)}>+ New invoice</button>}
        actions={(r) => (
          <div className="row">
            {r.pdf_path && <a className="btn ghost sm" href={`/api/files/${r.pdf_path}`} target="_blank" rel="noreferrer">PDF</a>}
            {can('billing.manage') && r.status === 'draft' && <button className="btn sm" onClick={() => sendOrCancel(r, 'sent')}>Send</button>}
            {can('billing.manage') && ['sent', 'part_paid', 'overdue'].includes(r.status) && (
              <button className="btn sm success" onClick={() => { setPayModal(r); setPayForm({ paidOn: new Date().toISOString().slice(0, 10) }); }}>Payment</button>
            )}
          </div>
        )}
      />

      {creating && (
        <Modal wide title="New invoice" onClose={() => setCreating(false)} footer={
          <><button className="btn secondary" onClick={() => setCreating(false)}>Cancel</button>
            <button className="btn" onClick={createInvoice} disabled={!form.customerId}>Create invoice</button></>
        }>
          <div className="form-grid">
            <SelectField label="Customer *" value={form.customerId} onChange={(v) => setF('customerId', v)} options={(customers || []).map((c) => ({ value: c.id, label: `${c.name}${c.state_code ? ' · ' + c.state_code : ''}` }))} />
            <TextField label="Invoice date" type="date" value={form.invoiceDate} onChange={setF('invoiceDate')} />
          </div>
          <table className="tbl mb">
            <thead><tr><th>Description</th><th>HSN/SAC</th><th className="num">Qty</th><th className="num">Rate</th><th className="num">GST %</th><th className="num">Amount</th><th></th></tr></thead>
            <tbody>
              {form.items.map((it, i) => (
                <tr key={i}>
                  <td><input className="btn sm secondary" style={{ width: '100%', textAlign: 'left' }} value={it.description} onChange={setItem(i, 'description')} /></td>
                  <td><input className="btn sm secondary" style={{ width: 80 }} value={it.hsnSac || ''} onChange={setItem(i, 'hsnSac')} /></td>
                  <td className="num"><input className="btn sm secondary" style={{ width: 60, textAlign: 'right' }} type="number" value={it.quantity} onChange={setItem(i, 'quantity')} /></td>
                  <td className="num"><input className="btn sm secondary" style={{ width: 100, textAlign: 'right' }} type="number" value={it.rate} onChange={setItem(i, 'rate')} /></td>
                  <td className="num"><input className="btn sm secondary" style={{ width: 60, textAlign: 'right' }} type="number" value={it.gstRate} onChange={setItem(i, 'gstRate')} /></td>
                  <td className="num">{money2((it.quantity || 0) * (it.rate || 0))}</td>
                  <td className="actions"><button className="btn ghost sm" onClick={() => setForm((f) => ({ ...f, items: f.items.filter((_, j) => j !== i) }))}>×</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="row" style={{ justifyContent: 'flex-end', gap: 24 }}>
            <span>Subtotal: <b>{money2(subtotal)}</b></span>
            <span>GST: <b>{money2(tax)}</b></span>
            <span style={{ fontSize: 16 }}>Total: <b>{money2(subtotal + tax)}</b></span>
          </div>
          <p className="hint" style={{ fontSize: 12, color: 'var(--muted)' }}>
            Intra-state customers get CGST+SGST split; inter-state gets IGST — decided server-side from place of supply.
          </p>
          <button className="btn ghost sm" onClick={() => setForm((f) => ({ ...f, items: [...f.items, { description: '', quantity: 1, rate: '', gstRate: 18 }] }))}>+ Add line item</button>
        </Modal>
      )}

      {payModal && (
        <Modal title={`Record payment — ${payModal.invoice_no}`} onClose={() => setPayModal(null)} footer={
          <><button className="btn secondary" onClick={() => setPayModal(null)}>Cancel</button><button className="btn" onClick={recordPayment}>Save</button></>
        }>
          <p style={{ fontSize: 13 }}>Outstanding: <b>{money2(payModal.total - payModal.amount_paid)}</b></p>
          <TextField label="Amount (₹) *" type="number" value={payForm.amount} onChange={(v) => setPayForm((f) => ({ ...f, amount: v }))} />
          <div className="form-grid">
            <TextField label="Paid on" type="date" value={payForm.paidOn} onChange={(v) => setPayForm((f) => ({ ...f, paidOn: v }))} />
            <SelectField label="Mode" value={payForm.mode} onChange={(v) => setPayForm((f) => ({ ...f, mode: v }))}
              options={['bank_transfer', 'upi', 'cheque', 'cash', 'card'].map((m) => ({ value: m, label: m.replace('_', ' ') }))} />
          </div>
          <TextField label="Reference" value={payForm.reference} onChange={(v) => setPayForm((f) => ({ ...f, reference: v }))} />
        </Modal>
      )}
    </div>
  );
}
