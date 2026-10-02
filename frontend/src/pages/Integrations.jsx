import React, { useEffect, useState } from 'react';
import { api, errMsg, fmtDate } from '../api';
import { useAuth } from '../auth';
import DataTable from '../components/DataTable';
import { Spinner, StatusBadge, useToast, Modal, TextField, SelectField, Tabs, StatCard, Empty } from '../components/ui';

const EVENT_TYPES = ['employee.created', 'employee.exited', 'lms.course_completed', 'travel.approved', 'travel.submitted', 'hr_case.created', 'development_plan.created', 'compensation.applied', 'webhook.test'];

export default function Integrations() {
  const toast = useToast();
  const [tab, setTab] = useState('keys');
  const [keys, setKeys] = useState(null);
  const [scopes, setScopes] = useState([]);
  const [webhooks, setWebhooks] = useState(null);
  const [deliveries, setDeliveries] = useState(null);
  const [selectedHook, setSelectedHook] = useState(null);
  const [connections, setConnections] = useState(null);
  const [lms, setLms] = useState(null);
  const [modal, setModal] = useState(null);
  const [form, setForm] = useState({});

  const load = async () => {
    try {
      const [k, s, w, c, l] = (await Promise.all([
        api.get('/integrations/keys'), api.get('/integrations/scopes'), api.get('/integrations/webhooks'),
        api.get('/integrations/connections'), api.get('/integrations/lms/status'),
      ])).map((x) => x.data.data);
      setKeys(k); setScopes(s); setWebhooks(w); setConnections(c); setLms(l);
    } catch (e) { toast(errMsg(e), true); }
  };
  useEffect(() => { load(); }, []); // eslint-disable-line

  const viewDeliveries = async (hook) => {
    setSelectedHook(hook);
    try { const { data } = await api.get(`/integrations/webhooks/${hook.id}/deliveries`); setDeliveries(data.data); } catch (e) { toast(errMsg(e), true); }
  };

  const createKey = async () => {
    try {
      const { data } = await api.post('/integrations/keys', { name: form.name, scopes: form.scopes || ['employee.read'] });
      setModal({ type: 'keyCreated', key: data.data.key, name: data.data.name });
      load();
    } catch (e) { toast(errMsg(e), true); }
  };

  const createWebhook = async () => {
    try {
      const events = form.events || [];
      if (!events.length) { toast('Pick at least one event', true); return; }
      const { data } = await api.post('/integrations/webhooks', { url: form.url, events });
      setModal({ type: 'hookCreated', secret: data.data.secret });
      load();
    } catch (e) { toast(errMsg(e), true); }
  };

  const createConnection = async () => {
    try {
      await api.post('/integrations/connections', { itype: form.itype || 'other', name: form.name, config: form.config ? JSON.parse(form.config) : null });
      toast('Connection added'); setModal(null); setForm({}); load();
    } catch (e) { toast(errMsg(e), true); }
  };

  if (!keys || !webhooks) return <Spinner />;
  const setF = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));
  const toggleScope = (s) => setForm((f) => ({ ...f, scopes: (f.scopes || []).includes(s) ? f.scopes.filter((x) => x !== s) : [...(f.scopes || []), s] }));

  return (
    <>
      <div className="mt"><Tabs active={tab} onChange={setTab} tabs={[
        { key: 'keys', label: 'API Keys' }, { key: 'webhooks', label: 'Webhooks' },
        { key: 'connections', label: 'Connections' }, { key: 'lms', label: 'LMS Sync' },
      ]} /></div>

      {tab === 'keys' && (
        <div className="card mt">
          <div className="card-h spread">
            <h3>Service API keys — /api/v1</h3>
            <button className="btn sm" onClick={() => { setForm({ scopes: ['employee.read'] }); setModal({ type: 'newKey' }); }}>New key</button>
          </div>
          <DataTable
            columns={[
              { key: 'name', label: 'Key', render: (r) => <><b>{r.name}</b><div style={{ fontSize: 12.5, color: 'var(--muted)' }}>{r.key_prefix}…</div></> },
              { key: 'scopes', label: 'Scopes', render: (r) => (r.scopes || []).map((s) => <span key={s} className="badge blue" style={{ marginRight: 4 }}>{s}</span>) },
              { key: 'last_used_at', label: 'Last used', render: (r) => r.last_used_at ? fmtDate(r.last_used_at, true) : 'Never' },
              { key: 'revoked_at', label: 'Status', render: (r) => r.revoked_at ? <span className="badge red">Revoked</span> : <span className="badge green">Active</span> },
              { key: 'created_at', label: 'Created', render: (r) => fmtDate(r.created_at) },
            ]}
            rows={keys}
            emptyText="No API keys"
            actions={(r) => !r.revoked_at ? (
              <button className="btn ghost sm danger" onClick={async () => { await api.delete(`/integrations/keys/${r.id}`); toast('Key revoked'); load(); }}>Revoke</button>
            ) : null}
          />
        </div>
      )}

      {tab === 'webhooks' && (
        <>
          <div className="card mt">
            <div className="card-h spread">
              <h3>Webhook subscriptions</h3>
              <button className="btn sm" onClick={() => { setForm({ events: [] }); setModal({ type: 'newHook' }); }}>New subscription</button>
            </div>
            <DataTable
              columns={[
                { key: 'url', label: 'Endpoint', render: (r) => <span style={{ fontSize: 12.5, wordBreak: 'break-all' }}>{r.url}</span> },
                { key: 'events', label: 'Events', render: (r) => (r.events || []).map((ev) => <span key={ev} className="badge amber" style={{ marginRight: 4, fontSize: 11 }}>{ev}</span>) },
                { key: 'delivered', label: 'Delivered', align: 'right' },
                { key: 'failing', label: 'Failing', align: 'right' },
                { key: 'active', label: 'Active', render: (r) => r.active ? '✅' : '⏸️' },
              ]}
              rows={webhooks}
              emptyText="No webhook subscriptions"
              actions={(r) => (
                <>
                  <button className="btn ghost sm" onClick={() => viewDeliveries(r)}>Deliveries</button>
                  <button className="btn ghost sm" onClick={async () => { await api.post(`/integrations/webhooks/${r.id}/test`); toast('Test event fired'); setTimeout(() => viewDeliveries(r), 800); }}>Test</button>
                </>
              )}
            />
          </div>
          {selectedHook && (
            <div className="card mt">
              <div className="card-h spread">
                <h3>Deliveries — {selectedHook.url.slice(0, 50)}…</h3>
                <button className="btn ghost sm" onClick={() => { setSelectedHook(null); setDeliveries(null); }}>Close</button>
              </div>
              {deliveries?.length === 0 && <Empty text="No deliveries yet" />}
              <DataTable
                columns={[
                  { key: 'event_type', label: 'Event', render: (r) => <b>{r.event_type}</b> },
                  { key: 'event_id', label: 'Event ID', render: (r) => <span style={{ fontSize: 11.5, fontFamily: 'monospace' }}>{r.event_id}</span> },
                  { key: 'status', label: 'Status', render: (r) => <StatusBadge value={r.status} /> },
                  { key: 'attempts', label: 'Attempts', align: 'right' },
                  { key: 'response_code', label: 'HTTP', align: 'right', render: (r) => r.response_code || '—' },
                  { key: 'created_at', label: 'When', render: (r) => fmtDate(r.created_at, true) },
                ]}
                rows={deliveries || []}
                emptyText=""
                actions={(r) => r.status === 'dead' ? (
                  <button className="btn ghost sm" onClick={async () => { await api.post(`/integrations/deliveries/${r.id}/retry`); toast('Retry attempted'); viewDeliveries(selectedHook); }}>Retry</button>
                ) : null}
              />
            </div>
          )}
        </>
      )}

      {tab === 'connections' && (
        <div className="card mt">
          <div className="card-h spread">
            <h3>Integration connections</h3>
            <button className="btn sm" onClick={() => setModal({ type: 'newConnection' })}>Add connection</button>
          </div>
          <DataTable
            columns={[
              { key: 'name', label: 'Connection', render: (r) => <b>{r.name}</b> },
              { key: 'itype', label: 'Type', render: (r) => <span className="badge blue">{r.itype}</span> },
              { key: 'status', label: 'Status', render: (r) => <StatusBadge value={r.status} /> },
              { key: 'last_sync_at', label: 'Last sync', render: (r) => r.last_sync_at ? fmtDate(r.last_sync_at, true) : '—' },
              { key: 'created_at', label: 'Added', render: (r) => fmtDate(r.created_at) },
            ]}
            rows={connections}
            emptyText="No integrations connected"
            actions={(r) => (
              <button className="btn ghost sm danger" onClick={async () => { await api.delete(`/integrations/connections/${r.id}`); toast('Removed'); load(); }}>Remove</button>
            )}
          />
        </div>
      )}

      {tab === 'lms' && (
        <>
          <div className="stat-grid mt">
            <StatCard label="Learners synced (identities)" value={lms?.learners} />
            <StatCard label="Course completions" value={lms?.completions} />
            <StatCard label="Certificates" value={lms?.certificates} />
            <StatCard label="Total learning hours" value={lms?.learningHours} />
          </div>
          <div className="card mt">
            <div className="card-h"><h3>HRMS ↔ LMS contract status</h3></div>
            <div style={{ padding: '0 14px 14px', fontSize: 13.5 }}>
              <p><b>HRMS → LMS</b> — the LMS pulls identities from <code>GET /api/v1/lms/employees</code> (employee_id, name, email, department, designation, status, manager) and subscribes to the <code>employee.exited</code> webhook to suspend learners on exit.</p>
              <p><b>LMS → HRMS</b> — course completions, certificates and learning hours POST to <code>/api/v1/lms/completions</code>, <code>/api/v1/lms/certifications</code> and <code>/api/v1/lms/learning-evidence</code> with an API key and Idempotency-Key header. They appear in Talent → Learning & Certifications.</p>
            </div>
          </div>
          {lms?.recent?.length > 0 && (
            <div className="card mt">
              <div className="card-h"><h3>Recent sync activity</h3></div>
              <DataTable
                columns={[
                  { key: 'course_name', label: 'Course', render: (r) => <b>{r.course_name}</b> },
                  { key: 'provider', label: 'Provider' },
                  { key: 'completed_on', label: 'Completed', render: (r) => fmtDate(r.completed_on) },
                  { key: 'learning_hours', label: 'Hours', align: 'right' },
                  { key: 'source', label: 'Source', render: (r) => <span className="badge purple">{r.source}</span> },
                ]}
                rows={lms.recent}
                emptyText=""
              />
            </div>
          )}
        </>
      )}

      {modal?.type === 'newKey' && (
        <Modal title="Create API key" onClose={() => setModal(null)} footer={<><button className="btn secondary" onClick={() => setModal(null)}>Cancel</button><button className="btn" onClick={createKey}>Create</button></>}>
          <TextField label="Key name *" value={form.name} onChange={setF('name')} placeholder="e.g. Arthvex LMS production" />
          <div className="field"><label>Scopes</label></div>
          {scopes.map((s) => (
            <label className="check" key={s} style={{ marginLeft: 4 }}>
              <input type="checkbox" checked={(form.scopes || []).includes(s)} onChange={() => toggleScope(s)} /> {s}
            </label>
          ))}
        </Modal>
      )}

      {modal?.type === 'keyCreated' && (
        <Modal title="API key created" onClose={() => { setModal(null); }} footer={<button className="btn" onClick={() => setModal(null)}>I've stored it safely</button>}>
          <p><b>{modal.name}</b> — copy this key now. It is shown only once.</p>
          <div className="card" style={{ fontFamily: 'monospace', fontSize: 13, wordBreak: 'break-all', margin: '10px 0' }}>{modal.key}</div>
          <p style={{ fontSize: 12.5, color: 'var(--muted)' }}>Use it as <code>Authorization: Bearer &lt;key&gt;</code> (or <code>X-Api-Key</code>) against <code>/api/v1/*</code> endpoints.</p>
        </Modal>
      )}

      {modal?.type === 'newHook' && (
        <Modal title="New webhook subscription" onClose={() => setModal(null)} footer={<><button className="btn secondary" onClick={() => setModal(null)}>Cancel</button><button className="btn" onClick={createWebhook}>Create</button></>}>
          <TextField label="Endpoint URL *" value={form.url} onChange={setF('url')} placeholder="https://lms.arthvex.example/hooks/hrms" />
          <div className="field"><label>Events</label></div>
          {EVENT_TYPES.map((ev) => (
            <label className="check" key={ev} style={{ marginLeft: 4 }}>
              <input type="checkbox" checked={(form.events || []).includes(ev)}
                onChange={() => setForm((f) => ({ ...f, events: (f.events || []).includes(ev) ? f.events.filter((x) => x !== ev) : [...(f.events || []), ev] }))} /> {ev}
            </label>
          ))}
        </Modal>
      )}

      {modal?.type === 'hookCreated' && (
        <Modal title="Subscription created" onClose={() => setModal(null)} footer={<button className="btn" onClick={() => setModal(null)}>Done</button>}>
          <p>Signing secret — shown once. Verify deliveries with <code>X-Arthvex-Signature</code> (HMAC-SHA256 of <code>eventId.timestamp.body</code>).</p>
          <div className="card" style={{ fontFamily: 'monospace', fontSize: 13, wordBreak: 'break-all', margin: '10px 0' }}>{modal.secret}</div>
        </Modal>
      )}

      {modal?.type === 'newConnection' && (
        <Modal title="Add integration connection" onClose={() => setModal(null)} footer={<><button className="btn secondary" onClick={() => setModal(null)}>Cancel</button><button className="btn" onClick={createConnection}>Add</button></>}>
          <SelectField label="Type *" value={form.itype} onChange={setF('itype')} options={[
            { value: 'biometric', label: 'Biometric device' }, { value: 'banking', label: 'Banking' }, { value: 'accounting', label: 'Accounting' },
            { value: 'lms', label: 'LMS' }, { value: 'email', label: 'Email' }, { value: 'whatsapp', label: 'WhatsApp' },
            { value: 'calendar', label: 'Calendar' }, { value: 'jobboard', label: 'Job board' }, { value: 'other', label: 'Other' },
          ]} />
          <TextField label="Name *" value={form.name} onChange={setF('name')} />
          <div className="field"><label>Config (JSON, optional)</label><textarea rows={4} style={{ fontFamily: 'monospace', fontSize: 12.5 }} value={form.config || ''} onChange={(e) => setForm((f) => ({ ...f, config: e.target.value }))} placeholder='{"baseUrl":"…"}' /></div>
        </Modal>
      )}
    </>
  );
}
