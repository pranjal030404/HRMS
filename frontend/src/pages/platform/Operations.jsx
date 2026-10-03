import React, { useState } from 'react';
import { api, errMsg, fmtDate } from '../../api';
import { Modal, SelectField, Tabs, TextAreaField, TextField, useToast } from '../../components/ui';
import { EmptyState, ErrorState } from '../../components/PlatformTable';
import { PageHeader, PlatformSection, useLoader, usePlatform } from './shared';

export default function PlatformOperations() {
  return (
    <PlatformSection perm="platform.dashboard.view">
      <Operations />
    </PlatformSection>
  );
}

const TABS = [{ key: 'notifications', label: 'Notifications' }, { key: 'incidents', label: 'Incidents' }, { key: 'maintenance', label: 'Maintenance' }];

function Operations() {
  const [tab, setTab] = useState('notifications');
  return (
    <div>
      <PageHeader title="Operations" sub="What needs ARTHVEX's attention: alerts, incidents and planned maintenance. Every figure here comes from the platform's own records." />
      <Tabs tabs={TABS} active={tab} onChange={setTab} />
      {tab === 'notifications' && <Notifications />}
      {tab === 'incidents' && <Incidents />}
      {tab === 'maintenance' && <Maintenance />}
    </div>
  );
}

const SEV = { critical: 'red', warning: 'amber', info: 'blue' };

function Notifications() {
  const { data, loading, error, reload } = useLoader(async () => (await api.get('/platform/notifications', { params: { limit: 50 } })).data.data, []);
  const markAll = async () => { await api.post('/platform/notifications/read', { ids: (data || []).filter((n) => !n.read_at).map((n) => n.id) }); reload(); };
  if (error) return <ErrorState message={error} onRetry={reload} />;
  return (
    <div className="card">
      <div className="card-h"><h3>Alerts</h3><button className="btn secondary sm" onClick={markAll} disabled={!(data || []).some((n) => !n.read_at)}>Mark all read</button></div>
      {loading ? <div className="card-b"><div className="skel" style={{ height: 80 }} /></div>
        : !(data || []).length ? <EmptyState title="Nothing needs attention" text="Trial endings, failed payments and plan-limit warnings appear here." />
          : (data || []).map((n) => (
            <div key={n.id} className="row" style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)', opacity: n.read_at ? .6 : 1, alignItems: 'flex-start' }}>
              <span className={'badge ' + SEV[n.severity]}>{n.severity}</span>
              <div style={{ flex: 1 }}>
                <strong style={{ fontSize: 13.5 }}>{n.title}</strong>
                <div style={{ fontSize: 12, color: 'var(--muted)' }}>{n.tenant_name ? `${n.tenant_name} · ` : ''}{n.body || ''} · {fmtDate(n.created_at, true)}</div>
              </div>
            </div>
          ))}
    </div>
  );
}

function Incidents() {
  const toast = useToast();
  const { can } = usePlatform();
  const write = can('platform.support.grant') || can('platform.security.manage');
  const { data, loading, error, reload } = useLoader(async () => (await api.get('/platform/incidents')).data.data, []);
  const [modal, setModal] = useState(null);
  if (error) return <ErrorState message={error} onRetry={reload} />;
  return (
    <div className="card">
      <div className="card-h"><h3>Incidents</h3>{write && <button className="btn sm" onClick={() => setModal({ type: 'new' })}>Open incident</button>}</div>
      {loading ? <div className="card-b"><div className="skel" style={{ height: 80 }} /></div>
        : !(data || []).length ? <EmptyState title="No incidents" text="Open one to track severity, affected systems and the timeline." />
          : (
            <div className="table-wrap"><table className="tbl">
              <thead><tr><th>Incident</th><th>Severity</th><th>Status</th><th>Affected</th><th>Opened</th><th /></tr></thead>
              <tbody>{data.map((i) => (
                <tr key={i.id}>
                  <td><strong>{i.title}</strong>{i.root_cause && <div style={{ fontSize: 12, color: 'var(--muted)' }}>Cause: {i.root_cause}</div>}</td>
                  <td><span className={'badge ' + (['sev1', 'sev2'].includes(i.severity) ? 'red' : 'amber')}>{i.severity}</span></td>
                  <td><span className={'badge ' + (i.status === 'resolved' ? 'green' : 'blue')}>{i.status}</span></td>
                  <td style={{ fontSize: 12 }}>{(i.affected_systems || []).join(', ') || '—'}</td>
                  <td style={{ fontSize: 12 }}>{fmtDate(i.created_at, true)}</td>
                  <td className="actions">{write && i.status !== 'resolved' && <button className="btn ghost sm" onClick={() => setModal({ type: 'update', i })}>Update</button>}</td>
                </tr>))}</tbody>
            </table></div>
          )}
      {modal?.type === 'new' && <IncidentForm onClose={() => setModal(null)} onDone={() => { setModal(null); toast('Incident opened'); reload(); }} />}
      {modal?.type === 'update' && <IncidentUpdate i={modal.i} onClose={() => setModal(null)} onDone={() => { setModal(null); toast('Timeline updated'); reload(); }} />}
    </div>
  );
}

