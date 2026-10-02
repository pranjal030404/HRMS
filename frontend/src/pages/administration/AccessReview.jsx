import React, { useState } from 'react';
import { api, errMsg } from '../../api';
import { useAuth } from '../../auth';
import DataTable from '../../components/DataTable';
import { Empty, Spinner, StatusBadge, useToast } from '../../components/ui';
import { AdminSection, PageHeader, getLoader, listLoader, num, useLoader } from './shared';

export default function AdminAccessReview() {
  return (
    <AdminSection sectionKey="access">
      <AccessReview />
    </AdminSection>
  );
}

function AccessReview() {
  const { me } = useAuth();
  const toast = useToast();
  const [tab, setTab] = useState('mine');
  const [previewing, setPreviewing] = useState(me?.id || null);

  return (
    <div>
      <PageHeader
        title="Access Review"
        sub="Not “can this person log in” but “what exactly can they reach, and why” — with the reasoning shown."
      />
      <div className="tabs">
        {[
          { key: 'mine', label: 'My access' },
          { key: 'user', label: 'Review a user' },
          { key: 'explain', label: 'Explain a decision' },
        ].map((t) => (
          <button key={t.key} className={'tab' + (tab === t.key ? ' active' : '')} onClick={() => setTab(t.key)}>{t.label}</button>
        ))}
      </div>

      {tab === 'mine' && <AccessReport userId={me?.id} />}
      {tab === 'user' && <ReviewUser onPick={setPreviewing} />}
      {tab === 'explain' && <Explain />}

      {tab === 'user' && previewing && <div className="mt"><AccessReport userId={previewing} /></div>}
    </div>
  );
}

function ReviewUser({ onPick }) {
  const { data, loading } = useLoader(listLoader('/administration/users?limit=100'), []);
  return (
    <DataTable
      rows={data}
      loading={loading}
      onRowClick={onPick}
      columns={[
        { key: 'name', label: 'Name' },
        { key: 'email', label: 'Email' },
        { key: 'role', label: 'Role', render: (r) => r.role?.replace(/_/g, ' ') },
        { key: 'status', label: 'Status', render: (r) => <StatusBadge value={r.status} /> },
      ]}
      emptyText="No users"
    />
  );
}

/** canAccess / cannotAccess with the reason attached to every verdict. */
function AccessReport({ userId }) {
  const { data, loading, error } = useLoader(getLoader(`/administration/access/preview/${userId}`), [userId]);

  if (loading && !data) return <Spinner />;
  if (error) return <div className="error-box">{error}</div>;
  if (!data) return <Empty />;

  return (
    <div className="mt">
      <div className="card mb">
        <div className="card-h"><h3>{data.user.name}</h3><span style={{ fontSize: 12.5, color: 'var(--muted)' }}>{data.user.email}</span></div>
        <div className="card-b">
          <div className="row wrap" style={{ gap: 6 }}>
            <span className="badge blue">{num(data.permissionCount)} permissions</span>
            <span className="badge purple">{num(Object.keys(data.scopes || {}).length)} scoped resources</span>
            <span className="badge green">{num(data.canAccess.length)} modules reachable</span>
            {data.deniedPermissions?.length > 0 && <span className="badge red">{data.deniedPermissions.length} explicit denies</span>}
            {data.directPermissions?.length > 0 && <span className="badge amber">{data.directPermissions.length} direct grants</span>}
          </div>
          <div className="row wrap mt" style={{ gap: 6 }}>
            {(data.roles || []).map((r) => <span key={r.id} className="badge gray">{r.label}</span>)}
          </div>
        </div>
      </div>

      <div className="grid c2">
        <VerdictCard title="Can access" rows={data.canAccess} tone="green" />
        <VerdictCard title="Cannot access" rows={data.cannotAccess} tone="red" />
      </div>
    </div>
  );
}

function VerdictCard({ title, rows, tone }) {
  return (
    <div className="card">
      <div className="card-h">
        <h3>{title}</h3>
        <span className={'badge ' + tone}>{rows.length}</span>
      </div>
      <div className="table-wrap">
        <table className="tbl">
          <thead><tr><th>Module</th><th>Why</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.module}>
                <td>
                  {r.name}
                  {r.enabled === false && <div><span className="badge gray">module off</span></div>}
                </td>
                <td style={{ fontSize: 12.5 }}>
                  {typeof r.reason === 'string' ? (
                    <span style={{ color: 'var(--muted)' }}>{r.reason}</span>
                  ) : (
                    <ul style={{ margin: 0, paddingLeft: 16 }}>
                      {(r.reason || []).map((x, i) => (
                        <li key={i}>
                          <code style={{ fontSize: 11.5 }}>{x.permission}</code>
                          <span className="badge gray" style={{ marginLeft: 5 }}>{x.scope}</span>
                          {x.via && <span style={{ marginLeft: 5, color: 'var(--muted)' }}>via {x.via}</span>}
                        </li>
                      ))}
                    </ul>
                  )}
                </td>
              </tr>
            ))}
            {!rows.length && (
              <tr><td colSpan={2} style={{ textAlign: 'center', color: 'var(--muted)', padding: 24 }}>None</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** The single-question "why" tool. */
function Explain() {
  const toast = useToast();
  const [form, setForm] = useState({ user_id: '', permission: '', employee_id: '' });
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);

  const run = async () => {
    if (!form.permission) return;
    setLoading(true);
    try {
      const params = { permission: form.permission };
      if (form.user_id) params.user_id = form.user_id;
      if (form.employee_id) params.employee_id = form.employee_id;
      const { data } = await api.get('/administration/access/explain', { params });
      setResult(data.data);
    } catch (e) { toast(errMsg(e), true); }
    setLoading(false);
  };

  const field = (k, label, placeholder) => (
    <div className="field">
      <label>{label}</label>
      <input value={form[k]} placeholder={placeholder} onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value }))} />
    </div>
  );

  return (
    <div className="mt">
      <div className="form-grid">
        {field('user_id', 'User id (blank = you)', 'e.g. 12')}
        {field('permission', 'Permission', 'e.g. employee.view')}
        {field('employee_id', 'Employee id (optional subject)', 'e.g. 34')}
        <div><button className="btn" onClick={run} disabled={!form.permission}>Explain</button></div>
      </div>

      {loading && <Spinner />}
      {result && (
        <div className={'mt ' + (result.allowed ? 'info-box' : 'error-box')}>
          <b>{result.allowed ? 'Allowed' : 'Denied'}</b>
          {result.crossTenant && <span className="badge red" style={{ marginLeft: 8 }}>cross-tenant</span>}
          <ul style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 13 }}>
            {(result.reasons || []).map((r, i) => <li key={i}>{r}</li>)}
          </ul>
          {result.scope && <div style={{ fontSize: 12.5, marginTop: 6 }}>Effective scope: <span className="badge purple">{result.scope}</span></div>}
          {result.subjectReachable === false && <div style={{ fontSize: 12.5, marginTop: 6 }}>The caller's scope does not include this employee record.</div>}
        </div>
      )}
    </div>
  );
}