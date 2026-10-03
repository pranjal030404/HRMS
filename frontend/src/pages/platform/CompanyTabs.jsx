import React, { useCallback, useEffect, useState } from 'react';
import { api, errMsg, fmtDate } from '../../api';
import {
  Empty, Modal, Spinner, TextAreaField, TextField, useToast,
} from '../../components/ui';
import { SessionBadge, usePlatform } from './shared';
import { SupportAccessRequired } from './GrantSupport';

/**
 * The per-company tabs. Every one reads under a Support Access session: when there
 * is none the server answers 403 + `requiresSupportAccess`, and the tab turns that
 * into the one-click "take support access" panel instead of an error.
 */
function useTab(tenant, path, params) {
  const [state, setState] = useState({ loading: true, data: null, meta: null, error: '', blocked: '' });
  const key = JSON.stringify(params || {});
  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: '', blocked: '' }));
    try {
      const { data } = await api.get(`/platform/tenants/${tenant.id}/${path}`, { params });
      setState({ loading: false, data: data.data, meta: data.meta || null, error: '', blocked: '' });
    } catch (e) {
      const d = e?.response?.data;
      if (e?.response?.status === 403 && d?.details?.requiresSupportAccess) {
        setState({ loading: false, data: null, meta: null, error: '', blocked: d.message || 'Support access is required.' });
      } else {
        setState({ loading: false, data: null, meta: null, error: errMsg(e), blocked: '' });
      }
    }
  }, [tenant.id, path, key]); // eslint-disable-line
  useEffect(() => { load(); }, [load]);
  return { ...state, reload: load };
}

function Gate({ tenant, tab, children }) {
  if (tab.loading) return <Spinner />;
  if (tab.blocked) return <SupportAccessRequired error={tab.blocked} tenantId={tenant.id} tenantName={tenant.name} onGranted={tab.reload} />;
  if (tab.error) return <div className="error-box">{tab.error}</div>;
  return children;
}

/** A write needs a reason; this is the one modal every tab uses to collect it. */
function ReasonModal({ title, children, confirm = 'Apply', danger, onClose, onSubmit, disabled }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const go = async () => {
    setBusy(true); setError('');
    try { await onSubmit(reason); onClose(); } catch (e) { setError(errMsg(e)); }
    setBusy(false);
  };
  return (
    <Modal title={title} onClose={onClose}
      footer={<><button className="btn secondary" onClick={onClose}>Cancel</button>
        <button className={'btn' + (danger ? ' danger' : '')} onClick={go} disabled={busy || disabled || reason.trim().length < 5}>{confirm}</button></>}>
      {children}
      <TextAreaField label="Reason *" value={reason} onChange={setReason} hint="At least 5 characters — recorded in the platform audit trail" />
      {error && <div className="error-box mt">{error}</div>}
    </Modal>
  );
}

const Table = ({ head, rows, empty }) => (
  rows.length ? (
    <div className="table-wrap">
      <table className="tbl">
        <thead><tr>{head.map((h) => <th key={h}>{h}</th>)}</tr></thead>
        <tbody>{rows}</tbody>
      </table>
    </div>
  ) : <Empty text={empty} />
);

// ------------------------------------------------------------------- users
export function UsersTab({ tenant }) {
  const tab = useTab(tenant, 'users');
  return (
    <Gate tenant={tenant} tab={tab}>
      <div className="card">
        <div className="card-h"><h3>Login identities</h3><span className="hint">Users are logins; employees are people. An employee may or may not have one.</span></div>
        <Table empty="No users" head={['Name', 'Email', 'Role', 'Status', 'MFA', 'Last sign-in']}
          rows={(tab.data || []).map((u) => (
            <tr key={u.id}>
              <td>{u.name}</td><td>{u.email}</td>
              <td><span className="badge purple">{String(u.role).replace(/_/g, ' ')}</span></td>
              <td><span className={'badge ' + (u.status === 'active' ? 'green' : 'gray')}>{u.status}</span></td>
              <td>{u.mfa_enabled ? <span className="badge green">On</span> : <span className="badge gray">Off</span>}</td>
              <td style={{ fontSize: 12 }}>{u.last_login_at ? fmtDate(u.last_login_at, true) : 'never'}</td>
            </tr>
          ))} />
      </div>
    </Gate>
  );
}

