import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, fmtDate, money } from '../../api';
import { BarList, Donut, Empty, StatCard } from '../../components/ui';
import { ErrorState } from '../../components/PlatformTable';
import {
  PageHeader, PageSkeleton, SubBadge, TenantBadge, UsageBadge, PlatformSection, num, useLoader,
} from './shared';

export default function PlatformDashboard() {
  return (
    <PlatformSection perm="platform.dashboard.view">
      <Dashboard />
    </PlatformSection>
  );
}

/** Live measurements from GET /platform/health — only what the server could actually check. */
function SystemHealth() {
  const [h, setH] = useState(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    let live = true;
    api.get('/platform/health').then(({ data }) => live && setH(data.data)).catch(() => live && setErr(true));
    return () => { live = false; };
  }, []);
  if (err) return <div className="card mb"><div className="card-b"><ErrorState title="Health check unavailable" /></div></div>;
  if (!h) return <div className="skel mb" style={{ height: 76 }} />;
  const w = h.webhooks24h;
  const bad = w.failed + w.dead;
  return (
    <div className="kpis mb" aria-label="System health">
      <div className="kpi"><span>API</span><b><span className="badge green">Up</span> <small style={{ fontWeight: 500, fontSize: 12 }}>{Math.round(h.api.uptimeSeconds / 60)} min</small></b></div>
      <div className="kpi"><span>Database</span><b><span className="badge green">OK</span> <small style={{ fontWeight: 500, fontSize: 12 }}>{h.database.latencyMs} ms</small></b></div>
      <div className="kpi"><span>Webhooks (24h)</span><b>{num(w.success)} ok · <span style={{ color: bad ? '#b42318' : undefined }}>{num(bad)} failed</span></b></div>
      <div className="kpi"><span>Deletion requests</span><b>{num(h.queues.openDeletionRequests)}</b></div>
      <div className="kpi"><span>Pending exports</span><b>{h.queues.pendingExports === null ? '—' : num(h.queues.pendingExports)}</b></div>
    </div>
  );
}

