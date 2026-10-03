import React, { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, errMsg, fmtDate, money } from '../../api';
import { downloadFile } from '../../components/ui';
import { useAuth } from '../../auth';
import {
  CheckField, Empty, Modal, SelectField, Spinner, StatusBadge, Tabs, TextAreaField, TextField, useToast,
} from '../../components/ui';
import {
  PageHeader, PageSkeleton, PlatformSection, SubBadge, TenantBadge, Toggle, UsageBadge, num, usePlatform,
} from './shared';
import { SupportAccessRequired } from './GrantSupport';
import {
  AuditTab, BrandingTab, ConfigurationTab, DomainsTab, IntegrationsTab, RolesTab, SecurityTab, SupportTab, UsersTab,
} from './CompanyTabs';

export default function PlatformCompanyDetail() {
  return (
    <PlatformSection perm="platform.tenants.view">
      <CompanyDetail />
    </PlatformSection>
  );
}

const TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'modules', label: 'Modules' },
  { key: 'entitlements', label: 'Entitlements' },
  { key: 'usage', label: 'Usage & limits' },
  { key: 'subscription', label: 'Subscription' },
  { key: 'users', label: 'Users' },
  { key: 'roles', label: 'Roles' },
  { key: 'security', label: 'Security' },
  { key: 'branding', label: 'Branding' },
  { key: 'domains', label: 'Domains' },
  { key: 'integrations', label: 'Integrations' },
  { key: 'audit', label: 'Audit' },
  { key: 'support', label: 'Support access' },
  { key: 'config', label: 'Configuration' },
  { key: 'data', label: 'Data & lifecycle' },
];