// ------------------------------------------------------------------- roles
export function RolesTab({ tenant }) {
  const tab = useTab(tenant, 'roles');
  const { can } = usePlatform();
  const [open, setOpen] = useState(null);
  const [editor, setEditor] = useState(null); // { role|null }
  const [removing, setRemoving] = useState(null);
  const manage = can('platform.tenants.manage');
  return (
    <Gate tenant={tenant} tab={tab}>
      <div className="card">
        <div className="card-h">
          <h3>Roles</h3><span className="hint">Company roles, not platform roles.</span>
          {manage && <button className="btn sm" style={{ marginLeft: 'auto' }} onClick={() => setEditor({ role: null })}>Create role</button>}
        </div>
        <Table empty="No roles" head={['Role', 'Type', 'Users', 'Permissions', '']}
          rows={(tab.data || []).map((r) => (
            <tr key={r.id}>
              <td><strong>{r.label || r.name}</strong><div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{r.name}</div></td>
              <td>{r.is_system ? <span className="badge blue">System</span> : <span className="badge gray">Custom</span>}</td>
              <td className="num">{r.users}</td>
              <td className="num">{(r.permissions || []).length}</td>
              <td className="actions">
                <button className="btn ghost sm" onClick={() => setOpen(r)}>View</button>
                {manage && !r.is_system && <button className="btn ghost sm" onClick={() => setEditor({ role: r })}>Edit</button>}
                {manage && !r.is_system && <button className="btn ghost sm" onClick={() => setRemoving(r)}>Delete</button>}
              </td>
            </tr>
          ))} />
      </div>
      {open && (
        <Modal title={open.label || open.name} onClose={() => setOpen(null)} wide
          footer={<button className="btn secondary" onClick={() => setOpen(null)}>Close</button>}>
          <div className="row wrap" style={{ gap: 6 }}>
            {(open.permissions || []).map((p) => <code key={p} style={{ fontSize: 11.5 }}>{p}</code>)}
          </div>
        </Modal>
      )}
      {editor && <CompanyRoleEditor tenant={tenant} role={editor.role} onClose={() => setEditor(null)} onDone={() => { setEditor(null); tab.reload(); }} />}
      {removing && (
        <ReasonModal title={`Delete ${removing.label || removing.name}?`} confirm="Delete role" danger onClose={() => setRemoving(null)}
          onSubmit={async () => {
            await api.delete(`/administration/roles/${removing.id}`, { params: { tenant_id: tenant.id } });
            tab.reload();
          }}>
          <p style={{ fontSize: 13.5 }}>Users who hold this role must be reassigned first; the server refuses otherwise. This is done inside your support-access session and is audited.</p>
        </ReasonModal>
      )}
    </Gate>
  );
}

