import React, { useState } from 'react';
import { api, errMsg, fmtDate } from '../../api';
import { useAuth } from '../../auth';
import DataTable from '../../components/DataTable';
import { Confirm, Modal, Spinner, StatusBadge, TextField, useToast } from '../../components/ui';
import { AdminSection, PageHeader, listLoader, num, useLoader } from './shared';

const STATUS = [
  { value: 'active', label: 'Active' },
  { value: 'inactive', label: 'Inactive' },
  { value: 'suspended', label: 'Suspended' },
  { value: 'disabled', label: 'Disabled' },
];

export default function AdminUsers() {
  return (
    <AdminSection sectionKey="users">
      <Users />
    </AdminSection>
  );
}

function Users() {
  const { me, can } = useAuth();
  const toast = useToast();
  const [tab, setTab] = useState('users');
  const { data, loading, reload, setData } = useLoader(listLoader('/administration/users?limit=100'), []);
  const { data: assignable } = useLoader(listLoader('/administration/roles/assignable'), []);
  const { data: invitations, reload: reloadInvites } = useLoader(listLoader('/administration/invitations'), []);
  const [detail, setDetail] = useState(null);
  const [creating, setCreating] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [newPass, setNewPass] = useState(null);

  const isSelf = (row) => Number(row.id) === Number(me?.id);

  return (
    <div>
      <PageHeader
        title="Users & Access"
        sub="Logins, role assignments, direct grants, sessions and invitations."
        actions={
          <>
            {can('administration.users.invite') && <button className="btn sm" onClick={() => setInviting(true)}>Invite user</button>}
            {can('administration.users.manage') && <button className="btn sm" onClick={() => setCreating(true)}>+ Add login</button>}
          </>
        }
      />

      <Tabs
        tabs={[
          { key: 'users', label: `Logins${data ? ` (${data.length})` : ''}` },
          { key: 'invitations', label: `Invitations${invitations ? ` (${invitations.filter((i) => i.status === 'pending').length} pending)` : ''}` },
          { key: 'requests', label: 'Access requests' },
        ]}
        active={tab}
        onChange={setTab}
      />

      {tab === 'users' && (
        <DataTable
          rows={data}
          loading={loading}
          onRowClick={(row) => setDetail(row.id)}
          columns={[
            { key: 'name', label: 'Name' },
            { key: 'email', label: 'Email' },
            { key: 'employee_code', label: 'Code' },
            {
              key: 'role', label: 'Roles',
              sortValue: (r) => Number(r.role_count || 0),
              render: (r) => (
                <>
                  <span className="badge blue">{(r.role || 'none').replace(/_/g, ' ')}</span>
                  {Number(r.role_count) > 1 && <span className="badge gray" style={{ marginLeft: 5 }}>+{r.role_count - 1}</span>}
                </>
              ),
            },
            { key: 'role_count', label: 'Assignments', align: 'right', render: (r) => num(r.role_count) },
            { key: 'direct_permission_count', label: 'Direct', align: 'right', render: (r) => (Number(r.direct_permission_count) ? <span className="badge purple">{r.direct_permission_count}</span> : <span style={{ color: 'var(--muted)' }}>—</span>) },
            { key: 'active_sessions', label: 'Sessions', align: 'right', render: (r) => (Number(r.active_sessions) ? num(r.active_sessions) : <span style={{ color: 'var(--muted)' }}>0</span>) },
            { key: 'last_login_at', label: 'Last login', render: (r) => (r.last_login_at ? fmtDate(r.last_login_at, true) : <span className="badge amber">never</span>) },
            { key: 'status', label: 'Status', render: (r) => <StatusBadge value={r.status} /> },
          ]}
        />
      )}

      {tab === 'invitations' && (
        <Invitations
          rows={invitations}
          canManage={can('administration.users.manage')}
          onChanged={() => { reloadInvites(); reload(true); }}
        />
      )}

      {tab === 'requests' && <AccessRequests onChanged={() => reload(true)} />}

      {detail && <UserDetail userId={detail} assignable={assignable} canManage={can('administration.users.manage')} canGrant={can('administration.users.manage')} onClose={() => setDetail(null)} onChanged={() => { reload(true); reloadInvites(); }} onPassword={(pw) => setNewPass(pw)} />}

      {creating && (
        <CreateUser
          roles={assignable}
          onClose={() => setCreating(false)}
          onDone={() => { setCreating(false); reload(); }}
        />
      )}

      {inviting && (
        <InviteUser
          roles={assignable}
          onClose={() => setInviting(false)}
          onDone={() => { setInviting(false); reloadInvites(); }}
        />
      )}

      {newPass && (
        <Modal title="Temporary password issued" onClose={() => setNewPass(null)}>
          <div className="info-box">Share this once. The user must change it at first login.</div>
          <TextField label="Temporary password" value={newPass} onChange={() => {}} />
          <div className="row"><button className="btn" onClick={() => { navigator.clipboard?.writeText(newPass); toast('Copied'); }}>Copy</button></div>
        </Modal>
      )}
    </div>
  );
}