function Dashboard() {
  const { data, loading, reload } = useLoader(async () => {
    const { data } = await api.get('/platform/dashboard');
    return data.data;
  }, []);

  if (loading && !data) return <PageSkeleton />;
  if (!data) return <ErrorState title="The dashboard could not be loaded" message="The platform API did not answer." onRetry={reload} />;

  const t = data.tenants;
  const s = data.subscriptions;

  return (
    <div>
      <PageHeader
        title="Platform overview"
        sub="Every number here is computed across all companies. Nothing in this console is tenant data — opening a customer's configuration requires a Support Access session, which is itself logged."
        actions={<button className="btn secondary sm" onClick={() => reload()}>Refresh</button>}
      />

      <SystemHealth />

      <div className="stat-grid mb">
        <StatCard label="Companies" value={num(t.total)} sub={`${num(t.active)} active · ${num(t.trial)} trial`} />
        <StatCard label="Monthly recurring revenue" value={money(s.mrr)} sub={`${num(s.active)} paying subscriptions`} accent="#067647" />
        <StatCard label="Employees on payroll" value={num(data.employees.total)} sub="across every tenant" />
        <StatCard
          label="At risk"
          value={num(t.pastDue + t.suspended)}
          sub={`${num(t.pastDue)} past due · ${num(t.suspended)} suspended`}
          accent={t.pastDue + t.suspended > 0 ? '#b42318' : undefined}
        />
        <StatCard label="Open support sessions" value={num(data.activeSupportSessions)} sub="time-limited, auditable" />
        <StatCard
          label="Limit breaches"
          value={num(data.limitBreaches.length)}
          sub={data.limitBreaches.length ? 'companies over a plan limit' : 'nobody over a limit'}
          accent={data.limitBreaches.length ? '#f79009' : undefined}
        />
        <StatCard label="Security alerts" value={num(data.securityAlerts.length)} sub="5+ failed logins / 24h" accent={data.securityAlerts.length ? '#b42318' : undefined} />
        <StatCard label="Failing integrations" value={num(data.integrationFailures.length)} sub="tenant connectors in error" accent={data.integrationFailures.length ? '#f79009' : undefined} />
      </div>

      <div className="grid c2 mb">
        <div className="card">
          <div className="card-h"><h3>Companies by lifecycle state</h3></div>
          <div className="card-b">
            {Object.keys(t.byStatus).length ? (
              <Donut data={Object.entries(t.byStatus).map(([label, value]) => ({ label: label.replace(/_/g, ' '), value }))} />
            ) : <Empty text="No companies yet" />}
          </div>
        </div>

        <div className="card">
          <div className="card-h"><h3>Consumption this period</h3></div>
          <div className="card-b">
            <BarList
              valueFormat={(v) => num(v)}
              data={[
                { label: 'API requests', value: Number(data.usage['api.requests.month'] || 0) },
                { label: 'Payroll runs', value: Number(data.usage['payroll_runs.month'] || 0) },
                { label: 'Workflow runs', value: Number(data.usage['workflow.executions.month'] || 0) },
                { label: 'AI questions', value: Number(data.usage['ai.requests.month'] || 0) },
                { label: 'Stored documents', value: Number(data.usage['documents.stored'] || 0) },
              ]}
            />
            <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 12 }}>
              Summed from <code>tenant_usage</code> for the current period. A tenant sitting exactly on
              its limit is refused the next write by the API, not merely warned about here.
            </p>
            <p className="hint" style={{ marginTop: 8 }}>
              Only <code>api.requests.month</code> is metered at the point of use today. Payroll runs,
              workflow executions and AI questions have no increment call wired up yet, so those three
              read 0 until that is done — the bars are placeholders, not measurements.
            </p>
          </div>
        </div>
      </div>

      <div className="grid c2 mb">
        <div className="card">
          <div className="card-h">
            <h3>Newest companies</h3>
            <Link className="btn ghost sm" to="/platform/companies">All companies</Link>
          </div>
          <div className="table-wrap">
            <table className="tbl">
              <thead><tr><th>Company</th><th>Plan</th><th>State</th><th>Created</th></tr></thead>
              <tbody>
                {data.recentTenants.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <Link to={`/platform/companies/${r.id}`}><strong>{r.name}</strong></Link>
                      <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{r.slug}</div>
                    </td>
                    <td><span className="badge purple">{r.plan}</span></td>
                    <td><TenantBadge status={r.status} /></td>
                    <td style={{ fontSize: 12.5 }}>{fmtDate(r.created_at)}</td>
                  </tr>
                ))}
                {!data.recentTenants.length && (
                  <tr><td colSpan={4} style={{ textAlign: 'center', color: 'var(--muted)', padding: 24 }}>No companies yet</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card">
          <div className="card-h">
            <h3>Recent subscription movements</h3>
            <Link className="btn ghost sm" to="/platform/subscriptions">All subscriptions</Link>
          </div>
          <div className="table-wrap">
            <table className="tbl">
              <thead><tr><th>Company</th><th>Event</th><th>Transition</th><th>When</th></tr></thead>
              <tbody>
                {data.recentSubscriptionEvents.map((e) => (
                  <tr key={e.id}>
                    <td><Link to={`/platform/companies/${e.tenant_id}`}>Tenant #{e.tenant_id}</Link></td>
                    <td style={{ fontSize: 12.5 }}>{String(e.event_type || '').replace(/_/g, ' ')}</td>
                    <td>
                      {e.from_status ? <SubBadge status={e.from_status} /> : <span style={{ color: 'var(--muted)' }}>—</span>}
                      {' → '}
                      {e.to_status ? <SubBadge status={e.to_status} /> : null}
                    </td>
                    <td style={{ fontSize: 12.5 }}>{fmtDate(e.created_at, true)}</td>
                  </tr>
                ))}
                {!data.recentSubscriptionEvents.length && (
                  <tr><td colSpan={4} style={{ textAlign: 'center', color: 'var(--muted)', padding: 24 }}>No movements yet</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div className="grid c3">
        <div className="card">
          <div className="card-h"><h3>Limit breaches</h3><span className="badge amber">{data.limitBreaches.length}</span></div>
          <div className="table-wrap">
            <table className="tbl">
              <thead><tr><th>Company</th><th>Limit</th><th>Used</th><th>State</th></tr></thead>
              <tbody>
                {data.limitBreaches.slice(0, 8).map((b, i) => (
                  <tr key={`${b.tenantId}-${b.entitlementKey}-${i}`}>
                    <td>
                      <Link to={`/platform/companies/${b.tenantId}`}>{b.tenantName}</Link>
                      <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{b.entitlementName}</div>
                    </td>
                    <td className="num">{b.limit === 0 ? '—' : num(b.limit)}</td>
                    <td className="num">{num(b.current)}</td>
                    <td><UsageBadge status={b.status} /></td>
                  </tr>
                ))}
                {!data.limitBreaches.length && (
                  <tr><td colSpan={4} style={{ textAlign: 'center', color: 'var(--muted)', padding: 24 }}>Nobody is over a limit</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card">
          <div className="card-h"><h3>Security alerts</h3><span className="badge red">{data.securityAlerts.length}</span></div>
          <div className="table-wrap">
            <table className="tbl">
              <thead><tr><th>Account</th><th>Failures</th><th>Last seen</th></tr></thead>
              <tbody>
                {data.securityAlerts.map((a) => (
                  <tr key={a.email}>
                    <td style={{ fontSize: 12.5 }}>{a.email}</td>
                    <td className="num">{num(a.failures)}</td>
                    <td style={{ fontSize: 12.5 }}>{fmtDate(a.last_seen, true)}</td>
                  </tr>
                ))}
                {!data.securityAlerts.length && (
                  <tr><td colSpan={3} style={{ textAlign: 'center', color: 'var(--muted)', padding: 24 }}>No repeated failures</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card">
          <div className="card-h"><h3>Failing tenant integrations</h3><span className="badge amber">{data.integrationFailures.length}</span></div>
          <div className="table-wrap">
            <table className="tbl">
              <thead><tr><th>Company</th><th>Connector</th><th>Last error</th></tr></thead>
              <tbody>
                {data.integrationFailures.map((c) => (
                  <tr key={`${c.tenant_id}-${c.name}`}>
                    <td><Link to={`/platform/companies/${c.tenant_id}`}>#{c.tenant_id}</Link></td>
                    <td style={{ fontSize: 12.5 }}>{c.name}<div style={{ fontSize: 11, color: 'var(--muted)' }}>{c.itype}</div></td>
                    <td style={{ fontSize: 12, color: 'var(--red)' }}>{c.last_error || '—'}</td>
                  </tr>
                ))}
                {!data.integrationFailures.length && (
                  <tr><td colSpan={3} style={{ textAlign: 'center', color: 'var(--muted)', padding: 24 }}>All connectors healthy</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
