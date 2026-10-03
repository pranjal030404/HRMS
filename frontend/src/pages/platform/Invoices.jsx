import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, errMsg, fmtDate, money } from '../../api';
import { Empty, Modal, SelectField, TextAreaField, TextField, useToast } from '../../components/ui';
import { PlatformTable, EmptyState } from '../../components/PlatformTable';
import { PageHeader, Pager, PlatformSection, num, useLoader, usePlatform } from './shared';

export default function PlatformInvoices() {
  return (
    <PlatformSection perm="platform.subscriptions.view">
      <Invoices />
    </PlatformSection>
  );
}

const STATE = { open: ['amber', 'Open'], paid: ['green', 'Paid'], void: ['gray', 'Void'] };

function Invoices() {
  const { can } = usePlatform();
  const toast = useToast();
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [pay, setPay] = useState(null);
  const [voiding, setVoiding] = useState(null);
  const manage = can('platform.subscriptions.manage');
  const { data, raw, meta, loading, error, reload } = useLoader(async () => {
    const { data } = await api.get('/platform/billing/invoices', { params: { status: status || undefined, page, limit: 25 } });
    return data;
  }, [status, page]);
  const rows = data || [];
  const sum = raw?.summary || {};

  return (
    <div>
      <PageHeader title="Invoices & payments"
        sub="What ARTHVEX bills each company. Payments are recorded by a billing admin against an invoice; an unpaid invoice past its due date moves the subscription into the dunning chain." />
      <div className="stat-grid mb">
        <div className="card stat"><div className="lbl">Outstanding</div><div className="val">{money(sum.outstanding || 0)}</div></div>
        <div className="card stat"><div className="lbl">Overdue</div><div className="val" style={{ color: sum.overdue > 0 ? '#b42318' : undefined }}>{money(sum.overdue || 0)}</div></div>
        <div className="card stat"><div className="lbl">Collected</div><div className="val" style={{ color: '#067647' }}>{money(sum.collected || 0)}</div></div>
      </div>
      <div className="card mb"><div className="card-b row wrap">
        {['', 'open', 'paid', 'void'].map((s) => (
          <button key={s || 'all'} className={'btn sm ' + (status === s ? '' : 'secondary')} onClick={() => { setStatus(s); setPage(1); }}>{s || 'All'}</button>
        ))}
      </div></div>
      <div className="card">
        <PlatformTable
          id="invoices" rows={rows} loading={loading} error={error} onRetry={reload}
          serverMeta={meta} onPage={setPage} hideSearch
          columns={[
            { key: 'invoice_number', label: 'Invoice', sortable: true, render: (i) => <code>{i.invoice_number}</code> },
            { key: 'tenant_name', label: 'Company', sortable: true, render: (i) => <Link to={`/platform/companies/${i.tenant_id}`}>{i.tenant_name}</Link> },
            { key: 'period_start', label: 'Period', render: (i) => `${fmtDate(i.period_start)} – ${fmtDate(i.period_end)}` },
            { key: 'total', label: 'Total', sortable: true, align: 'right', value: (i) => Number(i.total), render: (i) => money(i.total) },
            { key: 'amount_paid', label: 'Paid', sortable: true, align: 'right', value: (i) => Number(i.amount_paid), render: (i) => money(i.amount_paid) },
            { key: 'due_at', label: 'Due', sortable: true, render: (i) => (
              <span style={{ color: i.overdue ? '#b42318' : undefined }}>{i.due_at ? fmtDate(i.due_at) : '—'}{i.overdue ? ' · overdue' : ''}</span>) },
            { key: 'status', label: 'State', sortable: true, render: (i) => <span className={'badge ' + STATE[i.status][0]}>{STATE[i.status][1]}</span> },
            { key: 'actions', label: '', render: (i) => (<span className="actions">
              {manage && i.status === 'open' && <button className="btn ghost sm" onClick={() => setPay(i)}>Record payment</button>}
              {manage && i.status === 'open' && Number(i.amount_paid) === 0 && <button className="btn ghost sm" onClick={() => setVoiding(i)}>Void</button>}
            </span>) },
          ]}
          empty={<EmptyState title="No invoices yet" text="Issue one from a subscription." />}
        />
      </div>
      <p className="hint" style={{ marginTop: 10 }}>{num(meta?.total || 0)} invoice(s).</p>
      {pay && <PayModal invoice={pay} onClose={() => setPay(null)} onDone={(r) => { toast(r.subscriptionRestored ? 'Paid in full — subscription restored to active' : 'Payment recorded'); reload(); }} />}
      {voiding && <VoidModal invoice={voiding} onClose={() => setVoiding(null)} onDone={() => { toast('Invoice voided'); reload(); }} />}
    </div>
  );
}

function PayModal({ invoice, onClose, onDone }) {
  const outstanding = Number(invoice.total) - Number(invoice.amount_paid);
  const [f, setF] = useState({ amount: String(outstanding), method: 'bank_transfer', reference: '', reason: '' });
  const [error, setError] = useState('');
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v }));
  const submit = async () => {
    try {
      const { data } = await api.post(`/platform/billing/invoices/${invoice.id}/payments`, { ...f, amount: Number(f.amount) });
      onDone(data.data); onClose();
    } catch (e) { setError(errMsg(e)); }
  };
  return (
    <Modal title={`Record payment · ${invoice.invoice_number}`} onClose={onClose}
      footer={<><button className="btn secondary" onClick={onClose}>Cancel</button><button className="btn" disabled={!(Number(f.amount) > 0) || f.reason.trim().length < 5} onClick={submit}>Record</button></>}>
      <div className="info-box mb">Outstanding: <b>{money(outstanding)}</b>. More than this is refused.</div>
      <TextField label="Amount" type="number" value={f.amount} onChange={set('amount')} />
      <SelectField label="Method" value={f.method} onChange={set('method')}
        options={['bank_transfer', 'upi', 'card', 'cheque', 'cash', 'other'].map((m) => ({ value: m, label: m.replace('_', ' ') }))} />
      <TextField label="Reference (UTR / cheque no.)" value={f.reference} onChange={set('reference')} />
      <TextAreaField label="Reason *" value={f.reason} onChange={set('reason')} />
      {error && <div className="error-box mt">{error}</div>}
    </Modal>
  );
}

function VoidModal({ invoice, onClose, onDone }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const submit = async () => {
    try { await api.post(`/platform/billing/invoices/${invoice.id}/void`, { reason }); onDone(); onClose(); } catch (e) { setError(errMsg(e)); }
  };
  return (
    <Modal title={`Void ${invoice.invoice_number}`} onClose={onClose}
      footer={<><button className="btn secondary" onClick={onClose}>Cancel</button><button className="btn danger" disabled={reason.trim().length < 5} onClick={submit}>Void</button></>}>
      <TextAreaField label="Reason *" value={reason} onChange={setReason} />
      {error && <div className="error-box mt">{error}</div>}
    </Modal>
  );
}