function Invitations({ rows, canManage, onChanged }) {
  const toast = useToast();
  const revoke = async (row) => {
    try {
      await api.post(`/administration/invitations/${row.id}/revoke`);
      toast('Invitation revoked');
      onChanged();
    } catch (e) { toast(errMsg(e), true); }
  };
  return (
    <DataTable
      rows={rows}
      emptyText="No invitations"
      columns={[
        { key: 'email', label: 'Email' },
        { key: 'name', label: 'Name' },
        { key: 'role_name', label: 'Role', render: (r) => r.role_name?.replace(/_/g, ' ') || '—' },
        { key: 'employee_code', label: 'Code' },
        { key: 'invited_by_name', label: 'Invited by' },
        { key: 'expires_at', label: 'Expires', render: (r) => fmtDate(r.expires_at) },
        { key: 'status', label: 'Status', render: (r) => <StatusBadge value={r.status} /> },
      ]}
      actions={(row) => (canManage && row.status === 'pending'
        ? <button className="btn ghost sm" style={{ color: 'var(--red)' }} onClick={() => revoke(row)}>Revoke</button>
        : null)}
    />
  );
}

/** Self-service permission requests: approve creates the direct grant. */
function AccessRequests({ onChanged }) {
  const { data, loading, reload } = useLoader(listLoader('/administration/access-requests'), []);
  const toast = useToast();
  const decide = async (row, status) => {
    try {
      await api.put(`/administration/access-requests/${row.id}`, { status });
      toast(`Request ${status === 'approved' ? 'approved' : 'denied'}`);
      reload();
      onChanged?.();
    } catch (e) { toast(errMsg(e), true); }
  };
  return (
    <DataTable
      rows={data}
      loading={loading}
      emptyText="No access requests"
      columns={[
        { key: 'user_name', label: 'User' },
        { key: 'user_email', label: 'Email' },
        { key: 'pkey', label: 'Permission', render: (r) => <code style={{ fontSize: 12 }}>{r.pkey || `scope:${r.scope}`}</code> },
        { key: 'scope', label: 'Scope', render: (r) => r.scope || '—' },
        { key: 'reason', label: 'Reason' },
        { key: 'created_at', label: 'Requested', render: (r) => fmtDate(r.created_at) },
        { key: 'status', label: 'Status', render: (r) => <StatusBadge value={r.status} /> },
      ]}
      actions={(row) => (row.status === 'pending'
        ? <><button className="btn sm" onClick={() => decide(row, 'approved')}>Approve</button>
          <button className="btn ghost sm" style={{ color: 'var(--red)' }} onClick={() => decide(row, 'denied')}>Deny</button></>
        : <span style={{ fontSize: 12, color: 'var(--muted)' }}>{fmtDate(row.decided_at)}</span>)}
    />
  );
}