function CompanyDetail() {
  const { id } = useParams();
  const [tab, setTab] = useState('overview');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [blocked, setBlocked] = useState(null);
  const [err, setErr] = useState('');
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const { can } = usePlatform();

  const load = useCallback(async () => {
    setLoading(true); setBlocked(null); setErr('');
    try {
      const { data: res } = await api.get(`/platform/tenants/${id}`);
      setData(res.data);
    } catch (e) {
      setData(null);
      // 403 + requiresSupportAccess is not a failure state, it is the control
      // plane telling us exactly what to do next.
      if (e?.response?.status === 403 && e?.response?.data?.details?.requiresSupportAccess) {
        setBlocked(e?.response?.data?.message || 'Support access is required to read this company.');
      } else {
        setErr(errMsg(e));
      }
    } finally { setLoading(false); }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <PageSkeleton />;
  if (blocked) {
    return (
      <SupportAccessRequired
        error={blocked}
        tenantId={Number(id)}
        tenantName={data?.name}
        onGranted={load}
      />
    );
  }
  if (err) return <div className="error-box">{err}</div>;
  if (!data) return <Empty text="Company not found" />;

  return (
    <div>
      <PageHeader
        title={data.name}
        sub={<>Slug <code>{data.slug}</code> · tenant #{data.id} · created {fmtDate(data.created_at)}</>}
        actions={
          <>
            <TenantBadge status={data.status} />
            {can('platform.tenants.manage') && <button className="btn secondary sm" onClick={() => setEditing(true)}>Edit company</button>}
            {can('platform.data.delete') && <button className="btn danger sm" onClick={() => setDeleting(true)}>Delete company</button>}
            <Link className="btn secondary sm" to="/platform/companies">Back</Link>
          </>
        }
      />

      <div className="kpis mb">
        <div className="kpi"><span>Plan</span><b style={{ textTransform: 'capitalize' }}>{data.plan || '—'}</b></div>
        <div className="kpi"><span>Subscription</span><b>{data.subscription ? <SubBadge status={data.subscription.status} /> : 'None'}</b></div>
        <div className="kpi"><span>Active users</span><b>{num(data.counts?.active_users)}</b></div>
        <div className="kpi"><span>Employees</span><b>{num(data.counts?.employees)}</b></div>
        <div className="kpi"><span>Recurring</span><b>{data.subscription ? money(data.subscription.price_per_period) : '—'}</b></div>
        <div className="kpi"><span>Last sign-in</span><b style={{ fontSize: 13.5 }}>{data.counts?.last_activity ? fmtDate(data.counts.last_activity) : '—'}</b></div>
      </div>

      <Tabs tabs={TABS} active={tab} onChange={setTab} />
      {tab === 'overview' && <Overview tenant={data} onChanged={load} />}
      {tab === 'modules' && <Modules tenant={data} onChanged={load} />}
      {tab === 'entitlements' && <Entitlements tenant={data} onChanged={load} />}
      {tab === 'usage' && <Usage tenant={data} />}
      {tab === 'subscription' && <Subscription tenant={data} onChanged={load} />}
      {tab === 'users' && <UsersTab tenant={data} />}
      {tab === 'roles' && <RolesTab tenant={data} />}
      {tab === 'security' && <SecurityTab tenant={data} />}
      {tab === 'branding' && <BrandingTab tenant={data} />}
      {tab === 'domains' && <DomainsTab tenant={data} />}
      {tab === 'integrations' && <IntegrationsTab tenant={data} />}
      {tab === 'audit' && <AuditTab tenant={data} />}
      {tab === 'support' && <SupportTab tenant={data} />}
      {tab === 'config' && <ConfigurationTab tenant={data} />}
      {tab === 'data' && <Data tenant={data} onChanged={load} />}
      {editing && <EditCompanyModal tenant={data} onClose={() => setEditing(false)} onDone={() => { setEditing(false); load(); }} />}
      {deleting && <DeletionModal tenant={data} onClose={() => setDeleting(false)} onDone={load} />}
    </div>
  );
}

// ----------------------------------------------------------------- overview
function Overview({ tenant, onChanged }) {
  const sub = tenant.subscription;
  return (
    <div className="grid c2">
      <div className="card">
        <div className="card-h"><h3>Company</h3></div>
        <div className="table-wrap">
          <table className="tbl">
            <tbody>
              {[
                ['Legal name', tenant.legal_name || tenant.name],
                ['Display name', tenant.display_name || '—'],
                ['Industry', tenant.industry || '—'],
                ['Country / timezone', [tenant.country, tenant.timezone].filter(Boolean).join(' · ') || '—'],
                ['Currency', tenant.currency || '—'],
                ['Plan', tenant.plan],
                ['Lifecycle state', <TenantBadge key="s" status={tenant.status} />],
                ['Onboarded', tenant.onboarded_at ? fmtDate(tenant.onboarded_at) : '—'],
                ['Last sign-in', tenant.counts?.last_activity ? fmtDate(tenant.counts.last_activity, true) : '—'],
              ].map(([k, v]) => (
                <tr key={k}><td style={{ width: 180, color: 'var(--muted)', fontSize: 12.5 }}>{k}</td><td>{v}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div>
        <div className="card mb">
          <div className="card-h"><h3>Subscription</h3>{sub && <SubBadge status={sub.status} />}</div>
          <div className="card-b">
            {sub ? (
              <div className="table-wrap">
                <table className="tbl">
                  <tbody>
                    {[
                      ['Plan', sub.plan_key],
                      ['Amount', `${money(sub.price_per_period)} / ${sub.billing_cycle || 'month'}`],
                      ['Discount', sub.discount_pct ? `${sub.discount_pct}%` : '—'],
                      ['Current period ends', fmtDate(sub.current_period_end)],
                      ['Trial ends', sub.trial_ends_at ? fmtDate(sub.trial_ends_at) : '—'],
                    ].map(([k, v]) => (
                      <tr key={k}><td style={{ width: 180, color: 'var(--muted)', fontSize: 12.5 }}>{k}</td><td>{v}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <Empty icon="💳" text="No subscription on record" />}
          </div>
        </div>

        <div className="card">
          <div className="card-h"><h3>Custom domains</h3></div>
          <div className="card-b">
            {tenant.domains?.length ? tenant.domains.map((d) => (
              <div key={d.id} className="row" style={{ padding: '5px 0' }}>
                <code>{d.hostname}</code>
                {!!d.is_primary && <span className="badge blue">primary</span>}
                <span className={'badge ' + (d.verified ? 'green' : 'amber')}>{d.verified ? 'verified' : 'unverified'}</span>
                <span className="badge gray">ssl {String(d.ssl_status || 'none').replace(/_/g, ' ')}</span>
              </div>
            )) : <Empty icon="🌐" text="No custom domains" />}
          </div>
        </div>
      </div>

      <div className="card" style={{ gridColumn: '1 / -1' }}>
        <div className="card-h"><h3>Lifecycle history</h3><span style={{ fontSize: 12.5, color: 'var(--muted)' }}>every state change, with its reason</span></div>
        <div className="table-wrap">
          <table className="tbl">
            <thead><tr><th>Change</th><th>Reason</th><th>By</th><th>When</th></tr></thead>
            <tbody>
              {tenant.statusHistory?.map((h, i) => (
                <tr key={i}>
                  <td>
                    {h.from_status ? <TenantBadge status={h.from_status} /> : <span style={{ color: 'var(--muted)' }}>new</span>}
                    {' → '}
                    <TenantBadge status={h.to_status} />
                  </td>
                  <td style={{ fontSize: 12.5, maxWidth: 380 }}>{h.reason || '—'}</td>
                  <td style={{ fontSize: 12.5 }}>{h.actor_name || '—'}</td>
                  <td style={{ fontSize: 12.5 }}>{fmtDate(h.created_at, true)}</td>
                </tr>
              ))}
              {!tenant.statusHistory?.length && (
                <tr><td colSpan={4} style={{ textAlign: 'center', color: 'var(--muted)', padding: 24 }}>No lifecycle changes yet</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ modules
function Modules({ tenant, onChanged }) {
  const toast = useToast();
  const { can } = usePlatform();
  const [rows, setRows] = useState(null);
  const [busy, setBusy] = useState(null);
  const [refusal, setRefusal] = useState(null);

  const load = useCallback(async () => {
    try {
      const { data } = await api.get('/platform/modules', { params: { tenantId: tenant.id } });
      setRows(data.data);
    } catch (e) { toast(errMsg(e), true); }
  }, [tenant.id, toast]);

  useEffect(() => { load(); }, [load]);

  const flip = async (m, enabled) => {
    setBusy(m.key); setRefusal(null);
    try {
      await api.put(`/platform/tenants/${tenant.id}/modules/${m.key}`, { enabled });
      toast(`${m.name} ${enabled ? 'enabled' : 'disabled'}`);
      await load();
      onChanged();
    } catch (e) {
      // A 409 carries the unmet dependencies; a 402 carries the plan. Both are
      // answers, not failures, so they are surfaced as such.
      const details = e?.response?.data?.details || {};
      setRefusal({ module: m, message: errMsg(e), dependencies: details.dependencies || [], entitlement: details.entitlement || null });
    } finally { setBusy(null); }
  };

  if (!rows) return <Spinner />;
  const byCategory = rows.reduce((acc, m) => { (acc[m.category || 'general'] = acc[m.category || 'general'] || []).push(m); return acc; }, {});
  const canManage = can('platform.plans.manage');

  return (
    <div>
      <div className="info-box mb">
        A module is available only if the company’s plan <em>includes</em> it <em>and</em> its
        dependencies are available <em>and</em> someone with
        {' '}<code>platform.plans.manage</code> has switched it on. Switching one off removes its API
        routes and screens for that company only — no data is deleted, and switching it back restores
        everything.
      </div>

      {Object.entries(byCategory).map(([category, mods]) => (
        <div className="card mb" key={category}>
          <div className="card-h">
            <h3 style={{ textTransform: 'capitalize' }}>{category}</h3>
            <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>{mods.filter((m) => m.enabled).length} available / {mods.length}</span>
          </div>
          <div className="table-wrap">
            <table className="tbl">
              <thead><tr><th>Module</th><th>Requires</th><th>On the plan</th><th>State</th><th></th></tr></thead>
              <tbody>
                {mods.map((m) => (
                  <tr key={m.key}>
                    <td>
                      <strong>{m.name}</strong>
                      <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{m.key}</div>
                    </td>
                    <td style={{ fontSize: 12, color: 'var(--muted)' }}>{m.requires?.length ? m.requires.join(', ') : '—'}</td>
                    <td>{m.entitled ? <span className="badge green">yes</span> : <span className="badge gray">no</span>}</td>
                    <td>
                      {m.available
                        ? <span className="badge green">Available</span>
                        : <span className="badge amber" title={m.reason || ''}>Blocked</span>}
                      {m.configured && m.available && <div style={{ fontSize: 11, color: 'var(--muted)' }}>switched on</div>}
                    </td>
                    <td className="actions">
                      {canManage && (
                        <Toggle
                          checked={m.enabled}
                          disabled={busy === m.key}
                          onChange={(v) => flip(m, v)}
                          label={`Toggle ${m.name}`}
                        />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}

      {refusal && (
        <Modal title={`${refusal.module.name} was not changed`} onClose={() => setRefusal(null)}
          footer={<button className="btn" onClick={() => setRefusal(null)}>Understood</button>}>
          <p style={{ fontSize: 13.5 }}>{refusal.message}</p>
          {refusal.dependencies?.length > 0 && (
            <div className="error-box">
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {refusal.dependencies.map((d) => (
                  <li key={d.module}><strong>{d.name}</strong> — {d.reason}</li>
                ))}
              </ul>
            </div>
          )}
          {refusal.entitlement && (
            <p className="hint" style={{ marginTop: 12 }}>
              Either upgrade the company’s plan, or grant <code>{refusal.entitlement}</code> as a
              tenant override on the Entitlements tab.
            </p>
          )}
        </Modal>
      )}
    </div>
  );
}

// ------------------------------------------------------------- entitlements
function Entitlements({ tenant, onChanged }) {
  const toast = useToast();
  const { can } = usePlatform();
  const [data, setData] = useState(null);
  const [creating, setCreating] = useState(false);
  const [explain, setExplain] = useState(null);

  const load = useCallback(async () => {
    try {
      const { data: res } = await api.get(`/platform/tenants/${tenant.id}/entitlements`);
      setData(res.data);
    } catch (e) { toast(errMsg(e), true); }
  }, [tenant.id, toast]);

  useEffect(() => { load(); }, [load]);

  const revoke = async (o) => {
    try {
      await api.delete(`/platform/tenants/${tenant.id}/overrides/${o.id}`, { data: { reason: 'Revoked from the control plane' } });
      toast('Override revoked');
      load();
      onChanged();
    } catch (e) { toast(errMsg(e), true); }
  };

  if (!data) return <Spinner />;
  const canManage = can('platform.entitlements.manage');
  const active = data.overrides.filter((o) => o.status === 'active');
  // The resolver returns overrides keyed by entitlement_id (that is how it
  // applies them), so the label is joined back on from the resolved list.
  const byId = new Map(data.entitlements.map((e) => [e.id, e]));

  return (
    <div>
      <PageHeader
        title="Effective entitlements"
        sub={`Resolved from the ${data.plan?.name || tenant.plan} plan, then any active tenant override. This is the same resolution the API applies on every request.`}
        actions={canManage ? <button className="btn sm" onClick={() => setCreating(true)}>+ Override</button> : null}
      />

      {data.readOnly && (
        <div className="error-box mb">
          This company is <strong>{String(tenant.status).replace(/_/g, ' ')}</strong>, so it is
          read-only: reads still work so the customer can see their own payroll, but every write is
          refused with 402. The limits below still apply once it is reactivated.
        </div>
      )}

      <div className="card mb">
        <div className="card-h"><h3>Active overrides</h3><span className="badge purple">{active.length}</span></div>
        <div className="table-wrap">
          <table className="tbl">
            <thead><tr><th>Entitlement</th><th>Value</th><th>Reason</th><th>Window</th><th></th></tr></thead>
            <tbody>
              {data.overrides.map((o) => (
                <tr key={o.id} style={{ opacity: o.status === 'active' ? 1 : 0.55 }}>
                  <td>
                    <strong>{byId.get(o.entitlement_id)?.key || `#${o.entitlement_id}`}</strong>
                    <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{byId.get(o.entitlement_id)?.name || '—'}</div>
                  </td>
                  <td><span className="badge blue">{o.value}</span></td>
                  <td style={{ fontSize: 12.5, maxWidth: 300 }}>{o.reason}</td>
                  <td style={{ fontSize: 12 }}>
                    {o.effective_from ? fmtDate(o.effective_from) : 'now'} → {o.effective_until ? fmtDate(o.effective_until) : 'open-ended'}
                  </td>
                  <td className="actions">
                    {o.status === 'active'
                      ? (canManage && <button className="btn ghost sm" onClick={() => revoke(o)}>Revoke</button>)
                      : <span className="badge gray">{o.status}</span>}
                  </td>
                </tr>
              ))}
              {!data.overrides.length && (
                <tr><td colSpan={5}><Empty icon="🎚️" text="No overrides — this company is exactly on its plan" /></td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <div className="card-h"><h3>Everything this company can do</h3></div>
        <div className="table-wrap">
          <table className="tbl">
            <thead><tr><th>Capability</th><th>Effective value</th><th>From plan</th><th>Override</th><th>Source</th><th></th></tr></thead>
            <tbody>
              {data.entitlements.map((e) => (
                <tr key={e.key}>
                  <td>
                    <strong>{e.name}</strong>
                    <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{e.key}{e.period && e.period !== 'none' ? ` · per ${e.period}` : ''}</div>
                  </td>
                  <td>
                    {e.kind === 'boolean'
                      ? (e.value ? <span className="badge green">on</span> : <span className="badge gray">off</span>)
                      : e.unlimited
                        ? <span className="badge purple">unlimited</span>
                        : e.value === 0
                          ? <span className="badge gray">not included</span>
                          : <span className="badge blue">{e.value} {e.unit || ''}</span>}
                  </td>
                  <td style={{ fontSize: 12.5, color: 'var(--muted)' }}>{e.planValue ?? '—'}</td>
                  <td style={{ fontSize: 12.5, color: 'var(--muted)' }}>{e.overrideValue ?? '—'}</td>
                  <td><span className="badge gray">{String(e.source || '').replace(/_/g, ' ')}</span></td>
                  <td className="actions">
                    <button className="btn ghost sm" onClick={async () => {
                      try {
                        const { data: res } = await api.get(`/platform/tenants/${tenant.id}/entitlements/${e.key}/explain`);
                        setExplain(res.data);
                      } catch (ex) { toast(errMsg(ex), true); }
                    }}>Why?</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {creating && (
        <OverrideModal tenant={tenant} entitlements={data.entitlements} onClose={() => setCreating(false)}
          onCreated={() => { setCreating(false); load(); onChanged(); }} />
      )}

      {explain && (
        <Modal title={`Why: ${explain.entitlementKey}`} onClose={() => setExplain(null)}
          footer={<button className="btn" onClick={() => setExplain(null)}>Close</button>}>
          <div className="table-wrap">
            <table className="tbl">
              <tbody>
                {[
                  ['Available', explain.available ? 'Yes' : 'No'],
                  ['Effective limit', explain.unlimited ? 'Unlimited' : (explain.entitlementValue ?? '—')],
                  ['Current usage', explain.current != null ? num(explain.current) : '—'],
                  ['Percent used', explain.percentUsed != null ? `${explain.percentUsed}%` : '—'],
                  ['Plan value', explain.planValue ?? '—'],
                  ['Override', explain.override ?? '—'],
                  ['Status', explain.status || '—'],
                  ['Read-only company', explain.readOnly ? 'Yes' : 'No'],
                ].map(([k, v]) => (
                  <tr key={k}><td style={{ width: 180, color: 'var(--muted)', fontSize: 12.5 }}>{k}</td><td>{String(v)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          {explain.reason && <div className="error-box mt">{explain.reason}</div>}
          {explain.resolution && <div className="info-box mt"><strong>What would fix it:</strong> {explain.resolution}</div>}
        </Modal>
      )}
    </div>
  );
}

function OverrideModal({ tenant, entitlements, onClose, onCreated }) {
  const toast = useToast();
  const [form, setForm] = useState({ entitlementKey: '', value: '', reason: '', effectiveFrom: '', effectiveUntil: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const chosen = entitlements.find((e) => e.key === form.entitlementKey);

  const submit = async () => {
    setBusy(true); setError('');
    try {
      await api.post(`/platform/tenants/${tenant.id}/overrides`, {
        entitlementKey: form.entitlementKey,
        value: chosen?.kind === 'boolean' ? form.value === 'true' : form.value,
        reason: form.reason,
        effectiveFrom: form.effectiveFrom || null,
        effectiveUntil: form.effectiveUntil || null,
      });
      toast('Override applied');
      onCreated();
    } catch (e) { setError(errMsg(e)); }
    setBusy(false);
  };

  return (
    <Modal title={`Grant an override to ${tenant.name}`} onClose={onClose}
      footer={<><button className="btn secondary" onClick={onClose}>Cancel</button><button className="btn" onClick={submit} disabled={busy}>Apply</button></>}>
      <div className="info-box mb">
        An override sits on top of the plan for this company only, is always time-stamped and
        reversible, and never edits the plan everyone else is on.
      </div>
      <SelectField
        label="Entitlement"
        value={form.entitlementKey}
        onChange={(v) => setForm((f) => ({ ...f, entitlementKey: v, value: '' }))}
        options={entitlements.map((e) => ({ value: e.key, label: `${e.name} (${e.key})` }))}
      />
      {chosen?.kind === 'boolean' ? (
        <SelectField label="Value" value={form.value}
          onChange={(v) => setForm((f) => ({ ...f, value: v }))}
          options={[{ value: 'true', label: 'On' }, { value: 'false', label: 'Off' }]} />
      ) : (
        <TextField
          label={`Value${chosen?.unit ? ` (${chosen.unit})` : ''}`}
          value={form.value}
          onChange={(v) => setForm((f) => ({ ...f, value: v }))}
          hint={chosen ? `The plan currently allows ${chosen.value === null ? 'unlimited' : chosen.value}.` : ''}
        />
      )}
      <TextAreaField label="Reason *" value={form.reason} onChange={(v) => setForm((f) => ({ ...f, reason: v }))}
        hint="At least 5 characters. Recorded against your name in the platform audit." />
      <div className="form-grid">
        <TextField label="Effective from" type="date" value={form.effectiveFrom} onChange={(v) => setForm((f) => ({ ...f, effectiveFrom: v }))} />
        <TextField label="Effective until" type="date" value={form.effectiveUntil} onChange={(v) => setForm((f) => ({ ...f, effectiveUntil: v }))} hint="Leave blank for open-ended" />
      </div>
      {error && <div className="error-box mt">{error}</div>}
    </Modal>
  );
}

// -------------------------------------------------------------------- usage
function Usage({ tenant }) {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const { can } = usePlatform();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data: res } = await api.get(`/platform/tenants/${tenant.id}/usage`);
      setData(res.data);
    } catch (e) { toast(errMsg(e), true); }
    finally { setLoading(false); }
  }, [tenant.id, toast]);

  useEffect(() => { load(); }, [load]);

  if (loading && !data) return <Spinner />;
  if (!data) return <Empty text="Usage could not be read" />;

  const recompute = async () => {
    try {
      await api.post(`/platform/tenants/${tenant.id}/usage/recompute`);
      toast('Usage recomputed from source tables');
      load();
    } catch (e) { toast(errMsg(e), true); }
  };

  return (
    <div>
      <PageHeader
        title="Usage against plan limits"
        sub="Recomputed live from the underlying tables, not from a cached counter. A tenant at 100% is refused the next write by the API."
        actions={
          <>
            <button className="btn secondary sm" onClick={() => load()}>Refresh</button>
            {can('platform.usage.manage') && <button className="btn sm" onClick={recompute}>Recompute</button>}
          </>
        }
      />

      {!data.usage.length ? <Empty icon="📈" text="Nothing on this plan is metered" /> : (
        <div className="card">
          <div className="table-wrap">
            <table className="tbl">
              <thead><tr><th>Metric</th><th className="num">Used</th><th className="num">Limit</th><th style={{ width: 180 }}>Consumption</th><th>State</th></tr></thead>
              <tbody>
                {data.usage.map((u) => (
                  <tr key={u.key}>
                    <td>
                      <strong>{u.name}</strong>
                      <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{u.key}{u.period && u.period !== 'none' ? ` · ${u.periodKey}` : ''}</div>
                    </td>
                    <td className="num">{num(u.current)}</td>
                    <td className="num">{u.limit === 0 ? '—' : num(u.limit)}</td>
                    <td>
                      <div className="bar-track">
                        <div className="bar-fill" style={{ width: `${Math.min(100, u.percentUsed)}%` }} />
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--muted)' }}>{u.percentUsed}%</div>
                    </td>
                    <td><UsageBadge status={u.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------- subscription
function Subscription({ tenant, onChanged }) {
  const toast = useToast();
  const { can, plans, subscriptionStatuses } = usePlatform();
  const sub = tenant.subscription;
  const [transition, setTransition] = useState(null);
  const [planChange, setPlanChange] = useState(false);
  const [terms, setTerms] = useState(false);
  const [invoice, setInvoice] = useState(false);
  const [commercial, setCommercial] = useState(null);
  const canManage = can('platform.subscriptions.manage');

  if (!sub) return <Empty icon="💳" text="This company has no subscription" />;

  return (
    <div>
      <PageHeader
        title="Subscription"
        sub="The only way a subscription changes is through the transition graph, which refuses illegal jumps such as cancelled → active without a new plan."
        actions={canManage ? (
          <>
            <button className="btn secondary sm" onClick={() => setTerms(true)}>Edit terms</button>
            <button className="btn secondary sm" onClick={() => setInvoice(true)}>Issue invoice</button>
            <button className="btn secondary sm" onClick={() => setPlanChange(true)}>Change plan</button>
            {sub.status === 'trialing' && <button className="btn secondary sm" onClick={() => setCommercial('extend')}>Extend trial</button>}
            {['trialing', 'expired'].includes(sub.status) && <button className="btn secondary sm" onClick={() => setCommercial('convert')}>Convert to paid</button>}
            {can('platform.entitlements.manage') && <button className="btn secondary sm" onClick={() => setCommercial('addons')}>Add-ons</button>}
            {!['cancelled', 'expired'].includes(sub.status) && <button className="btn danger sm" onClick={() => setCommercial('cancel')}>Cancel…</button>}
            <button className="btn sm" onClick={() => setTransition(sub.status)}>Change state</button>
          </>
        ) : null}
      />

      <div className="grid c2">
        <div className="card">
          <div className="card-h"><h3>Current</h3><SubBadge status={sub.status} /></div>
          <div className="table-wrap">
            <table className="tbl">
              <tbody>
                {[
                  ['Subscription', `#${sub.id}`],
                  ['Plan', sub.plan_key],
                  ['Amount', `${money(sub.price_per_period)} / ${sub.billing_cycle || 'month'}`],
                  ['Quantity', num(sub.quantity || 1)],
                  ['Discount', sub.discount_pct ? `${sub.discount_pct}%` : '—'],
                  ['Period', `${fmtDate(sub.current_period_start)} → ${fmtDate(sub.current_period_end)}`],
                  ['Trial ends', sub.trial_ends_at ? fmtDate(sub.trial_ends_at) : '—'],
                  ['Trial extensions', sub.trial_extensions ? `${sub.trial_extensions} (last: ${sub.trial_extension_reason || '—'})` : '—'],
                  ['Converted from trial', sub.converted_at ? fmtDate(sub.converted_at) : '—'],
                  ['Cancel at period end', sub.cancel_at_period_end ? `Yes — effective ${fmtDate(sub.cancel_effective_at)} (${sub.cancel_reason || 'no reason'})` : 'No'],
                ].map(([k, v]) => (
                  <tr key={k}><td style={{ width: 190, color: 'var(--muted)', fontSize: 12.5 }}>{k}</td><td>{v}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card">
          <div className="card-h"><h3>Event history</h3></div>
          <div className="table-wrap" style={{ maxHeight: 420, overflowY: 'auto' }}>
            <table className="tbl">
              <thead><tr><th>Event</th><th>Change</th><th>Reason</th><th>When</th></tr></thead>
              <tbody>
                {(tenant.subscriptionEvents || []).map((e) => (
                  <tr key={e.id}>
                    <td style={{ fontSize: 12.5 }}>{String(e.event_type || '').replace(/_/g, ' ')}</td>
                    <td>{e.from_status ? <SubBadge status={e.from_status} /> : <span style={{ color: 'var(--muted)' }}>—</span>} → {e.to_status ? <SubBadge status={e.to_status} /> : null}</td>
                    <td style={{ fontSize: 12, maxWidth: 220 }}>{e.reason || '—'}</td>
                    <td style={{ fontSize: 12 }}>{fmtDate(e.created_at, true)}</td>
                  </tr>
                ))}
                {!(tenant.subscriptionEvents || []).length && (
                  <tr><td colSpan={4} style={{ textAlign: 'center', color: 'var(--muted)', padding: 24 }}>No events</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {transition && (
        <TransitionModal
          subscription={sub}
          statuses={subscriptionStatuses}
          onClose={() => setTransition(null)}
          onDone={() => { setTransition(null); toast('Subscription updated'); onChanged(); }}
        />
      )}

      {terms && (
        <TermsModal subscription={sub} onClose={() => setTerms(false)}
          onDone={() => { setTerms(false); toast('Terms updated'); onChanged(); }} />
      )}
      {invoice && (
        <InvoiceModal subscription={sub} onClose={() => setInvoice(false)}
          onDone={(inv) => { setInvoice(false); toast(`Issued ${inv.invoice_number} for ${money(inv.total)}`); onChanged(); }} />
      )}

      {planChange && (
        <PlanChangeModal
          subscription={sub}
          plans={plans}
          onClose={() => setPlanChange(false)}
          onDone={() => { setPlanChange(false); toast('Plan changed'); onChanged(); }}
        />
      )}
      {commercial && (
        <CommercialModal kind={commercial} subscription={sub} tenant={tenant}
          onClose={() => setCommercial(null)} onDone={() => { setCommercial(null); onChanged(); }} />
      )}
    </div>
  );
}

function TermsModal({ subscription, onClose, onDone }) {
  const [f, setF] = useState({
    discount_pct: String(subscription.discount_pct ?? 0),
    price_per_period: String(subscription.price_per_period ?? 0),
    trial_ends_at: '',
    reason: '',
  });
  const [error, setError] = useState('');
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v }));
  const trialing = subscription.status === 'trialing';
  const submit = async () => {
    const body = { reason: f.reason, discount_pct: Number(f.discount_pct), price_per_period: Number(f.price_per_period) };
    if (trialing && f.trial_ends_at) body.trial_ends_at = new Date(f.trial_ends_at).toISOString();
    try { await api.patch(`/platform/subscriptions/${subscription.id}/terms`, body); onDone(); } catch (e) { setError(errMsg(e)); }
  };
  return (
    <Modal title="Edit commercial terms" onClose={onClose}
      footer={<><button className="btn secondary" onClick={onClose}>Cancel</button><button className="btn" disabled={f.reason.trim().length < 5} onClick={submit}>Save</button></>}>
      <TextField label="Price per period" type="number" value={f.price_per_period} onChange={set('price_per_period')} />
      <TextField label="Discount %" type="number" value={f.discount_pct} onChange={set('discount_pct')} />
      {trialing && <TextField label="Extend trial to" type="date" value={f.trial_ends_at} onChange={set('trial_ends_at')} hint="Up to 120 days from today" />}
      <TextAreaField label="Reason *" value={f.reason} onChange={set('reason')} />
      {error && <div className="error-box mt">{error}</div>}
    </Modal>
  );
}

function InvoiceModal({ subscription, onClose, onDone }) {
  const [f, setF] = useState({ taxPct: '18', dueDays: '15', reason: '' });
  const [error, setError] = useState('');
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v }));
  const submit = async () => {
    try {
      const { data } = await api.post(`/platform/subscriptions/${subscription.id}/invoices`,
        { taxPct: Number(f.taxPct), dueDays: Number(f.dueDays), reason: f.reason });
      onDone(data.data);
    } catch (e) { setError(errMsg(e)); }
  };
  return (
    <Modal title="Issue invoice for the current period" onClose={onClose}
      footer={<><button className="btn secondary" onClick={onClose}>Cancel</button><button className="btn" disabled={f.reason.trim().length < 5} onClick={submit}>Issue</button></>}>
      <div className="info-box mb">
        {money(subscription.price_per_period)} less {subscription.discount_pct || 0}% discount, for {fmtDate(subscription.current_period_start)} → {fmtDate(subscription.current_period_end)}.
        One invoice per period; issuing it twice is refused.
      </div>
      <TextField label="Tax % (e.g. GST)" type="number" value={f.taxPct} onChange={set('taxPct')} />
      <TextField label="Due in (days)" type="number" value={f.dueDays} onChange={set('dueDays')} />
      <TextAreaField label="Reason *" value={f.reason} onChange={set('reason')} />
      {error && <div className="error-box mt">{error}</div>}
    </Modal>
  );
}

function TransitionModal({ subscription, statuses, onClose, onDone }) {
  const [status, setStatus] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    setBusy(true); setError('');
    try {
      await api.post(`/platform/subscriptions/${subscription.id}/transition`, { status, reason });
      onDone();
    } catch (e) { setError(errMsg(e)); }
    setBusy(false);
  };

  return (
    <Modal title="Change subscription state" onClose={onClose}
      footer={<><button className="btn secondary" onClick={onClose}>Cancel</button><button className="btn" onClick={submit} disabled={busy || !status}>Apply</button></>}>
      <div className="info-box mb">
        From <strong>{subscription.status.replace(/_/g, ' ')}</strong>. Only states the transition
        graph allows from here will be accepted; anything else comes back with the reason why.
      </div>
      <SelectField label="New state" value={status} onChange={setStatus}
        options={statuses.filter((s) => s !== subscription.status).map((s) => ({ value: s, label: s.replace(/_/g, ' ') }))} />
      {preview && (
        <div className={(preview.overages.length || preview.modulesLost.length ? 'error-box' : 'info-box') + ' mt'}>
          <strong>{preview.direction === 'downgrade' ? 'Downgrade' : 'Upgrade'}: {preview.from} → {preview.to}</strong>
          {preview.overages.map((o) => <div key={o.key}>{o.name}: using {o.current}, new limit {o.newLimit} — records stay, nothing more can be added.</div>)}
          {preview.modulesLost.map((m) => <div key={m.key}>{m.name} will be unavailable (its data is kept).</div>)}
          {!preview.overages.length && !preview.modulesLost.length && <div>No existing usage exceeds the new plan.</div>}
        </div>
      )}
      <TextAreaField label="Reason *" value={reason} onChange={setReason} hint="At least 5 characters" />
      {error && <div className="error-box mt">{error}</div>}
    </Modal>
  );
}

// ------------------------------------------------- trials, cancellation, add-ons
function CommercialModal({ kind, subscription, tenant, onClose, onDone }) {
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [days, setDays] = useState(7);
  const [mode, setMode] = useState('period_end');
  const [addon, setAddon] = useState('');
  const [qty, setQty] = useState(1);
  const [catalog, setCatalog] = useState([]);
  const [attached, setAttached] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (kind !== 'addons') return;
    api.get('/platform/addons').then(({ data }) => setCatalog(data.data)).catch(() => {});
    api.get(`/platform/tenants/${tenant.id}/addons`).then(({ data }) => setAttached(data.data)).catch(() => {});
  }, [kind, tenant.id]);

  const run = async (fn, done) => {
    setBusy(true); setError('');
    try { await fn(); toast(done); onDone(); } catch (e) { setError(errMsg(e)); }
    setBusy(false);
  };
  const id = subscription.id;
  const TITLES = { extend: 'Extend trial', convert: 'Convert trial to paid', cancel: 'Cancel subscription', addons: 'Add-ons' };
  const go = {
    extend: () => run(() => api.post(`/platform/subscriptions/${id}/trial/extend`, { days: Number(days), reason }), 'Trial extended'),
    convert: () => run(() => api.post(`/platform/subscriptions/${id}/trial/convert`, { reason }), 'Subscription is now active'),
    cancel: () => run(() => api.post(`/platform/subscriptions/${id}/cancel`, { mode, reason }), mode === 'immediate' ? 'Subscription cancelled' : 'Cancellation scheduled'),
    addons: () => run(() => api.post(`/platform/tenants/${tenant.id}/addons`, { addonKey: addon, quantity: Number(qty), reason }), 'Add-on attached'),
  }[kind];

  return (
    <Modal title={TITLES[kind]} onClose={onClose}
      footer={<><button className="btn secondary" onClick={onClose}>Close</button>
        <button className={'btn' + (kind === 'cancel' ? ' danger' : '')} disabled={busy || reason.trim().length < 5 || (kind === 'addons' && !addon)} onClick={go}>{kind === 'addons' ? 'Attach' : 'Confirm'}</button></>}>
      {kind === 'extend' && <TextField label="Days (1–30)" type="number" value={days} onChange={setDays} hint={`A trial can be extended at most twice. Used so far: ${subscription.trial_extensions || 0}.`} />}
      {kind === 'convert' && <div className="info-box mb">Starts the paid subscription now. Repeating this does nothing further.</div>}
      {kind === 'cancel' && (
        <>
          <SelectField label="When" value={mode} onChange={setMode} options={[{ value: 'period_end', label: 'At the end of the paid period' }, { value: 'immediate', label: 'Immediately' }]} />
          <div className="info-box mb">Nothing is deleted. The company becomes read-only and enters the normal export / retention / deletion lifecycle.</div>
        </>
      )}
      {kind === 'addons' && (
        <>
          {attached.filter((a) => a.status === 'active').map((a) => (
            <div key={a.id} className="spread" style={{ padding: '4px 0' }}><span>{a.name} × {a.quantity}</span>
              <button className="btn ghost sm" onClick={() => api.delete(`/platform/tenants/${tenant.id}/addons/${a.addon_key}`, { data: { reason: reason.trim().length >= 5 ? reason : 'Removed by operator' } }).then(() => { toast('Add-on removed'); onDone(); }).catch((e) => setError(errMsg(e)))}>Remove</button></div>
          ))}
          <SelectField label="Add-on" value={addon} onChange={setAddon} options={[{ value: '', label: '— choose —' }, ...catalog.filter((c) => c.active).map((c) => ({ value: c.addon_key, label: `${c.name} (${c.price_monthly}/mo)` }))]} />
          <TextField label="Quantity" type="number" value={qty} onChange={setQty} />
        </>
      )}
      <TextAreaField label="Reason *" value={reason} onChange={setReason} hint="At least 5 characters — recorded in the audit trail" />
      {error && <div className="error-box mt">{error}</div>}
    </Modal>
  );
}

function PlanChangeModal({ subscription, plans, onClose, onDone }) {
  const [planKey, setPlanKey] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState(null);

  // Show exactly what the move would do — overages that stay, modules that lose access — before it happens.
  useEffect(() => {
    if (!planKey) { setPreview(null); return undefined; }
    let live = true;
    api.post(`/platform/subscriptions/${subscription.id}/plan-preview`, { planKey })
      .then(({ data }) => live && setPreview(data.data)).catch(() => live && setPreview(null));
    return () => { live = false; };
  }, [planKey, subscription.id]);

  const submit = async () => {
    setBusy(true); setError('');
    try {
      await api.post(`/platform/subscriptions/${subscription.id}/plan`, { planKey, reason });
      onDone();
    } catch (e) { setError(errMsg(e)); }
    setBusy(false);
  };

  return (
    <Modal title="Move to a different plan" onClose={onClose}
      footer={<><button className="btn secondary" onClick={onClose}>Cancel</button><button className="btn" onClick={submit} disabled={busy || !planKey}>Move</button></>}>
      <div className="info-box mb">
        The company’s entitlements are re-resolved immediately from the new plan. Any tenant override
        in place survives, because an override is deliberately more specific than a plan.
      </div>
      <SelectField label="New plan" value={planKey} onChange={setPlanKey}
        options={plans.filter((p) => p.key !== subscription.plan_key).map((p) => ({
          value: p.key, label: `${p.name}${p.priceMonthly ? ` — ${p.priceMonthly}/mo` : ''}`,
        }))} />
      <TextAreaField label="Reason *" value={reason} onChange={setReason} hint="At least 5 characters" />
      {error && <div className="error-box mt">{error}</div>}
    </Modal>
  );
}

// ---------------------------------------------------------- data & lifecycle
const LIFECYCLE_ACTIONS = {
  active: 'Return the company to normal service — full read and write',
  trial: 'Put the company on a trial, restoring full access',
  past_due: 'Mark as unpaid; the company stays usable while billing is chased',
  grace_period: 'Extend read/write access during a payment grace window',
  suspended: 'Make the company read-only. Its staff keep reading their own payroll, but no writes succeed',
  cancelled: 'End the contract. The data is kept and the company is read-only',
  archived: 'Retire the company from active lists while keeping its data readable',
  deletion_pending: 'Begin the tracked deletion clock with a grace period',
};

function Data({ tenant, onChanged }) {
  const toast = useToast();
  const { can, tenantStatuses } = usePlatform();
  const { isPlatformSuperAdmin } = useAuth();
  const [statusModal, setStatusModal] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [deleting, setDeleting] = useState(false);

  if (!isPlatformSuperAdmin) {
    return (
      <div className="info-box">
        Lifecycle transitions, data exports and deletion requests are restricted to the Platform Super
        Admin. Everything else on this page remains available to your role.
      </div>
    );
  }

  return (
    <div>
      <div className="grid c3 mb">
        <div className="card">
          <div className="card-h"><h3>Lifecycle</h3></div>
          <div className="card-b">
            <p style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 0 }}>
              Suspension and cancellation are not deletion and not the same thing: both keep the data
              and make the company read-only, but only deletion can ever remove records.
            </p>
            <button className="btn sm" onClick={() => setStatusModal(true)}>Change lifecycle state</button>
          </div>
        </div>

        <div className="card">
          <div className="card-h"><h3>Data export</h3></div>
          <div className="card-b">
            <p style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 0 }}>
              Queues a tracked request with a reason. The platform sweeper assembles it in the
              background and the archive expires after seven days; downloading it needs a live
              support session.
            </p>
            <button className="btn secondary sm" disabled={!can('platform.data.export')} onClick={() => setExporting(true)}>Request an export</button>
          </div>
        </div>

        <div className="card">
          <div className="card-h"><h3>Deletion</h3></div>
          <div className="card-b">
            <p style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 0 }}>
              There is no one-click delete. This starts a tracked request with a grace period in which
              it can still be cancelled; the destructive step is a separate, deliberate act.
            </p>
            <button className="btn danger sm" disabled={!can('platform.data.delete')} onClick={() => setDeleting(true)}>Request deletion</button>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-h"><h3>Available lifecycle states</h3></div>
        <div className="table-wrap">
          <table className="tbl">
            <thead><tr><th>State</th><th>What it does</th><th>Current</th></tr></thead>
            <tbody>
              {tenantStatuses.map((s) => (
                <tr key={s}>
                  <td><TenantBadge status={s} /></td>
                  <td style={{ fontSize: 12.5, color: 'var(--muted)' }}>{LIFECYCLE_ACTIONS[s] || s.replace(/_/g, ' ')}</td>
                  <td>{s === tenant.status ? <span className="badge blue">current</span> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <ExportRequests tenantId={tenant.id} />

      {statusModal && (
        <StatusModal tenant={tenant} onClose={() => setStatusModal(false)}
          onDone={() => { setStatusModal(false); toast('Lifecycle updated'); onChanged(); }} />
      )}
      {exporting && <ExportModal tenant={tenant} onClose={() => setExporting(false)} onDone={onChanged} />}
      {deleting && <DeletionModal tenant={tenant} onClose={() => setDeleting(false)} onDone={onChanged} />}
    </div>
  );
}

function StatusModal({ tenant, onClose, onDone }) {
  const [status, setStatus] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    setBusy(true); setError('');
    try {
      await api.post(`/platform/tenants/${tenant.id}/status`, { status, reason });
      onDone();
    } catch (e) { setError(errMsg(e)); }
    setBusy(false);
  };

  return (
    <Modal title={`Change ${tenant.name}'s lifecycle state`} onClose={onClose}
      footer={<><button className="btn secondary" onClick={onClose}>Cancel</button><button className="btn" onClick={submit} disabled={busy || !status}>Apply</button></>}>
      <SelectField label="New state" value={status} onChange={setStatus}
        hint={LIFECYCLE_ACTIONS[status] || 'Pick a state to see what it does.'}
        options={Object.keys(LIFECYCLE_ACTIONS).map((s) => ({ value: s, label: s.replace(/_/g, ' ') }))} />
      <TextAreaField label="Reason *" value={reason} onChange={setReason}
        hint="At least 5 characters. Stored in the lifecycle history and the platform audit." />
      {error && <div className="error-box mt">{error}</div>}
    </Modal>
  );
}

const EXPORT_STATUS_META = {
  queued: ['gray', 'Queued'], running: ['blue', 'Running'], completed: ['green', 'Completed'],
  failed: ['red', 'Failed'],
};

/**
 * The queue, made visible. A request that silently never produced a file is the worst
 * possible outcome for a customer asking for their own data, so the state of every
 * tracked request is shown here rather than only in the database.
 */
function ExportRequests({ tenantId }) {
  const { can } = usePlatform();
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState('');

  const load = useCallback(() => {
    if (!can('platform.data.export')) return;
    api.get(`/platform/tenants/${tenantId}/exports`)
      .then(({ data: res }) => { setRows(res.data || []); setErr(''); })
      .catch((e) => setErr(errMsg(e)));
  }, [tenantId, can]);

  useEffect(() => { load(); }, [load]);

  if (!can('platform.data.export')) return null;

  return (
    <div className="card">
      <div className="card-h">
        <h3>Export requests</h3>
        <button className="btn secondary sm" onClick={load}>Refresh</button>
      </div>
      <div className="card-b">
        {err && <div className="error-box">{err}</div>}
        {!err && rows && rows.length === 0 && (
          <p className="muted" style={{ margin: 0 }}>No export has been requested for this company.</p>
        )}
        {!err && rows && rows.length > 0 && (
          <div className="table-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Requested</th><th>Data sets</th><th>State</th><th>Size</th>
                  <th>Reason</th><th>Expires</th><th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((j) => {
                  const [colour, label] = EXPORT_STATUS_META[j.status] || ['gray', j.status];
                  const sets = Object.keys(j.scope || {}).join(', ') || '—';
                  return (
                    <tr key={j.id}>
                      <td style={{ whiteSpace: 'nowrap' }}>{fmtDate(j.created_at)}</td>
                      <td style={{ fontSize: 12.5 }}>{sets}</td>
                      <td>
                        <span className={`badge ${colour}`}>{label}</span>
                        {j.status === 'failed' && j.error_message && (
                          <div style={{ fontSize: 11.5, color: 'var(--danger)', marginTop: 3 }}>
                            {j.error_message}
                          </div>
                        )}
                      </td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        {j.byte_size ? `${num(Math.round(j.byte_size / 1024))} KB` : '—'}
                      </td>
                      <td style={{ fontSize: 12.5, color: 'var(--muted)', maxWidth: 220 }}>{j.reason}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>{j.expires_at ? fmtDate(j.expires_at) : '—'}</td>
                      <td>
                        {j.status === 'completed' && (
                          <button className="btn secondary sm"
                            onClick={() => downloadFile(
                              `/api/platform/exports/${j.id}/download`,
                              `arthvex-export-${tenantId}-${j.id}.${j.format || 'json'}`,
                            ).catch((e) => setErr(errMsg(e)))}
                          >
                            Download
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {!err && !rows && <p className="muted" style={{ margin: 0 }}>Loading export requests…</p>}
      </div>
    </div>
  );
}

function ExportModal({ tenant, onClose, onDone }) {
  const toast = useToast();
  const [catalog, setCatalog] = useState([]);
  const [formats, setFormats] = useState(['json']);
  const [picked, setPicked] = useState({});
  const [format, setFormat] = useState('json');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // The catalogue is read from the server rather than hard-coded here, so a data set
  // added to the export worker appears in this console without a frontend release.
  useEffect(() => {
    api.get('/platform/exports/catalog')
      .then(({ data: res }) => {
        const d = res.data || {};
        setCatalog(Array.isArray(d) ? d : d.datasets || []);
        setFormats(Array.isArray(d.formats) && d.formats.length ? d.formats : ['json']);
      })
      .catch(() => setCatalog([]));
  }, []);

  const toggle = (key) => setPicked((p) => {
    const next = { ...p };
    if (next[key]) delete next[key]; else next[key] = true;
    return next;
  });

  const chosen = Object.keys(picked);

  const submit = async () => {
    setBusy(true); setError('');
    try {
      await api.post(`/platform/tenants/${tenant.id}/exports`, {
        scope: picked, format, reason,
      });
      toast('Export queued — it will be assembled in the background');
      onClose();
      onDone?.();
    } catch (e) { setError(errMsg(e)); }
    setBusy(false);
  };

  return (
    <Modal title="Request a data export" onClose={onClose}
      footer={<><button className="btn secondary" onClick={onClose}>Cancel</button><button className="btn" onClick={submit} disabled={busy || !chosen.length || reason.trim().length < 5 || (format === 'csv' && chosen.length > 1)}>Request</button></>}>
      <div className="info-box mb">
        This queues a tracked job, audited against your name. The platform sweeper assembles it in
        the background rather than inside this request, so a large export cannot exhaust a single
        HTTP connection. Downloading the finished archive still requires a live support session for
        this company.
      </div>
      <div className="field">
        <label>Data sets</label>
        {catalog.map((d) => (
          <CheckField
            key={d.key}
            checked={!!picked[d.key]}
            onChange={() => toggle(d.key)}
            label={<>{d.label}{d.sensitive && <span className="badge amber" style={{ marginLeft: 6 }}>sensitive</span>}</>}
          />
        ))}
        <span className="hint">
          {chosen.length} selected. Only the data sets you pick are read.
        </span>
      </div>
      <SelectField label="Format" value={format} onChange={setFormat}
        hint={format === 'csv' && chosen.length > 1
          ? 'CSV holds one table, so it is only available for a single data set.'
          : undefined}
        options={formats.map((f) => ({
          value: f,
          label: f === 'json' ? 'JSON — one file, every data set' : 'CSV — a single flat table',
        }))} />
      {format === 'csv' && chosen.length > 1 && (
        <div className="error-box mb">Pick one data set for CSV, or switch back to JSON.</div>
      )}
      <TextAreaField label="Reason *" value={reason} onChange={setReason}
        hint="At least 5 characters. Recorded on the request and in the platform audit." />
      {error && <div className="error-box mt">{error}</div>}
    </Modal>
  );
}

function DeletionModal({ tenant, onClose, onDone }) {
  const toast = useToast();
  const nav = useNavigate();
  const { isPlatformSuperAdmin } = useAuth();
  const [mode, setMode] = useState('grace'); // 'grace' | 'now'
  const [reason, setReason] = useState('');
  const [graceDays, setGraceDays] = useState(30);
  const [password, setPassword] = useState('');
  const [confirmSlug, setConfirmSlug] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    setBusy(true); setError('');
    try {
      // The password is re-authentication, not authorisation: destroying a company
      // is irreversible, so we require the operator to prove who they are at the
      // moment of the click rather than trusting an earlier login.
      if (mode === 'now') {
        await api.post(`/platform/tenants/${tenant.id}/delete-now`, { reason, password, confirmSlug });
        toast('Company permanently deleted');
        onClose();
        nav('/platform/companies');
        return;
      }
      await api.post(`/platform/tenants/${tenant.id}/deletion-request`, {
        reason, graceDays: Number(graceDays), password,
      });
      setPassword('');
      toast('Deletion request recorded — the company can still be cancelled during the grace period');
      onClose();
      onDone();
    } catch (e) { setError(errMsg(e)); }
    setBusy(false);
  };

  const ready = reason.trim().length >= 10 && password.length > 0 && (mode === 'grace' || confirmSlug.trim() === tenant.slug);

  return (
    <Modal title={`Delete ${tenant.name}`} onClose={onClose}
      footer={<><button className="btn secondary" onClick={onClose}>Cancel</button>
        <button className="btn danger" onClick={submit} disabled={busy || !ready}>
          {busy ? 'Working…' : mode === 'now' ? 'Delete permanently' : 'Request deletion'}
        </button></>}>
      <div className="seg mb" role="tablist">
        <button type="button" className={mode === 'grace' ? 'on' : ''} onClick={() => setMode('grace')}>With grace period</button>
        {isPlatformSuperAdmin && (
          <button type="button" className={mode === 'now' ? 'on' : ''} onClick={() => setMode('now')}>Delete immediately</button>
        )}
      </div>
      {mode === 'grace' ? (
        <>
          <div className="error-box">
            This moves <strong>{tenant.name}</strong> to <code>deletion_pending</code> and starts a
            {` ${graceDays} `}-day grace period during which the request can be cancelled and the company
            restored. Nothing is erased until the grace period lapses and the platform sweeper purges it.
          </div>
          <TextField label="Grace period (days)" type="number" min={1} max={90} value={graceDays} onChange={(v) => setGraceDays(v)} />
        </>
      ) : (
        <>
          <div className="error-box">
            <strong>Irreversible.</strong> Every record and uploaded file belonging to {tenant.name} is
            erased now, with no grace period. The deletion is refused while the company still has a live
            subscription — cancel it first. The platform audit trail keeps a record that this happened.
          </div>
          <TextField label={`Type the company slug (${tenant.slug}) to confirm *`} value={confirmSlug} onChange={setConfirmSlug} />
        </>
      )}
      <TextAreaField label="Reason *" value={reason} onChange={setReason} hint="At least 10 characters" />
      <TextField
        label="Your password *" type="password" value={password} onChange={(v) => setPassword(v)}
        hint="Re-enter your own login password to confirm. This is never stored."
      />
      {error && <div className="error-box mt">{error}</div>}
    </Modal>
  );
}

// ------------------------------------------------------------ edit company
function EditCompanyModal({ tenant, onClose, onDone }) {
  const toast = useToast();
  const [f, setF] = useState({
    legalName: tenant.name || '', displayName: tenant.display_name || '',
    industry: tenant.industry || '', country: tenant.country || '', timezone: tenant.timezone || '',
    currency: tenant.currency || '', contactEmail: tenant.contact_email || '', contactPhone: tenant.contact_phone || '',
    reason: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (patch) => setF((x) => ({ ...x, ...patch }));
  const save = async () => {
    if (f.reason.trim().length < 5) { setError('A reason of at least 5 characters is required.'); return; }
    setBusy(true); setError('');
    try {
      await api.patch(`/platform/tenants/${tenant.id}`, f);
      toast('Company updated');
      onDone();
    } catch (e) { setError(errMsg(e)); }
    setBusy(false);
  };
  return (
    <Modal title={`Edit ${tenant.name}`} onClose={onClose} wide
      footer={<><button className="btn secondary" onClick={onClose}>Cancel</button>
        <button className="btn" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save changes'}</button></>}>
      <div className="form-grid">
        <TextField label="Legal name *" value={f.legalName} onChange={(v) => set({ legalName: v })} />
        <TextField label="Display name" value={f.displayName} onChange={(v) => set({ displayName: v })} />
        <TextField label="Industry" value={f.industry} onChange={(v) => set({ industry: v })} />
        <TextField label="Country (2-letter)" value={f.country} onChange={(v) => set({ country: v })} />
        <TextField label="Timezone" value={f.timezone} onChange={(v) => set({ timezone: v })} />
        <TextField label="Currency" value={f.currency} onChange={(v) => set({ currency: v })} />
        <TextField label="Contact email" value={f.contactEmail} onChange={(v) => set({ contactEmail: v })} />
        <TextField label="Contact phone" value={f.contactPhone} onChange={(v) => set({ contactPhone: v })} />
      </div>
      <TextAreaField label="Reason for this change *" value={f.reason} onChange={(v) => set({ reason: v })}
        hint="Recorded in the platform audit with the before/after values." />
      {error && <div className="error-box mt">{error}</div>}
    </Modal>
  );
}
