import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, errMsg } from '../../api';
import { Empty, Modal, Spinner, TextAreaField, TextField, useToast } from '../../components/ui';
import { PageHeader, PlatformSection, useLoader, usePlatform } from './shared';

export default function PlatformRoles() {
  return (
    <PlatformSection perm="platform.users.view">
      <Roles />
    </PlatformSection>
  );
}

function Roles() {
  const { can } = usePlatform();
  const manage = can('platform.users.manage');
  const [editor, setEditor] = useState(null); // { role|null }
  const [removing, setRemoving] = useState(null);
  const { data, raw, loading, reload } = useLoader(async () => (await api.get('/platform/roles')).data, []);
  const [q, setQ] = useState('');
  const roles = data || [];
  const perms = raw?.permissions || [];

  const groups = useMemo(() => {
    const g = {};
    perms.filter((p) => p.includes(q.trim().toLowerCase())).forEach((p) => {
      const area = p.split('.')[1] || 'other';
      (g[area] = g[area] || []).push(p);
    });
    return g;
  }, [perms, q]);

  if (loading) return <Spinner />;

  return (
    <div>
      <PageHeader
        title="Roles & permissions"
        sub="What each ARTHVEX platform role can do. Assign a role to staff on the Operators page; company roles are managed per company."
        actions={<>
          <Link className="btn secondary" to="/platform/operators">Manage operators</Link>
          {manage && <button className="btn" onClick={() => setEditor({ role: null })}>Create role</button>}
        </>}
      />

      <div className="grid c3 mb">
        {roles.map((r) => (
          <div className="card" key={r.key}>
            <div className="card-b">
              <div className="spread"><strong>{r.label}</strong><span className="badge purple">{r.operators} active</span></div>
              <div style={{ marginTop: 4 }}>{r.isSystem ? <span className="badge gray">Built-in</span> : <span className="badge blue">Custom</span>}</div>
              <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 6 }}>{r.permissions.length} of {perms.length} permissions</div>
              <div style={{ height: 6, borderRadius: 3, background: '#eceefa', marginTop: 8 }}>
                <div style={{ width: `${perms.length ? (r.permissions.length / perms.length) * 100 : 0}%`, height: '100%', borderRadius: 3, background: 'linear-gradient(90deg,#4f46e5,#7c3aed)' }} />
              </div>
              {manage && !r.isSystem && (
                <div className="row" style={{ marginTop: 12 }}>
                  <button className="btn secondary sm" onClick={() => setEditor({ role: r })}>Edit</button>
                  <button className="btn ghost sm" onClick={() => setRemoving(r)}>Delete</button>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
      {editor && <RoleEditor role={editor.role} perms={perms} onClose={() => setEditor(null)} onDone={() => { setEditor(null); reload(); }} />}
      {removing && <RoleRemover role={removing} onClose={() => setRemoving(null)} onDone={() => { setRemoving(null); reload(); }} />}

      <div className="card">
        <div className="card-h">
          <h3>Permission matrix</h3>
          <input placeholder="Filter permissions…" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 240 }} />
        </div>
        <div className="table-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Permission</th>
                {roles.map((r) => <th key={r.key} style={{ textAlign: 'center' }}>{r.label.replace('Platform ', '')}</th>)}
              </tr>
            </thead>
            <tbody>
              {Object.entries(groups).map(([area, list]) => (
                <React.Fragment key={area}>
                  <tr><td colSpan={roles.length + 1} style={{ background: '#f8f8fd', fontWeight: 700, fontSize: 11.5, textTransform: 'uppercase', letterSpacing: '.05em' }}>{area}</td></tr>
                  {list.map((p) => (
                    <tr key={p}>
                      <td><code style={{ fontSize: 12 }}>{p}</code></td>
                      {roles.map((r) => (
                        <td key={r.key} style={{ textAlign: 'center' }}>
                          {r.permissions.includes(p) ? <span className="badge green">✓</span> : <span style={{ color: '#c5cad8' }}>—</span>}
                        </td>
                      ))}
                    </tr>
                  ))}
                </React.Fragment>
              ))}
              {!Object.keys(groups).length && <tr><td colSpan={roles.length + 1}><Empty text="No permissions match" /></td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function RoleEditor({ role, perms, onClose, onDone }) {
  const toast = useToast();
  const [label, setLabel] = useState(role?.label || '');
  const [description, setDescription] = useState(role?.description || '');
  const [picked, setPicked] = useState(new Set(role?.permissions || []));
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const groups = useMemo(() => {
    const g = {};
    perms.forEach((p) => { const a = p.split('.')[1] || 'other'; (g[a] = g[a] || []).push(p); });
    return g;
  }, [perms]);
  const flip = (p) => setPicked((s) => { const n = new Set(s); n.has(p) ? n.delete(p) : n.add(p); return n; });
  const flipGroup = (list) => setPicked((s) => {
    const n = new Set(s); const all = list.every((p) => n.has(p));
    list.forEach((p) => (all ? n.delete(p) : n.add(p))); return n;
  });

  const save = async () => {
    setBusy(true); setError('');
    try {
      const body = { label, description, permissions: [...picked], reason };
      if (role) await api.put(`/platform/roles/${role.key}`, body);
      else await api.post('/platform/roles', body);
      toast(role ? 'Role updated' : 'Role created');
      onDone();
    } catch (e) { setError(errMsg(e)); }
    setBusy(false);
  };

  return (
    <Modal title={role ? `Edit ${role.label}` : 'Create platform role'} onClose={onClose} wide
      footer={<><span className="hint" style={{ marginRight: 'auto' }}>{picked.size} permission(s) selected</span>
        <button className="btn secondary" onClick={onClose}>Cancel</button>
        <button className="btn" onClick={save} disabled={busy || label.trim().length < 3 || !picked.size || reason.trim().length < 5}>
          {busy ? 'Saving…' : role ? 'Save role' : 'Create role'}
        </button></>}>
      <div className="form-grid">
        <TextField label="Role name *" value={label} onChange={setLabel} placeholder="e.g. Finance reviewer" />
        <TextField label="Description" value={description} onChange={setDescription} />
      </div>
      <h4 style={{ margin: '14px 0 8px', fontSize: 13 }}>Permissions</h4>
      <p className="hint" style={{ marginTop: 0 }}>You can only grant permissions you hold yourself.</p>
      <div className="perm-groups">
        {Object.entries(groups).map(([area, list]) => (
          <div className="perm-group" key={area}>
            <label className="perm-head">
              <input type="checkbox" checked={list.every((p) => picked.has(p))} onChange={() => flipGroup(list)} />
              <strong>{area}</strong>
            </label>
            {list.map((p) => (
              <label className="check" key={p} style={{ fontSize: 12.5 }}>
                <input type="checkbox" checked={picked.has(p)} onChange={() => flip(p)} />
                <code>{p.replace(/^platform\./, '')}</code>
              </label>
            ))}
          </div>
        ))}
      </div>
      <TextAreaField label="Reason *" value={reason} onChange={setReason} hint="Recorded in the platform audit." />
      {error && <div className="error-box mt">{error}</div>}
    </Modal>
  );
}

function RoleRemover({ role, onClose, onDone }) {
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const go = async () => {
    setBusy(true); setError('');
    try {
      await api.delete(`/platform/roles/${role.key}`, { data: { reason } });
      toast('Role deleted');
      onDone();
    } catch (e) { setError(errMsg(e)); }
    setBusy(false);
  };
  return (
    <Modal title={`Delete ${role.label}?`} onClose={onClose}
      footer={<><button className="btn secondary" onClick={onClose}>Cancel</button>
        <button className="btn danger" onClick={go} disabled={busy || reason.trim().length < 5}>Delete role</button></>}>
      <p style={{ fontSize: 13.5 }}>Operators who hold this role must be reassigned first; the server refuses otherwise.</p>
      <TextAreaField label="Reason *" value={reason} onChange={setReason} />
      {error && <div className="error-box mt">{error}</div>}
    </Modal>
  );
}
