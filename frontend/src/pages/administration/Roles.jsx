import React, { useState } from 'react';
import { api, errMsg } from '../../api';
import { useAuth } from '../../auth';
import DataTable from '../../components/DataTable';
import { Confirm, Empty, Modal, SelectField, Spinner, StatusBadge, Tabs, TextField, useToast } from '../../components/ui';
import { AdminSection, PageHeader, listLoader, num, useLoader } from './shared';

const STATUS = [{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }];

export default function AdminRoles() {
  return (
    <AdminSection sectionKey="roles">
      <Roles />
    </AdminSection>
  );
}

function Roles() {
  const { can } = useAuth();
  const toast = useToast();
  const [tab, setTab] = useState('roles');
  const { data, loading, reload } = useLoader(listLoader('/administration/roles'), []);
  const { data: groups, reload: reloadGroups } = useLoader(listLoader('/administration/permission-groups'), []);
  const [editor, setEditor] = useState(null);
  const [cloning, setCloning] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [comparing, setComparing] = useState(false);
  const [groupPermissions, setGroupPermissions] = useState(null);

  return (
    <div>
      <PageHeader
        title="Roles"
        sub="A role is a named bundle of permissions. Nothing is hard-coded — any company can define its own."
        actions={
          <>
            {can('administration.roles.manage') && <button className="btn sm" onClick={() => setEditor({})}>+ Create role</button>}
            <button className="btn secondary sm" onClick={() => setComparing(true)}>Compare</button>
          </>
        }
      />

      <Tabs
        tabs={[
          { key: 'roles', label: `Roles${data ? ` (${data.length})` : ''}` },
          { key: 'groups', label: `Permission groups${groups ? ` (${groups.length})` : ''}` },
        ]}
        active={tab}
        onChange={setTab}
      />

      {tab === 'roles' ? (
        <DataTable
          rows={data}
          loading={loading}
          columns={[
            { key: 'label', label: 'Role' },
            { key: 'name', label: 'Code', render: (r) => <code style={{ fontSize: 12 }}>{r.name}</code> },
            { key: 'isCustom', label: 'Type', sortValue: (r) => (r.isCustom ? 1 : 0), render: (r) => (r.isCustom ? <span className="badge purple">custom</span> : <span className="badge gray">system</span>) },
            { key: 'permissionCount', label: 'Permissions', align: 'right', sortValue: (r) => Number(r.permissionCount || 0), render: (r) => num(r.permissionCount) },
            { key: 'groupCount', label: 'Groups', align: 'right', sortValue: (r) => Number(r.groupCount || 0), render: (r) => (Number(r.groupCount) ? num(r.groupCount) : <span style={{ color: 'var(--muted)' }}>—</span>) },
            { key: 'userCount', label: 'Users', align: 'right', sortValue: (r) => Number(r.userCount || 0), render: (r) => num(r.userCount) },
            { key: 'status', label: 'Status', render: (r) => <StatusBadge value={r.status} /> },
          ]}
          actions={(row) => (
            <>
              <button className="btn ghost sm" onClick={() => setEditor(row)}>Open</button>
              {can('administration.roles.manage') && (
                <button className="btn ghost sm" onClick={() => setCloning(row)}>Clone</button>
              )}
              {can('administration.roles.manage') && !row.isSystem && (
                <button className="btn ghost sm" style={{ color: 'var(--red)' }} onClick={() => setDeleting(row)}>Delete</button>
              )}
            </>
          )}
        />
      ) : (
        <PermissionGroups
          rows={groups}
          canManage={can('administration.roles.manage')}
          onChanged={() => { reloadGroups(); reload(); }}
          onEditPermissions={setGroupPermissions}
        />
      )}

      {editor && (
        <RoleEditor
          role={editor}
          groups={groups}
          onClose={() => setEditor(null)}
          onSaved={() => { setEditor(null); reload(); }}
        />
      )}

      {cloning && (
        <CloneRole
          role={cloning}
          onClose={() => setCloning(null)}
          onDone={() => { setCloning(null); reload(); }}
        />
      )}

      {comparing && <CompareRoles roles={data} onClose={() => setComparing(false)} />}

      {deleting && (
        <DeleteRole role={deleting} onClose={() => setDeleting(null)} onDeleted={() => { setDeleting(null); reload(); }} />
      )}

      {groupPermissions && (
        <GroupPermissions
          group={groupPermissions}
          onClose={() => setGroupPermissions(null)}
          onSaved={() => { setGroupPermissions(null); reloadGroups(); }}
        />
      )}
    </div>
  );
}