/** Create or edit a company's custom role via the same endpoints the company's own admin uses. */
function CompanyRoleEditor({ tenant, role, onClose, onDone }) {
  const toast = useToast();
  const [catalog, setCatalog] = useState(null);
  const [label, setLabel] = useState(role?.label || '');
  const [description, setDescription] = useState(role?.description || '');
  const [picked, setPicked] = useState(new Set(role?.permissions || []));
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/administration/permissions/catalog', { params: { tenant_id: tenant.id } })
      .then(({ data }) => setCatalog(data.data))
      .catch((e) => setError(errMsg(e)));
  }, [tenant.id]);

  const groups = (catalog || [])
    .filter((p) => !q.trim() || p.key.toLowerCase().includes(q.trim().toLowerCase()) || (p.label || '').toLowerCase().includes(q.trim().toLowerCase()))
    .reduce((g, p) => { (g[p.module || 'other'] = g[p.module || 'other'] || []).push(p); return g; }, {});
  const flip = (k) => setPicked((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; });

  const save = async () => {
    setBusy(true); setError('');
    try {
      if (role) {
        await api.put(`/administration/roles/${role.id}`, { tenant_id: tenant.id, label, description, permissions: [...picked] });
      } else {
        await api.post('/administration/roles', { tenant_id: tenant.id, name: label, label, description, permissions: [...picked] });
      }
      toast(role ? 'Role updated' : 'Role created');
      onDone();
    } catch (e) { setError(errMsg(e)); }
    setBusy(false);
  };

  return (
    <Modal title={role ? `Edit ${role.label || role.name}` : `New role for ${tenant.name}`} onClose={onClose} wide
      footer={<><span className="hint" style={{ marginRight: 'auto' }}>{picked.size} permission(s)</span>
        <button className="btn secondary" onClick={onClose}>Cancel</button>
        <button className="btn" onClick={save} disabled={busy || label.trim().length < 2 || !picked.size}>{busy ? 'Saving…' : 'Save role'}</button></>}>
      <div className="form-grid">
        <TextField label="Role name *" value={label} onChange={setLabel} />
        <TextField label="Description" value={description} onChange={setDescription} />
      </div>
      <TextField label="Filter permissions" value={q} onChange={setQ} />
      {!catalog && !error && <div className="skel" style={{ height: 120, marginTop: 10 }} />}
      <div className="perm-groups mt">
        {Object.entries(groups).map(([mod, list]) => (
          <div className="perm-group" key={mod}>
            <label className="perm-head">
              <input type="checkbox" checked={list.every((p) => picked.has(p.key))}
                onChange={() => setPicked((s) => { const n = new Set(s); const all = list.every((p) => n.has(p.key)); list.forEach((p) => (all ? n.delete(p.key) : n.add(p.key))); return n; })} />
              <strong>{mod.replace(/_/g, ' ')}</strong>
            </label>
            {list.map((p) => (
              <label className="check" key={p.key} style={{ fontSize: 12.5 }} title={p.label}>
                <input type="checkbox" checked={picked.has(p.key)} onChange={() => flip(p.key)} /> <code>{p.key}</code>
              </label>
            ))}
          </div>
        ))}
      </div>
      <p className="hint">Saved inside your support-access session and recorded in both the platform and the company audit trail.</p>
      {error && <div className="error-box mt">{error}</div>}
    </Modal>
  );
}

// ---------------------------------------------------------------- security
export function SecurityTab({ tenant }) {
  const tab = useTab(tenant, 'security');
  const d = tab.data;
  return (
    <Gate tenant={tenant} tab={tab}>
      {d && (
        <div className="grid c2">
          <div className="card">
            <div className="card-h"><h3>Company security</h3></div>
            <div className="card-b">
              <p>MFA enrolled: <strong>{d.mfa.enrolled}</strong> of <strong>{d.mfa.total}</strong> active users</p>
              <h4 style={{ margin: '14px 0 6px' }}>Policies</h4>
              {d.policies.length ? d.policies.map((p) => (
                <div key={p.policy_key} className="spread" style={{ fontSize: 13, padding: '3px 0' }}>
                  <code>{p.policy_key}</code><span>{JSON.stringify(p.policy_value?.value ?? p.policy_value)}</span>
                </div>
              )) : <p className="hint">Platform defaults apply.</p>}
              <h4 style={{ margin: '14px 0 6px' }}>IP restrictions</h4>
              {d.ipRestrictions.length ? d.ipRestrictions.map((i) => (
                <div key={i.id} className="spread" style={{ fontSize: 13 }}>
                  <code>{i.cidr}</code><span>{i.scope} · {i.applies_to}{i.active ? '' : ' (off)'}</span>
                </div>
              )) : <p className="hint">None configured.</p>}
            </div>
          </div>
          <div className="card">
            <div className="card-h"><h3>Recent sign-ins</h3></div>
            <Table empty="No sign-in events" head={['When', 'Who', 'Event', 'IP']}
              rows={d.loginEvents.map((e, i) => (
                <tr key={i}>
                  <td style={{ fontSize: 12 }}>{fmtDate(e.created_at, true)}</td><td>{e.email}</td>
                  <td><span className={'badge ' + (e.event === 'login' || e.event === 'logout' ? 'green' : 'amber')}>{e.event.replace(/_/g, ' ')}</span></td>
                  <td style={{ fontSize: 12 }}>{e.ip}</td>
                </tr>
              ))} />
          </div>
        </div>
      )}
    </Gate>
  );
}