function CreateUser({ roles, onClose, onDone }) {
  const toast = useToast();
  const [form, setForm] = useState({ name: '', email: '', role: '', status: 'active' });
  const [created, setCreated] = useState(null);
  const setF = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async () => {
    try {
      const { data } = await api.post('/administration/users', {
        name: form.name, email: form.email, role: form.role, sendInvite: false,
      });
      // The password comes back beside `data`, not inside it. Stay mounted until
      // the user dismisses the result — onDone() closes this modal.
      setCreated({ ...data.data, tempPassword: data.tempPassword, invitation: data.invitation });
    } catch (e) { toast(errMsg(e), true); }
  };

  if (created) {
    return (
      <Modal title="Login created" onClose={onDone} footer={<button className="btn" onClick={onDone}>Done</button>}>
        <div className="info-box">The temporary password is shown once — the user must change it at first login.</div>
        <TextField label="Temporary password" value={created.tempPassword || ''} onChange={() => {}} />
      </Modal>
    );
  }
  return (
    <Modal
      title="Add login"
      onClose={onClose}
      footer={<><button className="btn secondary" onClick={onClose}>Cancel</button><button className="btn" onClick={submit} disabled={!form.name || !form.email || !form.role}>Create</button></>}
    >
      <div className="info-box">The person needs an employee record to be linked later; the login works on its own.</div>
      <div className="form-grid">
        <TextField label="Full name" value={form.name} onChange={setF('name')} />
        <TextField label="Email" type="email" value={form.email} onChange={setF('email')} />
        <SelectField label="Role" value={form.role} onChange={setF('role')} options={(roles || []).map((r) => ({ value: r.id, label: r.label || r.name }))} />
        <SelectField label="Status" value={form.status} onChange={setF('status')} options={STATUS} />
      </div>
    </Modal>
  );
}

function InviteUser({ roles, onClose, onDone }) {
  const toast = useToast();
  const [form, setForm] = useState({ email: '', name: '', role: '' });
  const [token, setToken] = useState(null);
  const setF = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async () => {
    try {
      const { data } = await api.post('/administration/invitations', { email: form.email, name: form.name, role: form.role || undefined });
      setToken(data.data.token);
    } catch (e) { toast(errMsg(e), true); }
  };

  if (token) {
    return (
      <Modal title="Invitation created" onClose={onDone} footer={<button className="btn" onClick={onDone}>Done</button>}>
        <div className="info-box">Send this accept link to the invitee. It expires in 7 days.</div>
        <TextField label="Token" value={token} onChange={() => {}} />
        <div className="row">
          <button className="btn" onClick={() => { navigator.clipboard?.writeText(`${window.location.origin}/accept-invite?token=${token}`); toast('Link copied'); }}>Copy link</button>
        </div>
      </Modal>
    );
  }
  return (
    <Modal
      title="Invite user"
      onClose={onClose}
      footer={<><button className="btn secondary" onClick={onClose}>Cancel</button><button className="btn" onClick={submit} disabled={!form.email}>Create invitation</button></>}
    >
      <div className="form-grid">
        <TextField label="Email" type="email" value={form.email} onChange={setF('email')} />
        <TextField label="Name" value={form.name} onChange={setF('name')} />
        <SelectField label="Role" value={form.role} onChange={setF('role')} options={(roles || []).map((r) => ({ value: r.id, label: r.label || r.name }))} />
      </div>
    </Modal>
  );
}

