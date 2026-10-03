import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api';
import { Empty, Spinner, Tabs } from '../../components/ui';
import { PageHeader, PlatformSection, UsageBadge, num, useLoader, usePlatform } from './shared';

export default function PlatformEntitlements() {
  return (
    <PlatformSection perm="platform.entitlements.view">
      <Entitlements />
    </PlatformSection>
  );
}

const TABS = [
  { key: 'catalogue', label: 'Entitlement catalogue' },
  { key: 'breaches', label: 'Limit breaches' },
];

function Entitlements() {
  const [tab, setTab] = useState('catalogue');
  return (
    <div>
      <PageHeader
        title="Entitlements & usage"
        sub="The catalogue is the product's vocabulary: every cap, every feature switch, every metered quantity the platform can grant. A plan picks values from it; a company deviates with an override."
      />
      <Tabs tabs={TABS} active={tab} onChange={setTab} />
      {tab === 'catalogue' && <Catalogue />}
      {tab === 'breaches' && <Breaches />}
    </div>
  );
}

function Catalogue() {
  const { plans } = usePlatform();
  const [q, setQ] = useState('');
  const [kind, setKind] = useState('');
  const { data, meta, loading } = useLoader(async () => {
    const { data } = await api.get('/platform/entitlements');
    return data;
  }, []);

  const rows = useMemo(() => {
    let out = data || [];
    if (q.trim()) {
      const n = q.toLowerCase();
      out = out.filter((e) => `${e.entitlement_key} ${e.name} ${e.description || ''}`.toLowerCase().includes(n));
    }
    if (kind) out = out.filter((e) => e.kind === kind);
    return out;
  }, [data, q, kind]);

  if (loading && !data) return <Spinner />;

  const planKeys = plans.map((p) => p.key);

  return (
    <div>
      <div className="card mb">
        <div className="card-b" style={{ paddingBottom: 0 }}>
          <div className="row wrap">
            <div className="searchbox" style={{ minWidth: 240, flex: 1 }}>
              <input placeholder="Search the catalogue…" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            <select value={kind} onChange={(e) => setKind(e.target.value)} style={{ width: 170 }}>
              <option value="">Every kind</option>
              <option value="boolean">Feature switches</option>
              <option value="numeric">Caps</option>
              <option value="metered">Metered</option>
            </select>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-h">
          <h3>{rows.length} of {meta?.catalog || rows.length} entitlements</h3>
          <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>per-plan values are set on the Plans page</span>
        </div>
        <div className="table-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Entitlement</th><th>Kind</th><th>Module</th>
                {planKeys.map((k) => <th key={k} style={{ textAlign: 'right' }}>{k}</th>)}
                <th className="num">Overrides</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.id}>
                  <td>
                    <strong>{e.name}</strong>
                    <div style={{ fontSize: 11.5, color: 'var(--muted)' }}><code>{e.entitlement_key}</code></div>
                    {e.description && <div style={{ fontSize: 11.5, color: 'var(--muted)', maxWidth: 420, marginTop: 2 }}>{e.description}</div>}
                  </td>
                  <td>
                    <span className={'badge ' + (e.kind === 'boolean' ? 'blue' : e.kind === 'metered' ? 'purple' : 'gray')}>{e.kind}</span>
                    {e.unit && <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 3 }}>{e.unit}</div>}
                  </td>
                  <td style={{ fontSize: 12.5, color: 'var(--muted)' }}>{e.module_key || '—'}</td>
                  {planKeys.map((k) => {
                    const v = e.allowedValues?.[k];
                    return (
                      <td key={k} className="num" style={{ fontSize: 12.5 }}>
                        {v === undefined || v === null || v === ''
                          ? <span style={{ color: 'var(--muted)' }}>—</span>
                          : e.kind === 'boolean'
                            ? (Number(v) ? <span className="badge green">on</span> : <span className="badge gray">off</span>)
                            : Number(v) === 0
                              ? <span className="badge gray">—</span>
                              : <span className="badge blue">{v}</span>}
                      </td>
                    );
                  })}
                  <td className="num">
                    {e.overrides ? <span className="badge amber">{num(e.overrides)}</span> : <span style={{ color: 'var(--muted)' }}>0</span>}
                  </td>
                </tr>
              ))}
              {!rows.length && (
                <tr><td colSpan={3 + planKeys.length}><Empty text="Nothing matches that search" /></td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <p className="hint" style={{ marginTop: 12 }}>
        A dash means the plan says nothing about this key, so the entitlement falls back to its
        default. A zero means <em>not included</em> — the capability is refused, not merely uncounted.
      </p>
    </div>
  );
}

function Breaches() {
  const [status, setStatus] = useState('');
  const { data, loading, reload } = useLoader(async () => {
    const { data } = await api.get('/platform/usage/breaches');
    return data.data;
  }, []);

  if (loading && !data) return <Spinner />;
  const rows = (data || []).filter((b) => !status || b.status === status);
  const byStatus = (data || []).reduce((acc, b) => { acc[b.status] = (acc[b.status] || 0) + 1; return acc; }, {});

  return (
    <div>
      <div className="info-box mb">
        A breach is a company sitting at or past a limit included in its plan. The API refuses the
        write with 402 the moment that is true — this list is how the platform sees it happening
        rather than a customer discovering it.
      </div>

      <div className="row wrap mb">
        <button className={'btn sm ' + (status === '' ? '' : 'secondary')} onClick={() => setStatus('')}>All</button>
        {Object.keys(byStatus).map((s) => (
          <button key={s} className={'btn sm ' + (status === s ? '' : 'secondary')} onClick={() => setStatus(s)}>
            {s} ({byStatus[s]})
          </button>
        ))}
        <span style={{ flex: 1 }} />
        <button className="btn secondary sm" onClick={() => reload()}>Refresh</button>
      </div>

      <div className="card">
        <div className="table-wrap">
          <table className="tbl">
            <thead>
              <tr><th>Company</th><th>Plan</th><th>Limit</th><th className="num">Used</th><th style={{ width: 160 }}>Consumption</th><th>State</th></tr>
            </thead>
            <tbody>
              {rows.map((b, i) => (
                <tr key={`${b.tenantId}-${b.entitlementKey}-${i}`}>
                  <td>
                    <Link to={`/platform/companies/${b.tenantId}`}><strong>{b.tenantName}</strong></Link>
                    <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{b.entitlementName}</div>
                  </td>
                  <td><span className="badge purple">{b.plan || '—'}</span></td>
                  <td>{b.limit === 0 ? <span className="badge gray">not included</span> : num(b.limit)}</td>
                  <td className="num">{num(b.current)}</td>
                  <td>
                    <div className="bar-track">
                      <div className="bar-fill" style={{ width: `${Math.min(100, b.percentUsed)}%` }} />
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--muted)' }}>{b.percentUsed}%</div>
                  </td>
                  <td><UsageBadge status={b.status} /></td>
                </tr>
              ))}
              {!rows.length && (
                <tr><td colSpan={6}><Empty icon="✅" text="No company is at or over a limit" /></td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
