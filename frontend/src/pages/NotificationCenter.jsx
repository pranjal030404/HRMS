import React, { useEffect, useState } from 'react';
import { api, errMsg, fmtDate } from '../api';
import { useAuth } from '../auth';
import DataTable from '../components/DataTable';
import { Spinner, StatusBadge, useToast, Modal, TextField, SelectField, Tabs, Empty } from '../components/ui';

export default function NotificationCenter() {
  const { can } = useAuth();
  const toast = useToast();
  const [tab, setTab] = useState('templates');
  const [templates, setTemplates] = useState(null);
  const [vars, setVars] = useState({ common: [], events: [] });
  const [logs, setLogs] = useState(null);
  const [prefs, setPrefs] = useState(null);
  const [myEvents, setMyEvents] = useState([]);
  const [modal, setModal] = useState(null);
  const [form, setForm] = useState({});

  const load = async () => {
    try {
      if (can('notification.manage')) {
        const [t, v, l] = (await Promise.all([
          api.get('/notifications-center/templates'), api.get('/notifications-center/template-variables'), api.get('/notifications-center/delivery-logs'),
        ])).map((x) => x.data.data);
        setTemplates(t); setVars(v); setLogs(l);
      }
      const p = await api.get('/notifications-center/my/prefs');
      setPrefs(p.data.data); setMyEvents(p.data.events);
    } catch (e) { toast(errMsg(e), true); }
  };
  useEffect(() => { load(); }, []); // eslint-disable-line

  const saveTemplate = async () => {
    try {
      await api.post('/notifications-center/templates', { eventKey: form.eventKey, channel: form.channel || 'email', subject: form.subject, body: form.body });
      toast('Template saved — overrides the default'); setModal(null); setForm({}); load();
    } catch (e) { toast(errMsg(e), true); }
  };

  const preview = async () => {
    try {
      const { data } = await api.post('/notifications-center/templates/preview', { subject: form.subject, body: form.body });
      setModal((m) => ({ ...m, preview: data.data }));
    } catch (e) { toast(errMsg(e), true); }
  };

  const setPref = async (eventKey, key, value) => {
    try {
      const current = prefs.find((p) => p.event_key === eventKey) || {};
      const patch = { eventKey, inappEnabled: key === 'inapp' ? value : current.inapp_enabled !== 0, emailEnabled: key === 'email' ? value : current.email_enabled !== 0 };
      await api.put('/notifications-center/my/prefs', patch);
      setPrefs((ps) => {
        const exists = ps.some((p) => p.event_key === eventKey);
        return exists ? ps.map((p) => (p.event_key === eventKey ? { ...p, inapp_enabled: patch.inappEnabled ? 1 : 0, email_enabled: patch.emailEnabled ? 1 : 0 } : p))
          : [...ps, { event_key: eventKey, inapp_enabled: patch.inappEnabled ? 1 : 0, email_enabled: patch.emailEnabled ? 1 : 0 }];
      });
    } catch (e) { toast(errMsg(e), true); }
  };

  if (can('notification.manage') && (!templates || !logs)) return <Spinner />;
  if (!can('notification.manage') && !prefs) return <Spinner />;
  const setF = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));
  const prefFor = (ev) => prefs?.find((p) => p.event_key === ev);

  return (
    <>
      <div className="mt"><Tabs active={tab} onChange={setTab} tabs={[
        ...(can('notification.manage') ? [{ key: 'templates', label: 'Templates' }, { key: 'logs', label: 'Delivery Logs' }] : []),
        { key: 'prefs', label: 'My Preferences' },
      ]} /></div>

      {tab === 'templates' && (
        <div className="card mt">
          <div className="card-h spread">
            <h3>Notification templates</h3>
            <button className="btn sm" onClick={() => { setForm({ channel: 'email' }); setModal({ type: 'edit' }); }}>New / override template</button>
          </div>
          <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: '0 14px 10px' }}>
            Rows marked <span className="badge gray">default</span> are built-in; create an override with the same event key to customize. Variables use <code>&#123;&#123;name&#125;&#125;</code> syntax.
          </p>
          <DataTable
            columns={[
              { key: 'event_key', label: 'Event', render: (r) => <b>{r.event_key}</b> },
              { key: 'channel', label: 'Channel', render: (r) => <span className="badge blue">{r.channel}</span> },
              { key: 'subject', label: 'Subject', render: (r) => r.subject },
              { key: 'locale', label: 'Locale' },
              { key: 'source', label: 'Source', render: (r) => r.is_default ? <span className="badge gray">default</span> : <span className="badge green">custom</span> },
            ]}
            rows={templates}
            emptyText=""
            actions={(r) => !r.is_default ? (
              <>
                <button className="btn ghost sm" onClick={() => { setForm({ eventKey: r.event_key, channel: r.channel, subject: r.subject, body: r.body }); setModal({ type: 'edit', id: r.id }); }}>Edit</button>
                <button className="btn ghost sm danger" onClick={async () => { await api.delete(`/notifications-center/templates/${r.id}`); toast('Reverted to default'); load(); }}>Revert</button>
              </>
            ) : (
              <button className="btn ghost sm" onClick={() => { setForm({ eventKey: r.event_key, channel: 'email', subject: r.subject, body: r.body }); setModal({ type: 'edit' }); }}>Override</button>
            )}
          />
        </div>
      )}

      {tab === 'logs' && (
        <div className="card mt">
          <div className="card-h"><h3>Delivery logs (email & channels)</h3></div>
          <DataTable
            columns={[
              { key: 'event_key', label: 'Event' },
              { key: 'channel', label: 'Channel', render: (r) => <span className="badge blue">{r.channel}</span> },
              { key: 'recipient', label: 'Recipient' },
              { key: 'subject', label: 'Subject', render: (r) => r.subject || '—' },
              { key: 'status', label: 'Status', render: (r) => <StatusBadge value={r.status} labels={{ queued: ['gray', 'Queued'] }} /> },
              { key: 'error', label: 'Error', render: (r) => r.error || '—' },
              { key: 'created_at', label: 'When', render: (r) => fmtDate(r.created_at, true) },
            ]}
            rows={logs}
            emptyText="No deliveries logged yet"
          />
        </div>
      )}

      {tab === 'prefs' && (
        <div className="card mt">
          <div className="card-h"><h3>My notification preferences</h3></div>
          <div className="table-wrap">
            <table className="tbl">
              <thead><tr><th>Event</th><th>In-app</th><th>Email</th></tr></thead>
              <tbody>
                {myEvents.map((ev) => {
                  const p = prefFor(ev);
                  return (
                    <tr key={ev}>
                      <td>{ev}</td>
                      <td><input type="checkbox" checked={p ? p.inapp_enabled === 1 : true} onChange={(e) => setPref(ev, 'inapp', e.target.checked)} /></td>
                      <td><input type="checkbox" checked={p ? p.email_enabled === 1 : true} onChange={(e) => setPref(ev, 'email', e.target.checked)} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {modal?.type === 'edit' && (
        <Modal title={modal.id ? 'Edit template' : 'New / override template'} onClose={() => setModal(null)} wide footer={
          <>
            <button className="btn secondary" onClick={() => setModal(null)}>Cancel</button>
            <button className="btn ghost" onClick={preview}>Preview with sample data</button>
            <button className="btn" onClick={saveTemplate}>Save</button>
          </>
        }>
          <SelectField label="Event key *" value={form.eventKey} onChange={setF('eventKey')}
            options={[...new Set([...(vars.events || []), form.eventKey].filter(Boolean))].map((ev) => ({ value: ev, label: ev }))} />
          <SelectField label="Channel" value={form.channel} onChange={setF('channel')} options={[
            { value: 'email', label: 'Email' }, { value: 'inapp', label: 'In-app' }, { value: 'sms', label: 'SMS' }, { value: 'whatsapp', label: 'WhatsApp' },
          ]} />
          <TextField label="Subject *" value={form.subject} onChange={setF('subject')} />
          <div className="field"><label>Body *</label><textarea rows={6} value={form.body || ''} onChange={(e) => setForm((f) => ({ ...f, body: e.target.value }))} /></div>
          <p style={{ fontSize: 12, color: 'var(--muted)' }}>Variables: {(vars.common || []).map((v) => `{{${v}}}`).join(', ')}</p>
          {modal.preview && (
            <div className="card" style={{ background: '#f9fafb', margin: '10px 0' }}>
              <b>Subject:</b> {modal.preview.subject}<br /><b>Body:</b>
              <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12.5 }}>{modal.preview.body}</pre>
            </div>
          )}
        </Modal>
      )}
    </>
  );
}