/** One user: roles, direct grants, sessions, effective access. */
function UserDetail({ userId, assignable, canManage, canGrant, onClose, onChanged, onPassword }) {
  const { me } = useAuth();
  const toast = useToast();
  const { data, loading, reload } = useLoader(
    async () => (await api.get(`/administration/users/${userId}`)).data.data,
    [userId]
  );
  const [editingRoles, setEditingRoles] = useState(false);
  const [picked, setPicked] = useState([]);
  const [primary, setPrimary] = useState('');
  const [denies, setDenies] = useState([]);
  const [editingGrants, setEditingGrants] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);

  const isSelf = Number(data?.user?.id) === Number(me?.id);
  const canEdit = canManage && !isSelf;

  const startRoles = () => {
    setPicked(data.roles.map((r) => r.role_id));
    setPrimary(data.roles.find((r) => r.is_primary)?.role_id || data.roles[0]?.role_id || '');
    setEditingRoles(true);
  };

  const saveRoles = async () => {
    try {
      await api.put(`/administration/users/${userId}/roles`, { role_ids: picked, primary_role_id: primary });
      toast('Roles updated');
      setEditingRoles(false);
      reload();
      onChanged();
    } catch (e) { toast(errMsg(e), true); }
  };

  const removeRole = async (roleId) => {
    try {
      await api.delete(`/administration/users/${userId}/roles/${roleId}`);
      toast('Role removed');
      reload();
      onChanged();
    } catch (e) { toast(errMsg(e), true); }
  };

  const startGrants = () => {
    setPicked(data.directPermissions.filter((d) => d.effect !== 'deny').map((d) => d.pkey));
    setDenies(data.deniedPermissions || []);
    setEditingGrants(true);
  };

  const saveGrants = async () => {
    try {
      await api.put(`/administration/users/${userId}/direct-permissions`, { allow: picked, deny: denies });
      toast('Direct permissions saved');
      setEditingGrants(false);
      reload();
      onChanged();
    } catch (e) { toast(errMsg(e), true); }
  };

  const resetPassword = async () => {
    try {
      const { data: d } = await api.post(`/administration/users/${userId}/reset-password`);
      onPassword(d.data?.tempPassword || d.tempPassword);
      setPasswordOpen(false);
    } catch (e) { toast(errMsg(e), true); }
  };

  const revokeSessions = async () => {
    try {
      const { data: d } = await api.post(`/administration/users/${userId}/revoke-sessions`);
      toast(`${d.data?.revoked ?? 0} session(s) revoked`);
      reload();
    } catch (e) { toast(errMsg(e), true); }
  };

  if (loading && !data) return <Modal title="User" onClose={onClose} wide><Spinner /></Modal>;
  if (!data) return null;
  const u = data.user;

  return (
    <Modal title={u.name} onClose={onClose} wide>
      <div className="row wrap mb" style={{ gap: 8 }}>
        <span className="badge blue">{(u.role || 'none').replace(/_/g, ' ')}</span>
        <StatusBadge value={u.status} />
        {u.must_change_password ? <span className="badge amber">must change password</span> : null}
        {u.locked_until && new Date(u.locked_until) > new Date() ? <span className="badge red">locked until {fmtDate(u.locked_until, true)}</span> : null}
        <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>{u.email}</span>
        {data.employee && <span className="badge gray">{data.employee.employee_code} · {data.employee.first_name} {data.employee.last_name}</span>}
      </div>

      {isSelf && <div className="info-box">This is your own login. Roles and direct grants are read-only for you by design — ask another administrator.</div>}

      <div className="tabs">
        <span className="tab active">Roles ({data.roles.length})</span>
        <span className="tab">Direct ({data.directPermissions.length})</span>
        <span className="tab">Sessions ({data.sessions.filter((s) => !s.revoked_at).length})</span>
        <span className="tab">Effective ({num(data.effectivePermissions.length)})</span>
      </div>

      <div className="mt">
        <div className="spread mb">
          <b style={{ fontSize: 13.5 }}>Role assignments</b>
          {canEdit && (
            <button className="btn ghost sm" onClick={startRoles}>Edit roles</button>
          )}
        </div>
        <div className="table-wrap">
          <table className="tbl">
            <thead><tr><th>Role</th><th>Type</th><th>Permissions</th><th>Assigned</th><th></th></tr></thead>
            <tbody>
              {data.roles.map((r) => (
                <tr key={r.assignment_id}>
                  <td>{r.label}<div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{r.name}</div></td>
                  <td>{r.is_custom ? <span className="badge purple">custom</span> : <span className="badge gray">system</span>}{r.is_primary ? <span className="badge blue" style={{ marginLeft: 5 }}>primary</span> : null}</td>
                  <td>{num(r.permission_count)}</td>
                  <td>{fmtDate(r.assigned_at)}</td>
                  <td className="actions">
                    {canEdit && (
                      <button className="btn ghost sm" style={{ color: 'var(--red)' }} onClick={() => removeRole(r.role_id)}>Remove</button>
                    )}
                  </td>
                </tr>
              ))}
              {!data.roles.length && <tr><td colSpan={5} style={{ color: 'var(--muted)' }}>No roles assigned</td></tr>}
            </tbody>
          </table>
        </div>

        <div className="spread mt mb">
          <b style={{ fontSize: 13.5 }}>Direct permission grants</b>
          {canGrant && !isSelf && <button className="btn ghost sm" onClick={startGrants}>Edit grants</button>}
        </div>
        {data.directPermissions.length ? (
          <div className="row wrap" style={{ gap: 6 }}>
            {data.directPermissions.map((d) => (
              <span key={d.id} className={'badge ' + (d.effect === 'deny' ? 'red' : 'purple')}>
                {d.effect === 'deny' ? '✕ ' : '✓ '}{d.pkey}
              </span>
            ))}
          </div>
        ) : (
          <p style={{ color: 'var(--muted)', fontSize: 13 }}>No direct grants — access comes entirely from roles.</p>
        )}

        <div className="spread mt mb">
          <b style={{ fontSize: 13.5 }}>Sessions</b>
          {canManage && !isSelf && <button className="btn ghost sm" onClick={revokeSessions}>Revoke all</button>}
        </div>
        <div className="table-wrap">
          <table className="tbl">
            <thead><tr><th>Device</th><th>IP</th><th>Started</th><th>Expires</th><th>State</th></tr></thead>
            <tbody>
              {data.sessions.slice(0, 8).map((s) => (
                <tr key={s.id}>
                  <td style={{ maxWidth: 320, fontSize: 12.5 }}>{(s.user_agent || '').slice(0, 90)}</td>
                  <td>{s.ip || '—'}</td>
                  <td>{fmtDate(s.created_at, true)}</td>
                  <td>{fmtDate(s.expires_at, true)}</td>
                  <td>{s.revoked_at ? <StatusBadge value="closed" /> : <StatusBadge value="active" />}</td>
                </tr>
              ))}
              {!data.sessions.length && <tr><td colSpan={5} style={{ color: 'var(--muted)' }}>No sessions</td></tr>}
            </tbody>
          </table>
        </div>

        <details style={{ marginTop: 14 }}>
          <summary style={{ cursor: 'pointer', fontSize: 13.5, fontWeight: 600 }}>
            Effective access ({num(data.effectivePermissions.length)} permissions)
          </summary>
          <div className="row wrap mt" style={{ gap: 5 }}>
            {data.effectivePermissions.map((p) => <span key={p} className="badge gray" style={{ fontSize: 11 }}>{p}</span>)}
          </div>
        </details>
      </div>

      {canManage && !isSelf && (
        <div className="row mt">
          <button className="btn secondary sm" onClick={() => setPasswordOpen(true)}>Reset password</button>
        </div>
      )}

      {editingRoles && (
        <Modal title="Edit role assignments" onClose={() => setEditingRoles(false)}
          footer={<><button className="btn secondary" onClick={() => setEditingRoles(false)}>Cancel</button><button className="btn" onClick={saveRoles}>Save</button></>}>
          <div className="info-box">You can only assign roles that do not exceed your own access.</div>
          <div style={{ maxHeight: 320, overflowY: 'auto' }}>
            {(assignable || []).map((r) => (
              <label key={r.id} className="check" style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                <input
                  type="checkbox"
                  checked={picked.some((p) => Number(p) === Number(r.id))}
                  onChange={(e) => setPicked((p) => (e.target.checked ? [...p, r.id] : p.filter((x) => Number(x) !== Number(r.id))))}
                />
                <span>
                  {r.label || r.name}
                  <span style={{ fontSize: 11.5, color: 'var(--muted)', marginLeft: 6 }}>
                    {num(r.permissionCount)} permissions{r.isCustom ? ' · custom' : ''}
                  </span>
                </span>
              </label>
            ))}
          </div>
          <div className="field">
            <label>Primary role</label>
            <select value={primary} onChange={(e) => setPrimary(e.target.value)}>
              {picked.map((id) => {
                const r = (assignable || []).find((x) => Number(x.id) === Number(id));
                return <option key={id} value={id}>{r?.label || r?.name || id}</option>;
              })}
            </select>
          </div>
        </Modal>
      )}

      {editingGrants && (
        <GrantModal
          userId={userId}
          allow={picked}
          deny={denies}
          onAllow={setPicked}
          onDeny={setDenies}
          onClose={() => setEditingGrants(false)}
          onSave={saveGrants}
        />
      )}

      {passwordOpen && (
        <Confirm
          title="Reset password?"
          message="A temporary password is issued and the user must change it at next login. Active sessions are not affected."
          onYes={resetPassword}
          onClose={() => setPasswordOpen(false)}
        />
      )}
    </Modal>
  );
}

