import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, fmtDate, money } from '../../api';
import { Empty } from '../../components/ui';
import { PlatformTable, EmptyState } from '../../components/PlatformTable';
import { PageHeader, Pager, PlatformSection, SubBadge, num, useLoader, usePlatform } from './shared';

export default function PlatformSubscriptions() {
  return (
    <PlatformSection perm="platform.subscriptions.view">
      <Subscriptions />
    </PlatformSection>
  );
}

function Subscriptions() {
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const { subscriptionStatuses } = usePlatform();

  const { data, meta, loading, error, reload } = useLoader(async () => {
    const { data } = await api.get('/platform/subscriptions', {
      params: { status: status || undefined, page, limit: 25 },
    });
    return data;
  }, [status, page]);

  const rows = data || [];
  const mrr = rows.reduce((sum, r) => (
    ['trialing', 'active', 'past_due', 'grace_period'].includes(r.status)
      ? sum + Number(r.price_per_period || 0) * (1 - Number(r.discount_pct || 0) / 100)
      : sum
  ), 0);

  return (
    <div>
      <PageHeader
        title="Subscriptions"
        sub="Every subscription on the platform, with the state its tenant is in. A subscription in past_due or grace_period is still counted towards MRR because the company is still being served."
        actions={<button className="btn secondary sm" onClick={() => reload()}>Refresh</button>}
      />

      <div className="stat-grid mb">
        <div className="card stat">
          <div className="lbl">On this page</div>
          <div className="val">{num(rows.length)}</div>
          <div className="sub">of {num(meta?.total || 0)} total</div>
        </div>
        <div className="card stat">
          <div className="lbl">MRR on this page</div>
          <div className="val" style={{ color: '#067647' }}>{money(mrr)}</div>
          <div className="sub">serving subscriptions only</div>
        </div>
        <div className="card stat">
          <div className="lbl">Platform MRR</div>
          <div className="val">{money(rows[0]?.platform_mrr || 0)}</div>
          <div className="sub">across all companies</div>
        </div>
        <div className="card stat">
          <div className="lbl">Needs attention</div>
          <div className="val" style={{ color: rows.some((r) => ['past_due', 'unpaid', 'grace_period'].includes(r.status)) ? '#f79009' : undefined }}>
            {num(rows.filter((r) => ['past_due', 'unpaid', 'grace_period', 'suspended'].includes(r.status)).length)}
          </div>
          <div className="sub">past due, unpaid or suspended</div>
        </div>
      </div>

      <div className="card mb">
        <div className="card-b" style={{ paddingBottom: 0 }}>
          <div className="row wrap">
            <button className={'btn sm ' + (status === '' ? '' : 'secondary')} onClick={() => { setStatus(''); setPage(1); }}>All</button>
            {subscriptionStatuses.map((s) => (
              <button key={s} className={'btn sm ' + (status === s ? '' : 'secondary')} onClick={() => { setStatus(s); setPage(1); }}>
                {s.replace(/_/g, ' ')}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="card">
        <PlatformTable
          id="subscriptions" rows={rows} loading={loading} error={error} onRetry={reload}
          serverMeta={meta} onPage={setPage} hideSearch
          columns={[
            { key: 'tenant_name', label: 'Company', sortable: true, render: (s) => (<>
              <Link to={`/platform/companies/${s.tenant_id}`}><strong>{s.tenant_name}</strong></Link>
              <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{s.tenant_slug} · #{s.id}</div></>) },
            { key: 'plan_key', label: 'Plan', sortable: true, render: (s) => <span className="badge purple">{s.plan_key}</span> },
            { key: 'status', label: 'State', sortable: true, render: (s) => <SubBadge status={s.status} /> },
            { key: 'price_per_period', label: 'Amount', sortable: true, align: 'right', value: (s) => Number(s.price_per_period), render: (s) => (<>
              {money(s.price_per_period)}<div style={{ fontSize: 11, color: 'var(--muted)' }}>/ {s.billing_cycle || 'month'}</div></>) },
            { key: 'discount_pct', label: 'Discount', sortable: true, align: 'right', render: (s) => (s.discount_pct ? `${s.discount_pct}%` : '—') },
            { key: 'current_period_end', label: 'Period ends', sortable: true, render: (s) => (s.current_period_end ? fmtDate(s.current_period_end) : '—') },
            { key: 'trial_ends_at', label: 'Trial ends', sortable: true, render: (s) => (s.trial_ends_at ? fmtDate(s.trial_ends_at) : '—') },
          ]}
          empty={<EmptyState title="No subscriptions" text="No subscriptions match that filter." />}
        />
      </div>

      <p className="hint" style={{ marginTop: 12 }}>
        State changes happen on a company’s <Link to="/platform/companies">detail page</Link>, where
        the transition graph and the reason field are enforced together.
      </p>
    </div>
  );
}
