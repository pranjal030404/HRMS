import React, { useEffect, useMemo, useState } from 'react';
import { api, errMsg, money } from '../../api';
import { Empty, Spinner, TextAreaField, useToast } from '../../components/ui';
import { PageHeader, PlatformSection, num, useLoader, usePlatform } from './shared';

export default function PlatformPlans() {
  return (
    <PlatformSection perm="platform.plans.view">
      <Plans />
    </PlatformSection>
  );
}

function Plans() {
  const toast = useToast();
  const { can } = usePlatform();
  const [selected, setSelected] = useState(null);
  const { data, loading, reload } = useLoader(async () => {
    const { data } = await api.get('/platform/plans');
    return data.data;
  }, []);

  if (loading && !data) return <Spinner />;
  if (!data?.length) return <Empty text="No plans are defined" />;

  const current = data.find((p) => p.id === selected) || data[0];

  return (
    <div>
      <PageHeader
        title="Plans"
        sub="What a plan includes, and therefore what every company on it can do. Changing a plan re-resolves the entitlements of every company on that plan immediately — that is the point of a plan being the unit of pricing."
        actions={<button className="btn secondary sm" onClick={() => reload()}>Refresh</button>}
      />

      <div className="split">
        <div className="split-side">
          {data.map((p) => (
            <button key={p.id} className={'pane-item' + (current.id === p.id ? ' active' : '')}
              onClick={() => setSelected(p.id)} style={{ width: '100%', textAlign: 'left' }}>
              <div className="pane-item-text">
                <div className="pane-item-title">{p.name}</div>
                <div className="pane-item-sub">
                  {p.plan_key} · {p.price_monthly ? money(p.price_monthly) + '/mo' : 'custom'}
                  {p.employee_limit ? ` · up to ${num(p.employee_limit)} employees` : ''}
                </div>
              </div>
            </button>
          ))}
        </div>

        <div className="split-main">
          <PlanDetail plan={current} canManage={can('platform.plans.manage')} onSaved={() => { reload(); toast('Plan updated'); }} />
        </div>
      </div>
    </div>
  );
}

function PlanDetail({ plan, canManage, onSaved }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({});
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    const d = {};
    for (const e of plan.entitlements) d[e.entitlement_key] = e.value;
    setDraft(d);
  }, [plan.id, plan.entitlements]);

  const changes = useMemo(() => plan.entitlements
    .map((e) => ({ key: e.entitlement_key, name: e.name, kind: e.kind, unit: e.unit, from: e.value, to: draft[e.entitlement_key] }))
    .filter((c) => String(c.from ?? '') !== String(c.to ?? '')), [plan.entitlements, draft]);

  const save = async () => {
    setBusy(true); setError('');
    try {
      await api.put(`/platform/plans/${plan.id}/entitlements`, {
        entitlements: changes.map((c) => ({ entitlementKey: c.key, value: c.to })),
        reason,
      });
      setEditing(false);
      setReason('');
      onSaved();
    } catch (e) { setError(errMsg(e)); }
    setBusy(false);
  };

  return (
    <div>
      <div className="card mb">
        <div className="card-h">
          <h3>{plan.name}</h3>
          <span className="badge purple">{plan.plan_key}</span>
          {canManage && (
            <button className="btn sm" onClick={() => setEditing(true)}>
              {editing ? 'Cancel edit' : 'Edit entitlements'}
            </button>
          )}
        </div>
        <div className="card-b">
          <div className="row wrap" style={{ gap: 22 }}>
            <div><div className="hint">Price</div><strong>{plan.price_monthly ? money(plan.price_monthly) : 'Custom'}</strong></div>
            <div><div className="hint">Employee ceiling</div><strong>{plan.employee_limit ? num(plan.employee_limit) : 'Unlimited'}</strong></div>
            <div><div className="hint">Trial</div><strong>{plan.trial_days ? `${plan.trial_days} days` : 'None'}</strong></div>
            <div><div className="hint">Public</div><strong>{plan.is_public ? 'Listed publicly' : 'Not listed'}</strong></div>
            <div><div className="hint">Entitlements</div><strong>{plan.entitlements.length}</strong></div>
          </div>
        </div>
      </div>

      {editing && changes.length > 0 && (
        <div className="card mb">
          <div className="card-h"><h3>{changes.length} pending change{changes.length === 1 ? '' : 's'}</h3></div>
          <div className="card-b">
            <div className="table-wrap mb">
              <table className="tbl">
                <thead><tr><th>Entitlement</th><th>From</th><th>To</th></tr></thead>
                <tbody>
                  {changes.map((c) => (
                    <tr key={c.key}>
                      <td><strong>{c.name}</strong><div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{c.key}</div></td>
                      <td style={{ color: 'var(--muted)' }}>{c.from ?? '—'}</td>
                      <td><span className="badge blue">{c.to}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <TextAreaField
              label="Reason for this change *"
              value={reason}
              onChange={setReason}
              hint="Stored in the platform audit alongside the before/after values."
            />
            {error && <div className="error-box mb">{error}</div>}
            <div className="row">
              <button className="btn" onClick={save} disabled={busy || reason.trim().length < 1}>
                {busy ? 'Saving…' : `Apply to every company on ${plan.name}`}
              </button>
              <span className="hint">Every company on this plan sees the change on their next request.</span>
            </div>
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-h"><h3>What this plan includes</h3></div>
        <div className="table-wrap">
          <table className="tbl">
            <thead><tr><th>Entitlement</th><th>Key</th><th>Value</th></tr></thead>
            <tbody>
              {plan.entitlements.map((e) => (
                <tr key={e.id ?? e.entitlement_key}>
                  <td>
                    <strong>{e.name}</strong>
                    {e.unit && <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>counted in {e.unit}</div>}
                  </td>
                  <td><code style={{ fontSize: 11.5 }}>{e.entitlement_key}</code></td>
                  <td>
                    {editing ? (
                      e.kind === 'boolean' ? (
                        <select value={draft[e.entitlement_key] ?? '0'}
                          onChange={(ev) => setDraft((d) => ({ ...d, [e.entitlement_key]: ev.target.value }))}>
                          <option value="1">Included</option>
                          <option value="0">Not included</option>
                        </select>
                      ) : (
                        <input type="number" min="0" style={{ width: 130 }}
                          value={draft[e.entitlement_key] ?? ''}
                          onChange={(ev) => setDraft((d) => ({ ...d, [e.entitlement_key]: ev.target.value }))} />
                      )
                    ) : (
                      e.kind === 'boolean'
                        ? (Number(e.value) ? <span className="badge green">Included</span> : <span className="badge gray">Not included</span>)
                        : Number(e.value) === 0
                          ? <span className="badge gray">Not included</span>
                          : <span className="badge blue">{e.value} {e.unit || ''}</span>
                    )}
                  </td>
                </tr>
              ))}
              {!plan.entitlements.length && (
                <tr><td colSpan={3}><Empty text="This plan grants nothing yet" /></td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