/** Allow / deny exceptions on top of roles. */
function GrantModal({ userId, allow, deny, onAllow, onDeny, onClose, onSave }) {
  const { data, loading } = useLoader(
    async () => (await api.get('/administration/permissions/catalog')).data,
    []
  );
  const [q, setQ] = useState('');
  const permissions = (data?.permissions || []).filter((p) =>
    !q.trim() ? true : p.key.toLowerCase().includes(q.trim().toLowerCase())
  );

  return (
    <Modal title="Direct permission grants" onClose={onClose} wide
      footer={<><button className="btn secondary" onClick={onClose}>Cancel</button><button className="btn" onClick={onSave}>Save</button></>}>
      <div className="info-box">
        A grant can only add a permission you already hold. A deny removes one a role would otherwise give —
        revoking access never requires holding that permission yourself.
      </div>
      <div className="row mb">
        <div className="searchbox">
          <input placeholder="Filter permissions…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <span className="badge purple">{allow.length} allowed</span>
        <span className="badge red">{deny.length} denied</span>
      </div>
      {loading ? <Spinner /> : (
        <div style={{ maxHeight: 380, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 10, padding: 8 }}>
          {permissions.map((p) => {
            const isAllow = allow.includes(p.key);
            const isDeny = deny.includes(p.key);
            return (
              <div key={p.key} className="spread" style={{ padding: '4px 6px', borderBottom: '1px solid var(--border)' }}>
                <code style={{ fontSize: 12 }}>{p.key}</code>
                <div className="row" style={{ gap: 6 }}>
                  <button
                    className={'btn sm' + (isAllow ? ' success' : ' secondary')}
                    onClick={() => { onAllow(isAllow ? allow.filter((x) => x !== p.key) : [...allow, p.key]); if (isDeny) onDeny(deny.filter((x) => x !== p.key)); }}
                  >
                    {isAllow ? '✓ Allowed' : 'Allow'}
                  </button>
                  <button
                    className={'btn sm' + (isDeny ? ' danger' : ' secondary')}
                    onClick={() => { onDeny(isDeny ? deny.filter((x) => x !== p.key) : [...deny, p.key]); if (isAllow) onAllow(allow.filter((x) => x !== p.key)); }}
                  >
                    {isDeny ? '✕ Denied' : 'Deny'}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Modal>
  );
}