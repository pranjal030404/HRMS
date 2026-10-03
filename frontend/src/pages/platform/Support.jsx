import React, { useState } from 'react';
import { api, errMsg, fmtDate } from '../../api';
import { Drawer, Modal, SelectField, TextAreaField, TextField, useToast } from '../../components/ui';
import { PlatformTable, EmptyState } from '../../components/PlatformTable';
import { PageHeader, PlatformSection, useLoader, usePlatform } from './shared';
import GrantSupport from './GrantSupport';

export default function PlatformSupportTickets() {
  return (
    <PlatformSection perm="platform.support.view">
      <Tickets />
    </PlatformSection>
  );
}

const PRIORITY = { urgent: 'red', high: 'amber', normal: 'blue', low: 'gray' };
const STATUS = { open: 'blue', in_progress: 'purple', waiting_customer: 'amber', resolved: 'green', closed: 'gray' };

function Tickets() {
  const { can } = usePlatform();
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [open, setOpen] = useState(null);
  const [creating, setCreating] = useState(false);
  const write = can('platform.support.grant');
  const { data, meta, loading, error, reload } = useLoader(async () => {
    const { data } = await api.get('/platform/support-tickets', { params: { status: status || undefined, page, limit: 25 } });
    return data;
  }, [status, page]);

  return (
    <div>
      <PageHeader title="Support tickets"
        sub="Customer requests to ARTHVEX. Separate from the employee Helpdesk inside each company. Access to a customer's data is requested from a ticket and recorded against its number."
        actions={write && <button className="btn" onClick={() => setCreating(true)}>New ticket</button>} />
      <div className="card mb"><div className="card-b row wrap">
        {['', 'open', 'in_progress', 'waiting_customer', 'resolved', 'closed'].map((s) => (
          <button key={s || 'all'} className={'btn sm ' + (status === s ? '' : 'secondary')} onClick={() => { setStatus(s); setPage(1); }}>{s ? s.replace(/_/g, ' ') : 'All'}</button>
        ))}
      </div></div>
      <div className="card">
        <PlatformTable id="support-tickets" rows={data || []} loading={loading} error={error} onRetry={reload}
          serverMeta={meta} onPage={setPage} hideSearch onRowClick={(t) => setOpen(t)}
          columns={[
            { key: 'ticket_no', label: 'Ticket', sortable: true, render: (t) => <code>{t.ticket_no}</code> },
            { key: 'subject', label: 'Subject', sortable: true, render: (t) => <strong>{t.subject}</strong> },
            { key: 'tenant_name', label: 'Company', sortable: true },
            { key: 'priority', label: 'Priority', sortable: true, render: (t) => <span className={'badge ' + PRIORITY[t.priority]}>{t.priority}</span> },
            { key: 'status', label: 'Status', sortable: true, render: (t) => <span className={'badge ' + STATUS[t.status]}>{t.status.replace(/_/g, ' ')}</span> },
            { key: 'sla', label: 'SLA', render: (t) => (t.sla_due_at ? (t.sla_breached ? <span className="badge red">breached</span> : <span style={{ fontSize: 12 }}>due {fmtDate(t.sla_due_at, true)}</span>) : <span style={{ color: 'var(--muted)' }}>none configured</span>) },
            { key: 'created_at', label: 'Opened', sortable: true, render: (t) => fmtDate(t.created_at) },
          ]}
          empty={<EmptyState title="No tickets" text="Nothing matches that filter." />} />
      </div>
      {creating && <NewTicket onClose={() => setCreating(false)} onDone={() => { setCreating(false); reload(); }} />}
      {open && <TicketDrawer id={open.id} write={write} onClose={() => setOpen(null)} onChanged={reload} />}
    </div>
  );
}

function NewTicket({ onClose, onDone }) {
  const toast = useToast();
  const [f, setF] = useState({ tenantId: '', subject: '', body: '', category: 'other', priority: 'normal' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v }));
  const save = async () => {
    setBusy(true); setError('');
    try { const { data } = await api.post('/platform/support-tickets', { ...f, tenantId: Number(f.tenantId) }); toast(`Ticket ${data.data.ticketNo} created`); onDone(); } catch (e) { setError(errMsg(e)); }
    setBusy(false);
  };
  return (
    <Modal title="New support ticket" onClose={onClose}
      footer={<><button className="btn secondary" onClick={onClose}>Cancel</button><button className="btn" onClick={save} disabled={busy || !f.tenantId || f.subject.trim().length < 5}>Create</button></>}>
      <TextField label="Company ID *" type="number" value={f.tenantId} onChange={set('tenantId')} hint="The numeric ID shown on the company page" />
      <TextField label="Subject *" value={f.subject} onChange={set('subject')} />
      <TextAreaField label="Details" value={f.body} onChange={set('body')} />
      <div className="form-grid">
        <SelectField label="Category" value={f.category} onChange={set('category')} options={['billing', 'technical', 'payroll', 'data', 'access', 'other'].map((v) => ({ value: v, label: v }))} />
        <SelectField label="Priority" value={f.priority} onChange={set('priority')} options={['low', 'normal', 'high', 'urgent'].map((v) => ({ value: v, label: v }))} />
      </div>
      {error && <div className="error-box mt">{error}</div>}
    </Modal>
  );
}

