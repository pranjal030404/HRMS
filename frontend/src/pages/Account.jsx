import React, { useState } from 'react';
import { api, errMsg, fmtDate, money } from '../api';
import { Modal, SelectField, Tabs, TextAreaField, TextField, useToast } from '../components/ui';
import { EmptyState, ErrorState } from '../components/PlatformTable';
import { useLoader } from './platform/shared';

const TABS = [
  { key: 'plan', label: 'Plan & usage' }, { key: 'setup', label: 'Setup health' }, { key: 'data', label: 'Data quality' },
  { key: 'contacts', label: 'Billing contacts' }, { key: 'support', label: 'Support' },
];

export default function Account() {
  const [tab, setTab] = useState('plan');
  return (
    <div>
      <div className="mb"><h2 style={{ fontSize: 22 }}>Plan &amp; billing</h2>
        <p style={{ color: 'var(--muted)', fontSize: 13 }}>Your subscription, how much of it you are using, and whether your company is set up to run payroll.</p></div>
      <Tabs tabs={TABS} active={tab} onChange={setTab} />
      {tab === 'plan' && <Plan />}
      {tab === 'setup' && <Setup />}
      {tab === 'data' && <DataQuality />}
      {tab === 'contacts' && <Contacts />}
      {tab === 'support' && <Support />}
    </div>
  );
}

const Skeleton = () => <div className="skel" style={{ height: 140 }} />;

function Plan() {
  const toast = useToast();
  const { data, loading, error, reload } = useLoader(async () => (await api.get('/account/subscription')).data.data, []);
  const [cancelling, setCancelling] = useState(false);
  if (loading && !data) return <Skeleton />;
  if (error || !data) return <ErrorState message={error} onRetry={reload} />;
  const withdraw = async () => { try { await api.post('/account/subscription/cancel/withdraw'); toast('Cancellation withdrawn'); reload(); } catch (e) { toast(errMsg(e), true); } };
  return (
    <div>
      {data.trial && <div className="info-box mb"><strong>Trial:</strong> {data.trial.daysLeft} day(s) left, ending {fmtDate(data.trial.endsAt)}.</div>}
      {data.readOnly && <div className="error-box mb">Your company is {String(data.status || data.tenantStatus).replace(/_/g, ' ')}. Your records stay readable, but nothing new can be added until billing is resolved. {data.graceEndsAt ? `Grace period ends ${fmtDate(data.graceEndsAt)}.` : ''}</div>}
      {data.cancellation && (
        <div className="info-box mb">Cancellation is scheduled for <strong>{fmtDate(data.cancellation.effectiveAt)}</strong>. Nothing is deleted when it takes effect.
          {' '}<button className="btn secondary sm" onClick={withdraw}>Keep my subscription</button></div>
      )}
      <div className="kpis mb">
        <div className="kpi"><span>Plan</span><b style={{ textTransform: 'capitalize' }}>{data.plan?.name || '—'}</b></div>
        <div className="kpi"><span>Status</span><b>{String(data.status || '—').replace(/_/g, ' ')}</b></div>
        <div className="kpi"><span>Billing</span><b style={{ textTransform: 'capitalize' }}>{data.billingCycle || '—'}</b></div>
        <div className="kpi"><span>Renews</span><b style={{ fontSize: 14 }}>{data.currentPeriodEnd ? fmtDate(data.currentPeriodEnd) : '—'}</b></div>
      </div>
      <div className="grid c2 mb">
        <div className="card">
          <div className="card-h"><h3>Usage</h3></div>
          <div className="card-b">
            {data.usage.length === 0 && <p className="hint">Your plan has no numeric limits.</p>}
            {data.usage.map((u) => {
              const pct = u.limit ? Math.min(100, Math.round(((u.current || 0) / u.limit) * 100)) : 0;
              return (
                <div key={u.key} style={{ marginBottom: 12 }}>
                  <div className="spread" style={{ fontSize: 13 }}><span>{u.name}{u.addons?.length ? ' (+ add-on)' : ''}</span><span>{u.current ?? '—'} / {u.limit} {u.unit || ''}</span></div>
                  <div style={{ height: 7, borderRadius: 4, background: '#eceefa' }}><div style={{ width: `${pct}%`, height: '100%', borderRadius: 4, background: pct >= 90 ? '#d92d20' : pct >= 80 ? '#f79009' : '#7c3aed' }} /></div>
                </div>
              );
            })}
          </div>
        </div>
        <div className="card">
          <div className="card-h"><h3>Add-ons</h3></div>
          <div className="card-b">
            {data.addons.length ? data.addons.map((a) => <div key={a.addon_key} className="spread" style={{ padding: '4px 0' }}><span>{a.name}</span><span className="badge purple">× {a.quantity}</span></div>)
              : <p className="hint">No add-ons. Ask ARTHVEX to add capacity or features.</p>}
          </div>
        </div>
      </div>
      <div className="card mb">
        <div className="card-h"><h3>Invoices</h3></div>
        {data.invoices.length === 0 ? <EmptyState title="No invoices yet" /> : (
          <div className="table-wrap"><table className="tbl">
            <thead><tr><th>Invoice</th><th>Period</th><th className="num">Total</th><th className="num">Paid</th><th>Due</th><th>Status</th></tr></thead>
            <tbody>{data.invoices.map((i) => (
              <tr key={i.invoice_number}><td><code>{i.invoice_number}</code></td><td style={{ fontSize: 12 }}>{fmtDate(i.period_start)} – {fmtDate(i.period_end)}</td>
                <td className="num">{money(i.total)}</td><td className="num">{money(i.amount_paid)}</td><td>{i.due_at ? fmtDate(i.due_at) : '—'}</td>
                <td><span className={'badge ' + (i.status === 'paid' ? 'green' : i.status === 'void' ? 'gray' : 'amber')}>{i.status}</span></td></tr>))}</tbody>
          </table></div>
        )}
        <p className="hint" style={{ padding: '0 16px 12px' }}>Payments are confirmed by ARTHVEX or the payment provider, never by this page. To change plan or add-ons, raise a request under Support.</p>
      </div>
      {!data.cancellation && !['cancelled', 'expired'].includes(data.status) && (
        <button className="btn danger sm" onClick={() => setCancelling(true)}>Cancel subscription at period end</button>
      )}
      {cancelling && <CancelModal onClose={() => setCancelling(false)} onDone={() => { setCancelling(false); toast('Cancellation scheduled'); reload(); }} />}
    </div>
  );
}