function IncidentForm({ onClose, onDone }) {
  const [f, setF] = useState({ title: '', severity: 'sev3', systems: '', message: '' });
  const [error, setError] = useState('');
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v }));
  const save = async () => {
    try { await api.post('/platform/incidents', { title: f.title, severity: f.severity, message: f.message, affectedSystems: f.systems.split(',').map((x) => x.trim()).filter(Boolean) }); onDone(); } catch (e) { setError(errMsg(e)); }
  };
  return (
    <Modal title="Open incident" onClose={onClose} footer={<><button className="btn secondary" onClick={onClose}>Cancel</button><button className="btn" disabled={f.title.trim().length < 5} onClick={save}>Open</button></>}>
      <TextField label="Title *" value={f.title} onChange={set('title')} />
      <SelectField label="Severity" value={f.severity} onChange={set('severity')} options={['sev1', 'sev2', 'sev3', 'sev4'].map((v) => ({ value: v, label: v }))} />
      <TextField label="Affected systems" value={f.systems} onChange={set('systems')} hint="Comma-separated, e.g. api, database, webhooks" />
      <TextAreaField label="First update" value={f.message} onChange={set('message')} />
      {error && <div className="error-box mt">{error}</div>}
    </Modal>
  );
}

function IncidentUpdate({ i, onClose, onDone }) {
  const [f, setF] = useState({ status: i.status, message: '', rootCause: '', resolution: '' });
  const [error, setError] = useState('');
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v }));
  const save = async () => { try { await api.post(`/platform/incidents/${i.id}/updates`, f); onDone(); } catch (e) { setError(errMsg(e)); } };
  return (
    <Modal title={`Update: ${i.title}`} onClose={onClose} footer={<><button className="btn secondary" onClick={onClose}>Cancel</button><button className="btn" disabled={f.message.trim().length < 3} onClick={save}>Post update</button></>}>
      <SelectField label="Status" value={f.status} onChange={set('status')} options={['investigating', 'identified', 'monitoring', 'resolved'].map((v) => ({ value: v, label: v }))} />
      <TextAreaField label="Update *" value={f.message} onChange={set('message')} />
      {f.status === 'resolved' && (<><TextField label="Root cause *" value={f.rootCause} onChange={set('rootCause')} /><TextField label="Resolution *" value={f.resolution} onChange={set('resolution')} /></>)}
      {error && <div className="error-box mt">{error}</div>}
    </Modal>
  );
}

function Maintenance() {
  const toast = useToast();
  const { can } = usePlatform();
  const write = can('platform.tenants.manage');
  const { data, loading, error, reload } = useLoader(async () => (await api.get('/platform/maintenance')).data.data, []);
  const [open, setOpen] = useState(false);
  const cancel = async (w) => {
    const reason = window.prompt('Reason for cancelling this window?'); // eslint-disable-line no-alert
    if (!reason) return;
    try { await api.delete(`/platform/maintenance/${w.id}`, { data: { reason } }); toast('Window cancelled'); reload(); } catch (e) { toast(errMsg(e), true); }
  };
  if (error) return <ErrorState message={error} onRetry={reload} />;
  const now = Date.now();
  return (
    <div className="card">
      <div className="card-h"><h3>Maintenance windows</h3>{write && <button className="btn sm" onClick={() => setOpen(true)}>Schedule</button>}</div>
      {loading ? <div className="card-b"><div className="skel" style={{ height: 80 }} /></div>
        : !(data || []).length ? <EmptyState title="No maintenance scheduled" text="While a window is active, company users see your message and platform staff are never blocked." />
          : (
            <div className="table-wrap"><table className="tbl">
              <thead><tr><th>Scope</th><th>Message</th><th>Starts</th><th>Ends</th><th>State</th><th /></tr></thead>
              <tbody>{data.map((w) => {
                const live = w.status === 'scheduled' && new Date(w.starts_at) <= now && new Date(w.ends_at) > now;
                return (
                  <tr key={w.id}>
                    <td>{w.tenant_name || 'Whole platform'}</td><td>{w.message}</td>
                    <td style={{ fontSize: 12 }}>{fmtDate(w.starts_at, true)}</td><td style={{ fontSize: 12 }}>{fmtDate(w.ends_at, true)}</td>
                    <td><span className={'badge ' + (w.status === 'cancelled' ? 'gray' : live ? 'red' : 'blue')}>{w.status === 'cancelled' ? 'cancelled' : live ? 'in progress' : 'scheduled'}</span></td>
                    <td className="actions">{write && w.status === 'scheduled' && <button className="btn ghost sm" onClick={() => cancel(w)}>Cancel</button>}</td>
                  </tr>);
              })}</tbody>
            </table></div>
          )}
      {open && <MaintenanceForm onClose={() => setOpen(false)} onDone={() => { setOpen(false); toast('Maintenance scheduled'); reload(); }} />}
    </div>
  );
}

function MaintenanceForm({ onClose, onDone }) {
  const [f, setF] = useState({ tenantId: '', message: '', startsAt: '', endsAt: '', reason: '' });
  const [error, setError] = useState('');
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v }));
  const save = async () => {
    try { await api.post('/platform/maintenance', { ...f, tenantId: f.tenantId ? Number(f.tenantId) : null, startsAt: new Date(f.startsAt), endsAt: new Date(f.endsAt) }); onDone(); } catch (e) { setError(errMsg(e)); }
  };
  return (
    <Modal title="Schedule maintenance" onClose={onClose} footer={<><button className="btn secondary" onClick={onClose}>Cancel</button><button className="btn" disabled={!f.startsAt || !f.endsAt || f.message.trim().length < 5 || f.reason.trim().length < 5} onClick={save}>Schedule</button></>}>
      <TextField label="Company ID" type="number" value={f.tenantId} onChange={set('tenantId')} hint="Leave empty for the whole platform" />
      <TextField label="Message shown to users *" value={f.message} onChange={set('message')} />
      <div className="form-grid">
        <TextField label="Starts *" type="datetime-local" value={f.startsAt} onChange={set('startsAt')} />
        <TextField label="Ends *" type="datetime-local" value={f.endsAt} onChange={set('endsAt')} />
      </div>
      <TextAreaField label="Reason *" value={f.reason} onChange={set('reason')} />
      {error && <div className="error-box mt">{error}</div>}
    </Modal>
  );
}
