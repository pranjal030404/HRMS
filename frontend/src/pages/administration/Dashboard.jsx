import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, fmtDate } from '../../api';
import { useAuth } from '../../auth';
import { Empty, Spinner, StatCard, StatusBadge, useToast } from '../../components/ui';
import { AdminSection, PageHeader, Toggle, num, useAdminMeta, useLoader, getLoader } from './shared';

const ALERT_COLOR = { critical: 'red', warning: 'amber', info: 'blue' };

export default function AdminDashboard() {
  return (
    <AdminSection sectionKey="dashboard">
      <Dashboard />
    </AdminSection>
  );
}

function Dashboard() {
  const toast = useToast();
  const nav = useNavigate();
  const { refreshMe } = useAuth();
  const { meta } = useAdminMeta();
  const { data, loading, reload } = useLoader(getLoader('/administration/dashboard'));
  const [busy, setBusy] = useState(null);

  if (loading && !data) return <Spinner />;
  if (!data) return <Empty text="No administration data" />;

  const c = data.counts || {};

  const flipModule = async (key, enabled) => {
    setBusy(key);
    try {
      await api.put(`/administration/modules/${key}`, { enabled });
      toast(`${enabled ? 'Enabled' : 'Disabled'} ${key}`);
      reload(true);
      refreshMe(); // re-resolve accessibleModules so the sidebar follows the switch
    } catch (e) { toast(e?.response?.data?.message || 'Update failed', true); }
    setBusy(null);
  };

  return (
    <div>
      <PageHeader
        title="Administration Center"
        sub={`${meta?.tenant?.name || 'Company'} — ${num(c.employees)} employees, ${num(c.users)} logins`}
        actions={
          <>
            <button className="btn secondary sm" onClick={() => reload()}>Refresh</button>
            {(data.quickActions || []).map((a) => (
              <button key={a.key} className="btn sm" onClick={() => nav(a.route)}>{a.label}</button>
            ))}
          </>
        }
      />

      <div className="stat-grid mb">
        <StatCard label="Employees" value={num(c.employees)} sub={`${num(c.activeEmployees)} active`} />
        <StatCard label="Structure" value={`${num(c.departments)}/${num(c.teams)}`} sub="departments / teams" />
        <StatCard label="Positions" value={num(c.positions)} sub={`${num(c.modules?.enabled)} modules on`} />
        <StatCard label="Logins" value={num(c.users)} sub={`${num(c.customRoles)} custom roles`} />
        <StatCard label="Custom fields" value={num(c.customFields)} sub={`${num(c.forms)} published forms`} />
        <StatCard label="Master data" value={num(c.masterItems)} sub="active items" />
      </div>

      {(data.alerts || []).length > 0 && (
        <div className="card mb">
          <div className="card-h"><h3>Needs attention</h3></div>
          <div className="card-b">
            {data.alerts.map((a) => (
              <div key={a.key} className="row" style={{ padding: '7px 0', borderBottom: '1px solid var(--border)' }}>
                <StatusBadge value={a.severity} labels={{ critical: ['red', 'Critical'], warning: ['amber', 'Warning'], info: ['blue', 'Info'] }} />
                <span style={{ fontSize: 13.5, flex: 1 }}>{a.message}</span>
                <span className="badge gray">{a.count}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="grid c2">
        <div className="card">
          <div className="card-h"><h3>Modules</h3><span style={{ fontSize: 12.5, color: 'var(--muted)' }}>
            {c.modules?.enabled} on / {c.modules?.disabled} off
          </span></div>
          <div className="card-b">
            <div className="row wrap" style={{ gap: 8 }}>
              {(data.modules || []).map((m) => (
                <span key={m.key} className={'module-chip' + (m.enabled ? ' on' : '')}>
                  {m.key.replace(/_/g, ' ')}
                  <Toggle
                    checked={m.enabled}
                    disabled={busy === m.key}
                    onChange={(v) => flipModule(m.key, v)}
                    label={`Toggle ${m.key}`}
                  />
                </span>
              ))}
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-h"><h3>Recent administration activity</h3></div>
          <div className="table-wrap">
            <table className="tbl">
              <thead><tr><th>When</th><th>Actor</th><th>Action</th></tr></thead>
              <tbody>
                {(data.recentAdministration || []).map((r) => (
                  <tr key={r.id}>
                    <td style={{ whiteSpace: 'nowrap' }}>{fmtDate(r.created_at, true)}</td>
                    <td>{r.actor_name || '—'}<div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{r.actor_role}</div></td>
                    <td><code style={{ fontSize: 12 }}>{r.action}</code></td>
                  </tr>
                ))}
                {!(data.recentAdministration || []).length && (
                  <tr><td colSpan={3} style={{ textAlign: 'center', color: 'var(--muted)', padding: 26 }}>No administration activity yet</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}