// ---------------------------------------------------------------- branding
export function BrandingTab({ tenant }) {
  const tab = useTab(tenant, 'branding');
  const toast = useToast();
  const { can } = usePlatform();
  const [form, setForm] = useState(null);
  const [asking, setAsking] = useState(false);
  useEffect(() => { if (tab.data) setForm({ ...tab.data.branding }); }, [tab.data]);
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));
  const canEdit = can('platform.tenants.manage');
  const FIELDS = [
    ['companyName', 'Company name'], ['logoUrl', 'Logo URL (https://…)'], ['primaryColor', 'Primary colour (#RRGGBB)'],
    ['accentColor', 'Accent colour (#RRGGBB)'], ['loginTagline', 'Login tagline'], ['supportEmail', 'Support email'],
    ['emailFromName', 'Email sender name'], ['emailFooter', 'Email footer'],
  ];
  return (
    <Gate tenant={tenant} tab={tab}>
      {form && (
        <div className="grid c2">
          <div className="card">
            <div className="card-h"><h3>Branding</h3></div>
            <div className="card-b">
              {FIELDS.map(([k, label]) => <TextField key={k} label={label} value={form[k] || ''} onChange={set(k)} />)}
              {canEdit && <button className="btn" onClick={() => setAsking(true)}>Save branding…</button>}
              {!canEdit && <p className="hint">Your role can view branding but not change it.</p>}
            </div>
          </div>
          <div className="card">
            <div className="card-h"><h3>Preview</h3></div>
            <div className="card-b">
              <div style={{ border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
                <div style={{ background: /^#[0-9a-fA-F]{6}$/.test(form.primaryColor || '') ? form.primaryColor : '#1d4ed8', color: '#fff', padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 10 }}>
                  {form.logoUrl ? <img src={form.logoUrl} alt="" style={{ height: 28 }} /> : <b>◼</b>}
                  <b>{form.companyName || tenant.name}</b>
                </div>
                <div style={{ padding: 16, fontSize: 13 }}>{form.loginTagline || 'Sign in to your workspace'}</div>
              </div>
            </div>
          </div>
        </div>
      )}
      {asking && (
        <ReasonModal title="Save branding" confirm="Save" onClose={() => setAsking(false)}
          onSubmit={async (reason) => {
            const { data } = await api.put(`/platform/tenants/${tenant.id}/branding`, { branding: form, reason });
            toast(`Saved as configuration version ${data.data.configVersion}`);
            tab.reload();
          }}>
          <div className="info-box mb">Writing requires a Support Access session of type <b>configuration</b> or <b>tenant administration</b>.</div>
        </ReasonModal>
      )}
    </Gate>
  );
}

// ----------------------------------------------------------------- domains
export function DomainsTab({ tenant }) {
  const tab = useTab(tenant, 'domains');
  const toast = useToast();
  const { can } = usePlatform();
  const [host, setHost] = useState('');
  const [modal, setModal] = useState(null);
  const canEdit = can('platform.tenants.manage');

  const verify = async (d) => {
    try {
      await api.post(`/platform/tenants/${tenant.id}/domains/${d.id}/verify`, {});
      toast('Domain verified'); tab.reload();
    } catch (e) { toast(errMsg(e), true); }
  };
  return (
    <Gate tenant={tenant} tab={tab}>
      <div className="card">
        <div className="card-h"><h3>Domains</h3><span className="hint">A hostname is proven by a DNS TXT record before it can be primary.</span></div>
        {canEdit && (
          <div className="card-b row wrap" style={{ alignItems: 'flex-end' }}>
            <div style={{ minWidth: 280 }}><TextField label="Add hostname" value={host} onChange={setHost} placeholder="hr.example.com" /></div>
            <button className="btn" disabled={!host} onClick={() => setModal({ type: 'add' })}>Add…</button>
          </div>
        )}
        <Table empty="No domains" head={['Hostname', 'Status', 'Verification', '']}
          rows={(tab.data || []).map((d) => (
            <tr key={d.id}>
              <td><strong>{d.hostname}</strong> {d.is_primary ? <span className="badge blue">Primary</span> : null}</td>
              <td>{d.verified ? <span className="badge green">Verified</span> : <span className="badge amber">Unverified</span>}
                {d.verified && <span className="badge gray" style={{ marginLeft: 4 }}>SSL {d.ssl_status}</span>}</td>
              <td style={{ fontSize: 12 }}>
                {d.txtRecord ? <>Add TXT <code>{d.txtRecord.name}</code> = <code>{d.txtRecord.value}</code></> : '—'}
              </td>
              <td className="actions">
                {canEdit && !d.verified && <button className="btn ghost sm" onClick={() => verify(d)}>Verify DNS</button>}
                {canEdit && d.verified && !d.is_primary && <button className="btn ghost sm" onClick={() => setModal({ type: 'primary', d })}>Make primary</button>}
                {canEdit && <button className="btn ghost sm" onClick={() => setModal({ type: 'remove', d })}>Remove</button>}
              </td>
            </tr>
          ))} />
      </div>
      {modal?.type === 'add' && (
        <ReasonModal title={`Add ${host}`} onClose={() => setModal(null)}
          onSubmit={async (reason) => { await api.post(`/platform/tenants/${tenant.id}/domains`, { hostname: host, reason }); setHost(''); tab.reload(); }} />
      )}
      {modal?.type === 'primary' && (
        <ReasonModal title={`Make ${modal.d.hostname} primary`} onClose={() => setModal(null)}
          onSubmit={async (reason) => { await api.post(`/platform/tenants/${tenant.id}/domains/${modal.d.id}/primary`, { reason }); tab.reload(); }} />
      )}
      {modal?.type === 'remove' && (
        <ReasonModal title={`Remove ${modal.d.hostname}`} danger confirm="Remove" onClose={() => setModal(null)}
          onSubmit={async (reason) => { await api.delete(`/platform/tenants/${tenant.id}/domains/${modal.d.id}`, { data: { reason } }); tab.reload(); }} />
      )}
    </Gate>
  );
}

// ------------------------------------------------------------ integrations
export function IntegrationsTab({ tenant }) {
  const tab = useTab(tenant, 'integrations');
  const { can } = usePlatform();
  const [modal, setModal] = useState(null);
  const canEdit = can('platform.integrations.manage');
  const d = tab.data;
  return (
    <Gate tenant={tenant} tab={tab}>
      {d && (
        <>
          <div className="card mb">
            <div className="card-h"><h3>API keys</h3><span className="hint">Key material is never shown — only the prefix.</span></div>
            <Table empty="No API keys" head={['Name', 'Prefix', 'Scopes', 'Last used', 'State', '']}
              rows={d.apiKeys.map((k) => (
                <tr key={k.id}>
                  <td>{k.name}</td><td><code>{k.key_prefix}…</code></td>
                  <td style={{ fontSize: 12 }}>{(k.scopes || []).join(', ') || '—'}</td>
                  <td style={{ fontSize: 12 }}>{k.last_used_at ? fmtDate(k.last_used_at, true) : 'never'}</td>
                  <td>{k.revoked_at ? <span className="badge gray">Revoked</span> : <span className="badge green">Active</span>}</td>
                  <td className="actions">{canEdit && !k.revoked_at && <button className="btn ghost sm" onClick={() => setModal({ type: 'key', k })}>Revoke</button>}</td>
                </tr>
              ))} />
          </div>
          <div className="card mb">
            <div className="card-h"><h3>Webhooks</h3></div>
            <Table empty="No webhooks" head={['URL', 'Events', 'Failures (7d)', 'State', '']}
              rows={d.webhooks.map((h) => (
                <tr key={h.id}>
                  <td style={{ fontSize: 12.5 }}>{h.url}</td><td style={{ fontSize: 12 }}>{(h.events || []).join(', ')}</td>
                  <td className="num" style={{ color: h.recent_failures > 0 ? '#b42318' : undefined }}>{h.recent_failures}</td>
                  <td>{h.active ? <span className="badge green">Active</span> : <span className="badge gray">Disabled</span>}</td>
                  <td className="actions">{canEdit && h.active && <button className="btn ghost sm" onClick={() => setModal({ type: 'hook', h })}>Disable</button>}</td>
                </tr>
              ))} />
          </div>
          <div className="card">
            <div className="card-h"><h3>Connectors</h3></div>
            <Table empty="No connectors" head={['Name', 'Type', 'State', 'Last sync', 'Last error']}
              rows={d.connections.map((c) => (
                <tr key={c.id}>
                  <td>{c.name}</td><td>{c.itype}</td>
                  <td><span className={'badge ' + (c.status === 'connected' ? 'green' : c.status === 'error' ? 'red' : 'gray')}>{c.status}</span></td>
                  <td style={{ fontSize: 12 }}>{c.last_sync_at ? fmtDate(c.last_sync_at, true) : '—'}</td>
                  <td style={{ fontSize: 12, color: '#b42318' }}>{c.last_error || ''}</td>
                </tr>
              ))} />
          </div>
        </>
      )}
      {modal?.type === 'key' && (
        <ReasonModal title={`Revoke key “${modal.k.name}”`} danger confirm="Revoke" onClose={() => setModal(null)}
          onSubmit={async (reason) => { await api.post(`/platform/tenants/${tenant.id}/integrations/api-keys/${modal.k.id}/revoke`, { reason }); tab.reload(); }}>
          <div className="info-box mb">Anything using this key stops working immediately.</div>
        </ReasonModal>
      )}
      {modal?.type === 'hook' && (
        <ReasonModal title="Disable webhook" danger confirm="Disable" onClose={() => setModal(null)}
          onSubmit={async (reason) => { await api.post(`/platform/tenants/${tenant.id}/integrations/webhooks/${modal.h.id}/disable`, { reason }); tab.reload(); }} />
      )}
    </Gate>
  );
}

// ------------------------------------------------------------------- audit
export function AuditTab({ tenant }) {
  const [source, setSource] = useState('platform');
  const [page, setPage] = useState(1);
  const tab = useTab(tenant, 'audit', { source, page, limit: 25 });
  const rows = tab.data || [];
  const pages = tab.meta ? Math.ceil(tab.meta.total / tab.meta.limit) : 1;
  return (
    <Gate tenant={tenant} tab={tab}>
      <div className="card">
        <div className="card-h">
          <h3>Audit trail</h3>
          <div className="row">
            <button className={'btn sm ' + (source === 'platform' ? '' : 'secondary')} onClick={() => { setSource('platform'); setPage(1); }}>What ARTHVEX did</button>
            <button className={'btn sm ' + (source === 'tenant' ? '' : 'secondary')} onClick={() => { setSource('tenant'); setPage(1); }}>What the company did</button>
          </div>
        </div>
        <Table empty="No entries" head={['When', 'Actor', 'Action', 'Detail']}
          rows={rows.map((r) => (
            <tr key={r.id}>
              <td style={{ fontSize: 12 }}>{fmtDate(r.created_at, true)}</td>
              <td>{r.actor_name || '—'}<div style={{ fontSize: 11, color: 'var(--muted)' }}>{r.actor_role}</div></td>
              <td><code>{r.action}</code></td>
              <td style={{ fontSize: 12 }}>{r.reason || [r.entity_type, r.entity_id].filter(Boolean).join(' ')}</td>
            </tr>
          ))} />
        {pages > 1 && (
          <div className="spread" style={{ padding: '10px 14px' }}>
            <span className="hint">Page {page} of {pages}</span>
            <div className="row">
              <button className="btn sm secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>Prev</button>
              <button className="btn sm secondary" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</button>
            </div>
          </div>
        )}
      </div>
    </Gate>
  );
}

// ----------------------------------------------------------------- support
export function SupportTab({ tenant }) {
  const tab = useTab(tenant, 'support-access');
  return (
    <Gate tenant={tenant} tab={tab}>
      <div className="card">
        <div className="card-h"><h3>Support sessions for this company</h3></div>
        <Table empty="No support sessions" head={['Opened', 'By', 'Type', 'Reason', 'Expires', 'State']}
          rows={(tab.data || []).map((s) => (
            <tr key={s.id}>
              <td style={{ fontSize: 12 }}>{fmtDate(s.created_at, true)}</td><td>{s.granted_by_name}</td>
              <td>{String(s.access_type).replace(/_/g, ' ')}</td><td style={{ fontSize: 12.5 }}>{s.reason}</td>
              <td style={{ fontSize: 12 }}>{fmtDate(s.expires_at, true)}</td>
              <td><SessionBadge status={s.status} /></td>
            </tr>
          ))} />
      </div>
    </Gate>
  );
}

// ----------------------------------------------------------- configuration
export function ConfigurationTab({ tenant }) {
  const tab = useTab(tenant, 'configuration');
  const { can } = usePlatform();
  const [view, setView] = useState(null);
  const [rollback, setRollback] = useState(null);
  const toast = useToast();
  const canRoll = can('platform.config.manage');

  const open = async (v) => {
    try {
      const { data } = await api.get(`/platform/tenants/${tenant.id}/configuration/${v.id}`);
      setView(data.data);
    } catch (e) { toast(errMsg(e), true); }
  };
  const byKey = {};
  (tab.data || []).forEach((v) => { (byKey[v.config_key] = byKey[v.config_key] || []).push(v); });

  return (
    <Gate tenant={tenant} tab={tab}>
      {Object.keys(byKey).length === 0 && <Empty text="No configuration has been versioned for this company yet" />}
      {Object.entries(byKey).map(([key, versions]) => (
        <div className="card mb" key={key}>
          <div className="card-h"><h3>{key.replace(/_/g, ' ')}</h3><span className="hint">Rollback appends a new version — history is never rewritten.</span></div>
          <Table empty="" head={['Version', 'State', 'Changed', 'By', 'Note', '']}
            rows={versions.map((v) => (
              <tr key={v.id}>
                <td>v{v.version}</td>
                <td><span className={'badge ' + (v.status === 'active' ? 'green' : 'gray')}>{v.status}</span></td>
                <td style={{ fontSize: 12 }}>{fmtDate(v.created_at, true)}</td>
                <td>{v.created_by_name || '—'}</td>
                <td style={{ fontSize: 12 }}>{v.notes}</td>
                <td className="actions">
                  <button className="btn ghost sm" onClick={() => open(v)}>Diff</button>
                  {canRoll && v.status !== 'active' && <button className="btn ghost sm" onClick={() => setRollback(v)}>Roll back to this</button>}
                </td>
              </tr>
            ))} />
        </div>
      ))}
      {view && (
        <Modal title={`${view.version.config_key} v${view.version.version}${view.against ? ` vs v${view.against.version}` : ''}`} wide onClose={() => setView(null)}
          footer={<button className="btn secondary" onClick={() => setView(null)}>Close</button>}>
          {view.diff.length === 0 ? <p className="hint">No differences.</p> : (
            <Table empty="" head={['Setting', 'Before', 'After']} rows={view.diff.map((d) => (
              <tr key={d.path}>
                <td><code>{d.path}</code></td>
                <td style={{ color: '#b42318' }}>{d.from === undefined ? '—' : JSON.stringify(d.from)}</td>
                <td style={{ color: '#067647' }}>{d.to === undefined ? '—' : JSON.stringify(d.to)}</td>
              </tr>
            ))} />
          )}
        </Modal>
      )}
      {rollback && (
        <ReasonModal title={`Roll ${rollback.config_key} back to v${rollback.version}`} confirm="Roll back" onClose={() => setRollback(null)}
          onSubmit={async (reason) => {
            const { data } = await api.post(`/platform/tenants/${tenant.id}/configuration/${rollback.id}/rollback`, { reason });
            toast(`Created v${data.data.newVersion}${data.data.appliedLive ? ' and applied it live' : ''}`);
            tab.reload();
          }}>
          <div className="info-box mb">This creates a <b>new</b> version containing the old content. Needs a configuration-type support session.</div>
        </ReasonModal>
      )}
    </Gate>
  );
}