function CancelModal({ onClose, onDone }) {
  const [reason, setReason] = useState(''); const [error, setError] = useState('');
  const go = async () => { try { await api.post('/account/subscription/cancel', { reason }); onDone(); } catch (e) { setError(errMsg(e)); } };
  return (
    <Modal title="Cancel at the end of the period?" onClose={onClose} footer={<><button className="btn secondary" onClick={onClose}>Keep subscription</button><button className="btn danger" disabled={reason.trim().length < 5} onClick={go}>Schedule cancellation</button></>}>
      <p style={{ fontSize: 13.5 }}>You keep full access until the end of the paid period. Afterwards the company becomes read-only; your records are not deleted, and you can export them.</p>
      <TextAreaField label="Why are you cancelling? *" value={reason} onChange={setReason} />
      {error && <div className="error-box mt">{error}</div>}
    </Modal>
  );
}

function Checks({ title, checks }) {
  return (
    <div className="card mb">
      <div className="card-h"><h3>{title}</h3></div>
      <div className="card-b">
        {checks.map((c) => (
          <div key={c.key} className="row" style={{ padding: '6px 0', alignItems: 'flex-start' }}>
            <span className={'badge ' + (c.ok ? 'green' : c.severity === 'required' ? 'red' : 'amber')} style={{ minWidth: 28, textAlign: 'center' }}>{c.ok ? '✓' : c.severity === 'required' ? '✗' : '!'}</span>
            <div><strong style={{ fontSize: 13.5 }}>{c.label}</strong> <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>— {c.detail}</span>
              {!c.ok && <div style={{ fontSize: 12.5, color: '#b54708' }}>{c.fix}</div>}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Setup() {
  const { data, loading, error, reload } = useLoader(async () => (await api.get('/account/setup-health')).data.data, []);
  if (loading && !data) return <Skeleton />;
  if (error || !data) return <ErrorState message={error} onRetry={reload} />;
  return (
    <div>
      <Checks title="Company setup" checks={data.setup} />
      <div className={data.payroll.ready ? 'info-box mb' : 'error-box mb'}>{data.payroll.message}</div>
      <Checks title="Payroll readiness" checks={data.payroll.checks} />
      <Checks title="Security" checks={data.security} />
    </div>
  );
}

function DataQuality() {
  const { data, loading, error, reload } = useLoader(async () => (await api.get('/account/data-quality')).data.data, []);
  if (loading && !data) return <Skeleton />;
  if (error || !data) return <ErrorState message={error} onRetry={reload} />;
  const rows = [['employeesMissingDepartment', 'Employees without a department'], ['employeesMissingManager', 'Employees without a manager'],
    ['employeesMissingLocation', 'Employees without a location'], ['employeesWithoutSalary', 'Employees without an effective salary'],
    ['duplicateEmployeeCodes', 'Duplicate employee codes'], ['usersLinkedToMissingEmployee', 'Logins linked to a removed employee'], ['usersWithoutRole', 'Logins with no role']];
  return (
    <div className="card">
      <div className="card-h"><h3>Records needing attention</h3><span className="hint">Showing up to 20 per check</span></div>
      <div className="card-b">
        {rows.map(([k, label]) => (
          <div key={k} className="spread" style={{ padding: '7px 0', borderBottom: '1px solid var(--border)' }}>
            <span>{label}</span>
            {data[k].length === 0 ? <span className="badge green">none</span>
              : <span style={{ fontSize: 12.5 }}><span className="badge amber">{data[k].length}{data[k].length === 20 ? '+' : ''}</span> {data[k].slice(0, 6).map((x) => x.employee_code || x.id).join(', ')}{data[k].length > 6 ? '…' : ''}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

function Contacts() {
  const toast = useToast();
  const { data, reload } = useLoader(async () => (await api.get('/account/contacts')).data.data, []);
  const [f, setF] = useState({ contactType: 'billing', name: '', email: '', phone: '', gstin: '' });
  const [error, setError] = useState('');
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v }));
  const save = async () => { setError(''); try { await api.put('/account/contacts', f); toast('Contact saved'); reload(); } catch (e) { setError(errMsg(e)); } };
  return (
    <div className="grid c2">
      <div className="card"><div className="card-h"><h3>Contacts on file</h3></div>
        <div className="card-b">{(data || []).length ? data.map((c) => <div key={c.id} style={{ padding: '5px 0' }}><span className="badge purple">{c.contact_type}</span> {c.name || ''} {c.email}{c.gstin ? ` · GSTIN ${c.gstin}` : ''}</div>) : <p className="hint">No contacts yet — invoices go to the company owner until you add one.</p>}</div></div>
      <div className="card"><div className="card-h"><h3>Add or update</h3></div>
        <div className="card-b">
          <SelectField label="Type" value={f.contactType} onChange={set('contactType')} options={['billing', 'finance', 'legal', 'technical'].map((v) => ({ value: v, label: v }))} />
          <TextField label="Name" value={f.name} onChange={set('name')} /><TextField label="Email *" value={f.email} onChange={set('email')} />
          <TextField label="Phone" value={f.phone} onChange={set('phone')} /><TextField label="GSTIN" value={f.gstin} onChange={set('gstin')} />
          {error && <div className="error-box mb">{error}</div>}
          <button className="btn" onClick={save} disabled={!f.email}>Save contact</button>
        </div></div>
    </div>
  );
}

function Support() {
  const toast = useToast();
  const { data, loading, error, reload } = useLoader(async () => (await api.get('/account/support-tickets')).data.data, []);
  const [f, setF] = useState({ subject: '', body: '', category: 'other', priority: 'normal' });
  const [formError, setFormError] = useState('');
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v }));
  const save = async () => { setFormError(''); try { const { data: d } = await api.post('/account/support-tickets', f); toast(`Ticket ${d.data.ticketNo} raised`); setF({ subject: '', body: '', category: 'other', priority: 'normal' }); reload(); } catch (e) { setFormError(errMsg(e)); } };
  return (
    <div className="grid c2">
      <div className="card"><div className="card-h"><h3>Your tickets</h3></div>
        {loading && !data ? <Skeleton /> : error ? <ErrorState message={error} onRetry={reload} /> : !(data || []).length ? <EmptyState title="No tickets" text="Raise one when you need ARTHVEX's help." /> : (
          <div className="table-wrap"><table className="tbl"><thead><tr><th>Ticket</th><th>Subject</th><th>Status</th></tr></thead>
            <tbody>{data.map((t) => <tr key={t.id}><td><code>{t.ticket_no}</code></td><td>{t.subject}{t.resolution && <div style={{ fontSize: 12, color: 'var(--muted)' }}>{t.resolution}</div>}</td><td><span className="badge blue">{t.status.replace(/_/g, ' ')}</span></td></tr>)}</tbody></table></div>)}
      </div>
      <div className="card"><div className="card-h"><h3>Contact ARTHVEX</h3></div>
        <div className="card-b">
          <TextField label="Subject *" value={f.subject} onChange={set('subject')} />
          <TextAreaField label="What do you need?" value={f.body} onChange={set('body')} />
          <div className="form-grid">
            <SelectField label="Category" value={f.category} onChange={set('category')} options={['billing', 'technical', 'payroll', 'data', 'access', 'other'].map((v) => ({ value: v, label: v }))} />
            <SelectField label="Priority" value={f.priority} onChange={set('priority')} options={['low', 'normal', 'high', 'urgent'].map((v) => ({ value: v, label: v }))} />
          </div>
          {formError && <div className="error-box mb">{formError}</div>}
          <button className="btn" disabled={f.subject.trim().length < 5} onClick={save}>Raise ticket</button>
        </div></div>
    </div>
  );
}
