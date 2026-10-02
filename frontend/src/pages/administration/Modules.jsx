import React, { useState } from 'react';
import { api, errMsg, fmtDate } from '../../api';
import { useAuth } from '../../auth';
import DataTable from '../../components/DataTable';
import { Confirm, Modal, StatusBadge, Tabs, TextField, useToast } from '../../components/ui';
import { AdminSection, PageHeader, Toggle, listLoader, num, useLoader } from './shared';

export default function AdminModules() {
  return (
    <AdminSection sectionKey="modules">
      <Modules />
    </AdminSection>
  );
}

function Modules() {
  const { can, refreshMe } = useAuth();
  const toast = useToast();
  const [tab, setTab] = useState('modules');
  const { data, loading, reload } = useLoader(listLoader('/administration/modules'), []);
  const [busy, setBusy] = useState(null);
  const [resetting, setResetting] = useState(null);

  const canManage = can('administration.modules.manage');

  const flip = async (m, enabled) => {
    setBusy(m.key);
    try {
      await api.put(`/administration/modules/${m.key}`, { enabled });
      toast(`${m.name} ${enabled ? 'enabled' : 'disabled'}`);
      reload(true);
      refreshMe(); // re-resolve accessibleModules so the sidebar follows the switch
    } catch (e) { toast(errMsg(e), true); }
    setBusy(null);
  };

  const doReset = async () => {
    try {
      await api.post(`/administration/modules/${resetting.key}/reset`);
      toast(`${resetting.name} reset to default`);
      setResetting(null);
      reload();
      refreshMe();
    } catch (e) { toast(errMsg(e), true); }
  };

  const byCategory = (data || []).reduce((acc, m) => {
    (acc[m.category || 'general'] = acc[m.category || 'general'] || []).push(m);
    return acc;
  }, {});

  return (
    <div>
      <PageHeader
        title="Modules & Features"
        sub="Switching a module off removes its API routes and screens for everyone in this company, whatever their role."
        actions={<button className="btn secondary sm" onClick={() => reload()}>Refresh</button>}
      />

      <Tabs
        tabs={[
          { key: 'modules', label: 'Modules' },
          { key: 'menus', label: 'Menu' },
          { key: 'widgets', label: 'Dashboard widgets' },
        ]}
        active={tab}
        onChange={setTab}
      />

      {tab === 'modules' && (
        loading && !data ? <p style={{ color: 'var(--muted)' }}>Loading…</p> : (
          <>
            {Object.entries(byCategory).map(([category, mods]) => (
              <div className="card mb" key={category}>
                <div className="card-h">
                  <h3 style={{ textTransform: 'capitalize' }}>{category}</h3>
                  <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>
                    {mods.filter((m) => m.enabled).length} on / {mods.length}
                  </span>
                </div>
                <div className="table-wrap">
                  <table className="tbl">
                    <thead><tr><th>Module</th><th>Description</th><th>State</th><th>Updated</th><th></th></tr></thead>
                    <tbody>
                      {mods.map((m) => (
                        <tr key={m.key}>
                          <td>
                            <strong>{m.name}</strong>
                            <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{m.key}</div>
                          </td>
                          <td style={{ fontSize: 12.5, color: 'var(--muted)', maxWidth: 420 }}>
                            {m.description || '—'}
                            {!m.defaultEnabled && <div><span className="badge gray">off by default</span></div>}
                          </td>
                          <td>{m.enabled ? <span className="badge green">Enabled</span> : <span className="badge gray">Disabled</span>}</td>
                          <td style={{ fontSize: 12.5 }}>{m.updatedAt ? fmtDate(m.updatedAt, true) : '—'}</td>
                          <td className="actions">
                            {canManage && (
                              <>
                                <Toggle checked={m.enabled} disabled={busy === m.key} onChange={(v) => flip(m, v)} label={`Toggle ${m.name}`} />
                                {m.enabled !== m.defaultEnabled && (
                                  <button className="btn ghost sm" onClick={() => setResetting(m)}>Reset</button>
                                )}
                              </>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </>
        )
      )}

      {tab === 'menus' && <Menus canManage={canManage} onChanged={reload} />}
      {tab === 'widgets' && <Widgets canManage={canManage} onChanged={reload} />}

      {resetting && (
        <Confirm
          title="Reset module configuration?"
          message={`“${resetting.name}” returns to the product default (${resetting.defaultEnabled ? 'enabled' : 'disabled'}) and loses any settings.`}
          onYes={doReset}
          onClose={() => setResetting(null)}
        />
      )}
    </div>
  );
}

/** Navigation entries and the permission each one needs. */
function Menus({ canManage, onChanged }) {
  const toast = useToast();
  const { data, loading, reload } = useLoader(listLoader('/administration/menus'), []);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({});

  const open = (row) => { setEditing(row); setForm({ ...row }); };
  const save = async () => {
    try {
      await api.put(`/administration/menus/${editing.id}`, {
        label: form.label, route: form.route, sort_order: Number(form.sort_order) || 0,
        required_permission: form.required_permission || null, visible: !!form.visible,
      });
      toast('Menu item updated');
      setEditing(null);
      reload();
      onChanged?.();
    } catch (e) { toast(errMsg(e), true); }
  };

  return (
    <>
      <DataTable
        rows={data}
        loading={loading}
        columns={[
          { key: 'sort_order', label: 'Order', align: 'right', sortValue: (r) => Number(r.sort_order || 0) },
          { key: 'label', label: 'Label' },
          { key: 'route', label: 'Route', render: (r) => (r.route ? <code style={{ fontSize: 12 }}>{r.route}</code> : '—') },
          { key: 'required_permission', label: 'Needs permission', render: (r) => (r.required_permission ? <code style={{ fontSize: 11.5 }}>{r.required_permission}</code> : <span style={{ color: 'var(--muted)' }}>everyone</span>) },
          { key: 'accessible', label: 'For you', render: (r) => (r.accessible ? <span className="badge green">yes</span> : <span className="badge gray">no</span>) },
          { key: 'visible', label: 'Visible', render: (r) => <StatusBadge value={r.visible ? 'active' : 'inactive'} /> },
        ]}
        actions={(row) => (canManage ? <button className="btn ghost sm" onClick={() => open(row)}>Edit</button> : null)}
      />

      {editing && (
        <Modal title={`Edit “${editing.label}”`} onClose={() => setEditing(null)}
          footer={<><button className="btn secondary" onClick={() => setEditing(null)}>Cancel</button><button className="btn" onClick={save}>Save</button></>}>
          <div className="form-grid">
            <TextField label="Label" value={form.label || ''} onChange={(v) => setForm((f) => ({ ...f, label: v }))} />
            <TextField label="Route" value={form.route || ''} onChange={(v) => setForm((f) => ({ ...f, route: v }))} />
            <TextField label="Sort order" type="number" value={form.sort_order ?? 0} onChange={(v) => setForm((f) => ({ ...f, sort_order: v }))} />
            <TextField label="Required permission" value={form.required_permission || ''} onChange={(v) => setForm((f) => ({ ...f, required_permission: v }))} hint="blank = visible to everyone" />
            <label className="check"><input type="checkbox" checked={!!form.visible} onChange={(e) => setForm((f) => ({ ...f, visible: e.target.checked }))} />Visible</label>
          </div>
        </Modal>
      )}
    </>
  );
}

function Widgets({ canManage, onChanged }) {
  const toast = useToast();
  const { data, loading, reload } = useLoader(listLoader('/administration/dashboard-widgets'), []);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({});

  const open = (row) => { setEditing(row); setForm({ ...row }); };
  const save = async () => {
    try {
      await api.put(`/administration/dashboard-widgets/${editing.id}`, {
        title: form.title, sort_order: Number(form.sort_order) || 0,
        visible: !!form.visible, required_permission: form.required_permission || null,
      });
      toast('Widget updated');
      setEditing(null);
      reload();
      onChanged?.();
    } catch (e) { toast(errMsg(e), true); }
  };

  return (
    <>
      <DataTable
        rows={data}
        loading={loading}
        columns={[
          { key: 'sort_order', label: 'Order', align: 'right', sortValue: (r) => Number(r.sort_order || 0) },
          { key: 'title', label: 'Widget' },
          { key: 'widget_key', label: 'Key', render: (r) => <code style={{ fontSize: 12 }}>{r.widget_key || r.key}</code> },
          { key: 'required_permission', label: 'Needs permission', render: (r) => (r.required_permission ? <code style={{ fontSize: 11.5 }}>{r.required_permission}</code> : <span style={{ color: 'var(--muted)' }}>everyone</span>) },
          { key: 'accessible', label: 'For you', render: (r) => (r.accessible ? <span className="badge green">yes</span> : <span className="badge gray">no</span>) },
          { key: 'visible', label: 'Visible', render: (r) => <StatusBadge value={r.visible ? 'active' : 'inactive'} /> },
        ]}
        actions={(row) => (canManage ? <button className="btn ghost sm" onClick={() => open(row)}>Edit</button> : null)}
      />

      {editing && (
        <Modal title={`Edit “${editing.title}”`} onClose={() => setEditing(null)}
          footer={<><button className="btn secondary" onClick={() => setEditing(null)}>Cancel</button><button className="btn" onClick={save}>Save</button></>}>
          <div className="form-grid">
            <TextField label="Title" value={form.title || ''} onChange={(v) => setForm((f) => ({ ...f, title: v }))} />
            <TextField label="Sort order" type="number" value={form.sort_order ?? 0} onChange={(v) => setForm((f) => ({ ...f, sort_order: v }))} />
            <TextField label="Required permission" value={form.required_permission || ''} onChange={(v) => setForm((f) => ({ ...f, required_permission: v }))} />
            <label className="check"><input type="checkbox" checked={!!form.visible} onChange={(e) => setForm((f) => ({ ...f, visible: e.target.checked }))} />Visible</label>
          </div>
        </Modal>
      )}
    </>
  );
}