/** Create or edit a role, with its permission set and group composition. */
function RoleEditor({ role, groups, onClose, onSaved }) {
  const toast = useToast();
  const isNew = !role.id;
  const { data: detail, loading } = useLoader(
    async () => (isNew ? null : (await api.get(`/administration/roles/${role.id}`)).data.data),
    [role.id]
  );
  const [label, setLabel] = useState(role.label || '');
  const [name, setName] = useState(role.name || '');
  const [description, setDescription] = useState(role.description || '');
  const [status, setStatus] = useState(role.status || 'active');
  const [perms, setPerms] = useState(role.permissions || []);
  const [groupIds, setGroupIds] = useState([]);

  React.useEffect(() => {
    if (!detail) return;
    setLabel(detail.label || '');
    setName(detail.name || '');
    setDescription(detail.description || '');
    setStatus(detail.status || 'active');
    setPerms(detail.permissions || []);
    setGroupIds((detail.groups || []).map((g) => g.id));
  }, [detail]);

  const save = async () => {
    try {
      if (isNew) {
        await api.post('/administration/roles', {
          name, label, description, permissions: perms, group_ids: groupIds,
        });
        toast('Role created');
      } else {
        await api.put(`/administration/roles/${role.id}`, {
          label, description, status, permissions: perms, group_ids: groupIds,
        });
        toast('Role updated');
      }
      onSaved();
    } catch (e) { toast(errMsg(e), true); }
  };

  if (!isNew && loading && !detail) return <Modal title="Role" onClose={onClose} wide><Spinner /></Modal>;

  return (
    <Modal
      title={isNew ? 'Create role' : `Role — ${detail?.label || role.label || role.name}`}
      onClose={onClose}
      wide
      footer={<><button className="btn secondary" onClick={onClose}>Cancel</button><button className="btn" onClick={save} disabled={isNew && !name}>Save</button></>}
    >
      {detail?.beyondYourAccess?.length > 0 && (
        <div className="error-box">
          This role grants {detail.beyondYourAccess.length} permission(s) beyond your own access, so it is read-only for you.
        </div>
      )}
      <div className="form-grid">
        {isNew && <TextField label="Role name (key)" value={name} onChange={setName} hint="lowercase, e.g. regional_hr" />}
        <TextField label="Label" value={label} onChange={setLabel} />
        <SelectField label="Status" value={status} onChange={setStatus} options={STATUS} />
        <div style={{ gridColumn: '1 / -1' }}>
          <TextField label="Description" value={description} onChange={setDescription} />
        </div>
      </div>

      <div className="mt">
        <b style={{ fontSize: 13.5 }}>Permission groups</b>
        <div className="row wrap mt" style={{ gap: 6 }}>
          {(groups || []).map((g) => (
            <label key={g.id} className="badge" style={{ cursor: 'pointer', opacity: groupIds.includes(g.id) ? 1 : 0.55 }}>
              <input
                type="checkbox"
                checked={groupIds.includes(g.id)}
                onChange={(e) => setGroupIds((ids) => (e.target.checked ? [...ids, g.id] : ids.filter((x) => x !== g.id)))}
                style={{ marginRight: 6 }}
              />
              {g.name}
            </label>
          ))}
          {!(groups || []).length && <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>No permission groups</span>}
        </div>
      </div>

      <div className="mt">
        <PermissionPicker
          value={perms}
          onChange={setPerms}
          disabled={detail?.editable === false}
          highlighted={(detail?.groups || []).flatMap((g) => g.permissions || [])}
        />
      </div>
    </Modal>
  );
}

