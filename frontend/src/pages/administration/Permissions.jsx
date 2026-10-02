import React, { useState } from 'react';
import { api } from '../../api';
import DataTable from '../../components/DataTable';
import { AdminSection, PageHeader, num, useLoader } from './shared';

/**
 * The permission vocabulary itself. Read-only by design: roles, groups and
 * direct grants reference these keys, so a key that changed meaning underneath
 * them would silently widen access.
 */
export default function AdminPermissions() {
  return (
    <AdminSection sectionKey="permissions">
      <Permissions />
    </AdminSection>
  );
}

function Permissions() {
  const [q, setQ] = useState('');
  const [module, setModule] = useState('');
  const { data, loading } = useLoader(async () => (await api.get('/administration/permissions/catalog')).data, []);

  // Response shape: { data: [permissions], meta: { modules, scopes, total, aliases } }
  const permissions = data?.data || [];
  const filtered = permissions.filter((p) => {
    if (module && p.module !== module) return false;
    if (!q.trim()) return true;
    const n = q.trim().toLowerCase();
    return p.key.toLowerCase().includes(n) || (p.label || '').toLowerCase().includes(n);
  });

  return (
    <div>
      <PageHeader
        title="Permissions"
        sub={`${num(permissions.length)} permissions in the catalog, shared by roles, groups and direct grants.`}
        actions={
          <div className="row">
            <div className="searchbox"><input placeholder="Search keys…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
            <select value={module} onChange={(e) => setModule(e.target.value)} style={{ padding: '8px 10px', borderRadius: 9, border: '1px solid var(--border)', fontSize: 13 }}>
              <option value="">All modules</option>
              {(data?.meta?.modules || []).map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>
        }
      />

      <div className="row wrap mb" style={{ gap: 6 }}>
        <span className="badge blue">{num(permissions.length)} total</span>
        <span className="badge gray">{num(data?.meta?.aliases || 0)} legacy aliases</span>
        <span className="badge purple">{num((data?.meta?.scopes || []).length)} scopes</span>
        {module && <span className="badge green">{num(filtered.length)} in “{module}”</span>}
      </div>

      <DataTable
        rows={filtered}
        loading={loading}
        pageSize={25}
        columns={[
          { key: 'key', label: 'Permission key', render: (r) => <code style={{ fontSize: 12 }}>{r.key}</code> },
          { key: 'label', label: 'Label' },
          { key: 'module', label: 'Module', render: (r) => <span className="badge gray">{r.module}</span> },
          { key: 'action', label: 'Action' },
          {
            key: 'supportsScope', label: 'Scoping', sortValue: (r) => (r.supportsScope ? 1 : 0),
            render: (r) => (r.supportsScope ? <span className="badge purple">{r.scopes.join(', ') || 'any'}</span> : <span style={{ color: 'var(--muted)' }}>—</span>),
          },
          { key: 'description', label: 'Description' },
        ]}
        emptyText="No permissions match"
      />
    </div>
  );
}