function TicketDrawer({ id, write, onClose, onChanged }) {
  const toast = useToast();
  const { data, loading, reload } = useLoader(async () => (await api.get(`/platform/support-tickets/${id}`)).data.data, [id]);
  const [note, setNote] = useState('');
  const [visibility, setVisibility] = useState('internal');
  const [resolution, setResolution] = useState('');
  const [access, setAccess] = useState(false);
  const [error, setError] = useState('');

  const act = async (fn, ok) => {
    setError('');
    try { await fn(); if (ok) toast(ok); await reload(); onChanged(); } catch (e) { setError(errMsg(e)); }
  };
  if (loading || !data) return <Drawer title="Ticket" onClose={onClose}><div className="skel" style={{ height: 160 }} /></Drawer>;

  return (
    <Drawer title={`${data.ticket_no} · ${data.tenant_name}`} onClose={onClose} width={620}>
      <h3 style={{ marginBottom: 6 }}>{data.subject}</h3>
      <p style={{ color: 'var(--muted)', fontSize: 13 }}>{data.body || 'No details.'}</p>
      <div className="row wrap mb" style={{ gap: 8 }}>
        <span className={'badge ' + PRIORITY[data.priority]}>{data.priority}</span>
        <span className={'badge ' + STATUS[data.status]}>{data.status.replace(/_/g, ' ')}</span>
        <span className="badge gray">{data.category}</span>
      </div>

      {write && (
        <div className="card mb"><div className="card-b">
          <div className="row wrap">
            {['in_progress', 'waiting_customer'].map((s) => (
              <button key={s} className="btn secondary sm" disabled={data.status === s} onClick={() => act(() => api.patch(`/platform/support-tickets/${id}`, { status: s }), 'Status updated')}>{s.replace(/_/g, ' ')}</button>
            ))}
            <button className="btn secondary sm" onClick={() => setAccess(true)}>Request support access</button>
          </div>
          <TextAreaField label="Resolution (needed to resolve or close)" value={resolution} onChange={setResolution} rows={2} />
          <button className="btn sm" disabled={resolution.trim().length < 5} onClick={() => act(() => api.patch(`/platform/support-tickets/${id}`, { status: 'resolved', resolution }), 'Ticket resolved')}>Resolve</button>
        </div></div>
      )}

      {data.supportSessions?.length > 0 && (
        <div className="info-box mb">Support access sessions for this ticket: {data.supportSessions.map((s) => `#${s.id} ${s.access_type} (${s.status})`).join(', ')}</div>
      )}

      <h4 style={{ margin: '14px 0 8px', fontSize: 13 }}>Notes</h4>
      {(data.notes || []).map((n) => (
        <div key={n.id} className="card mb"><div className="card-b" style={{ padding: 12 }}>
          <div className="spread"><strong style={{ fontSize: 13 }}>{n.author_name}</strong><span className={'badge ' + (n.visibility === 'customer' ? 'green' : 'gray')}>{n.visibility === 'customer' ? 'visible to customer' : 'internal'}</span></div>
          <p style={{ margin: '6px 0 0', fontSize: 13 }}>{n.body}</p>
          <span style={{ fontSize: 11, color: 'var(--muted)' }}>{fmtDate(n.created_at, true)}</span>
        </div></div>
      ))}
      {!data.notes?.length && <p className="hint">No notes yet.</p>}
      {write && (
        <>
          <TextAreaField label="Add a note" value={note} onChange={setNote} rows={2} />
          <div className="row">
            <SelectField value={visibility} onChange={setVisibility} options={[{ value: 'internal', label: 'Internal only' }, { value: 'customer', label: 'Visible to the customer' }]} />
            <button className="btn sm" disabled={note.trim().length < 2} onClick={() => act(async () => { await api.post(`/platform/support-tickets/${id}/notes`, { body: note, visibility }); setNote(''); }, 'Note added')}>Add note</button>
          </div>
        </>
      )}
      {error && <div className="error-box mt">{error}</div>}
      {access && <GrantSupport tenantId={data.tenant_id} tenantName={data.tenant_name} ticketRef={data.ticket_no} onClose={() => setAccess(false)} onGranted={reload} />}
    </Drawer>
  );
}