/** Module-grouped permission picker with search and bulk select. */
export function PermissionPicker({ value, onChange, disabled, highlighted = [] }) {
  const { data, loading } = useLoader(async () => (await api.get('/administration/permissions/matrix')).data, []);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState({});

  const modules = data?.data || [];
  const filter = q.trim().toLowerCase();
  const selected = new Set(value);

  const toggle = (key) => {
    if (disabled) return;
    onChange(selected.has(key) ? value.filter((k) => k !== key) : [...value, key]);
  };

  const toggleModule = (mod) => {
    if (disabled) return;
    const keys = mod.permissions.map((p) => p.key);
    const allOn = keys.every((k) => selected.has(k));
    onChange(allOn ? value.filter((k) => !keys.includes(k)) : [...new Set([...value, ...keys])]);
  };

  return (
    <div>
      <div className="row spread mb">
        <b style={{ fontSize: 13.5 }}>Permissions ({num(value.length)} selected)</b>
        <div className="row">
          <div className="searchbox"><input placeholder="Filter…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
          {!disabled && (
            <>
              <button className="btn ghost sm" onClick={() => onChange([])}>Clear</button>
            </>
          )}
        </div>
      </div>
      {loading ? <Spinner /> : (
        <div style={{ maxHeight: 400, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 10 }}>
          {modules.map((mod) => {
            const perms = mod.permissions.filter((p) => !filter || p.key.toLowerCase().includes(filter));
            if (filter && !perms.length) return null;
            const isOpen = open[mod.module] || !!filter;
            const allOn = mod.permissions.every((p) => selected.has(p.key));
            return (
              <div key={mod.module} style={{ borderBottom: '1px solid var(--border)' }}>
                <div
                  className="spread"
                  style={{ padding: '8px 10px', cursor: 'pointer', background: 'var(--surface)' }}
                  onClick={() => setOpen((o) => ({ ...o, [mod.module]: !isOpen }))}
                >
                  <span style={{ fontSize: 13, fontWeight: 600 }}>
                    {isOpen ? '▾' : '▸'} {mod.label || mod.module}
                    <span className="badge gray" style={{ marginLeft: 8 }}>{perms.length}</span>
                  </span>
                  <button className="btn ghost sm" onClick={(e) => { e.stopPropagation(); toggleModule(mod); }}>
                    {allOn ? 'None' : 'All'}
                  </button>
                </div>
                {isOpen && (
                  <div style={{ padding: '4px 10px 8px 26px' }}>
                    {perms.map((p) => (
                      <label key={p.key} className="check" style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginBottom: 3 }}>
                        <input type="checkbox" checked={selected.has(p.key)} disabled={disabled} onChange={() => toggle(p.key)} />
                        <span style={{ fontSize: 12.5 }}>
                          <code>{p.key}</code>
                          {highlighted.includes(p.key) && <span className="badge blue" style={{ marginLeft: 6 }}>via group</span>}
                          {p.supportsScope && <span className="badge gray" style={{ marginLeft: 6 }}>scoped</span>}
                        </span>
                      </label>
                    ))}
                    {!perms.length && <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>No match</span>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function CloneRole({ role, onClose, onDone }) {
  const toast = useToast();
  const [name, setName] = useState(`${role.name}_copy`);
  const [label, setLabel] = useState(`${role.label} (copy)`);
  const submit = async () => {
    try {
      await api.post(`/administration/roles/${role.id}/clone`, { name, code: name, label });
      toast('Role cloned');
      onDone();
    } catch (e) { toast(errMsg(e), true); }
  };
  return (
    <Modal title={`Clone “${role.label}”`} onClose={onClose}
      footer={<><button className="btn secondary" onClick={onClose}>Cancel</button><button className="btn" onClick={submit}>Clone</button></>}>
      <div className="info-box">Cloning is the safe way to customise a system role — the original stays untouched.</div>
      <div className="form-grid">
        <TextField label="New name (key)" value={name} onChange={setName} />
        <TextField label="Label" value={label} onChange={setLabel} />
      </div>
    </Modal>
  );
}

function DeleteRole({ role, onClose, onDeleted }) {
  const toast = useToast();
  const doDelete = async () => {
    try {
      await api.delete(`/administration/roles/${role.id}`);
      toast('Role deleted');
      onDeleted();
    } catch (e) { toast(errMsg(e), true); }
  };
  return (
    <Confirm
      title="Delete role?"
      message={`“${role.label}” will be removed. ${Number(role.userCount) ? `${role.userCount} user(s) still hold it — reassign them first.` : 'It has no assignments.'}`}
      danger
      onYes={doDelete}
      onClose={onClose}
    />
  );
}

/** Side-by-side difference between two roles. */
function CompareRoles({ roles, onClose }) {
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const toast = useToast();
  const options = (roles || []).map((r) => ({ value: r.id, label: r.label || r.name }));

  const compare = async () => {
    if (!a || !b) return;
    setLoading(true);
    try {
      const { data } = await api.get('/administration/roles/compare', { params: { a, b } });
      setResult(data.data);
    } catch (e) { toast(errMsg(e), true); }
    setLoading(false);
  };

  return (
    <Modal title="Compare roles" onClose={onClose} wide>
      <div className="form-grid">
        <SelectField label="Role A" value={a} onChange={setA} options={options} />
        <SelectField label="Role B" value={b} onChange={setB} options={options} />
      </div>
      <button className="btn mt" onClick={compare} disabled={!a || !b}>Compare</button>
      {loading && <Spinner />}
      {result && (
        <div className="mt">
          <div className="row mb" style={{ gap: 8, fontSize: 12.5, color: 'var(--muted)' }}>
            <span>A: <strong>{result.a?.label}</strong></span>
            <span>vs</span>
            <span>B: <strong>{result.b?.label}</strong></span>
          </div>
          <div className="grid c3">
            <PermList title="Shared" rows={result.common || []} color="green" />
            <PermList title={`Only in A (${(result.onlyInA || []).length})`} rows={result.onlyInA || []} color="blue" />
            <PermList title={`Only in B (${(result.onlyInB || []).length})`} rows={result.onlyInB || []} color="purple" />
          </div>
          {(result.scopeDifferences || []).length > 0 && (
            <div className="card mt">
              <div className="card-h"><h3>Scope differences</h3></div>
              <div className="table-wrap">
                <table className="tbl">
                  <thead><tr><th>Permission</th><th>A reaches</th><th>B reaches</th></tr></thead>
                  <tbody>
                    {result.scopeDifferences.map((s) => (
                      <tr key={s.base}>
                        <td><code style={{ fontSize: 12 }}>{s.base}</code></td>
                        <td><span className="badge blue">{s.a || 'none'}</span></td>
                        <td><span className="badge purple">{s.b || 'none'}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

const PermList = ({ title, rows, color }) => (
  <div className="card">
    <div className="card-h"><h3>{title}</h3></div>
    <div className="card-b">
      {rows.length ? rows.map((p) => (
        <div key={p} className="row" style={{ gap: 6, padding: '2px 0' }}>
          <span className={'badge ' + color} style={{ fontSize: 10.5 }}>{String(p).split('.')[0]}</span>
          <code style={{ fontSize: 11.5 }}>{p}</code>
        </div>
      )) : <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>None</span>}
    </div>
  </div>
);

/** Permission groups: reusable bundles that roles compose. */
function PermissionGroups({ rows, canManage, onChanged, onEditPermissions }) {
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: '', code: '', description: '' });
  const [deleting, setDeleting] = useState(null);

  const create = async () => {
    try {
      await api.post('/administration/permission-groups', form);
      toast('Permission group created');
      setCreating(false);
      setForm({ name: '', code: '', description: '' });
      onChanged();
    } catch (e) { toast(errMsg(e), true); }
  };

  const doDelete = async () => {
    try {
      await api.delete(`/administration/permission-groups/${deleting.id}`);
      toast('Permission group deleted');
      setDeleting(null);
      onChanged();
    } catch (e) { toast(errMsg(e), true); }
  };

  return (
    <div>
      <div className="row mb" style={{ justifyContent: 'flex-end' }}>
        {canManage && <button className="btn sm" onClick={() => setCreating(true)}>+ Create group</button>}
      </div>
      <DataTable
        rows={rows}
        emptyText="No permission groups"
        columns={[
          { key: 'name', label: 'Group' },
          { key: 'code', label: 'Code', render: (r) => <code style={{ fontSize: 12 }}>{r.code}</code> },
          { key: 'description', label: 'Description' },
          { key: 'permission_count', label: 'Permissions', align: 'right', sortValue: (r) => Number(r.permission_count || 0), render: (r) => num(r.permission_count) },
          { key: 'role_count', label: 'Roles', align: 'right', sortValue: (r) => Number(r.role_count || 0), render: (r) => num(r.role_count) },
          { key: 'is_system', label: 'Type', render: (r) => (r.is_system ? <span className="badge gray">system</span> : <span className="badge purple">custom</span>) },
        ]}
        actions={(row) => (
          <>
            {canManage && (
              <button className="btn ghost sm" onClick={() => onEditPermissions(row)}>Permissions</button>
            )}
            {canManage && !row.is_system && (
              <button className="btn ghost sm" style={{ color: 'var(--red)' }} onClick={() => setDeleting(row)}>Delete</button>
            )}
          </>
        )}
      />

      {creating && (
        <Modal title="Create permission group" onClose={() => setCreating(false)}
          footer={<><button className="btn secondary" onClick={() => setCreating(false)}>Cancel</button><button className="btn" onClick={create} disabled={!form.name}>Create</button></>}>
          <div className="form-grid">
            <TextField label="Name" value={form.name} onChange={(v) => setForm((f) => ({ ...f, name: v }))} />
            <TextField label="Code" value={form.code} onChange={(v) => setForm((f) => ({ ...f, code: v }))} hint="optional" />
            <div style={{ gridColumn: '1 / -1' }}>
              <TextField label="Description" value={form.description} onChange={(v) => setForm((f) => ({ ...f, description: v }))} />
            </div>
          </div>
        </Modal>
      )}

      {deleting && (
        <Confirm title="Delete permission group?" message={`“${deleting.name}” will be removed from every role that uses it.`} danger onYes={doDelete} onClose={() => setDeleting(null)} />
      )}
    </div>
  );
}

function GroupPermissions({ group, onClose, onSaved }) {
  const toast = useToast();
  const [perms, setPerms] = useState(group.permissions || []);
  const save = async () => {
    try {
      await api.put(`/administration/permission-groups/${group.id}/permissions`, { permissions: perms });
      toast('Group permissions saved');
      onSaved();
    } catch (e) { toast(errMsg(e), true); }
  };
  return (
    <Modal title={`${group.name} — permissions`} onClose={onClose} wide
      footer={<><button className="btn secondary" onClick={onClose}>Cancel</button><button className="btn" onClick={save}>Save</button></>}>
      <PermissionPicker value={perms} onChange={setPerms} />
    </Modal>
  );
}