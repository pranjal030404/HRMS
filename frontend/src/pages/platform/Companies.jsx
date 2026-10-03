import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, errMsg, fmtDate } from '../../api';
import { useAuth } from '../../auth';
import { PlatformTable, EmptyState } from '../../components/PlatformTable';
import { Empty, Overlay, SelectField, TextField, useToast } from '../../components/ui';
import {
  PageHeader, Pager, PlatformSection, SubBadge, TenantBadge, num, useLoader, usePlatform,
} from './shared';

export default function PlatformCompanies() {
  return (
    <PlatformSection perm="platform.tenants.view">
      <Companies />
    </PlatformSection>
  );
}

function Companies() {
  const { isPlatformSuperAdmin } = useAuth();
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [plan, setPlan] = useState('');
  const [page, setPage] = useState(1);
  const [wizard, setWizard] = useState(false);
  const { tenantStatuses, plans } = usePlatform();

  const { data, meta, loading, error, reload } = useLoader(async () => {
    const { data } = await api.get('/platform/tenants', {
      params: { q: q || undefined, status: status || undefined, plan: plan || undefined, page, limit: 25 },
    });
    return data;
  }, [q, status, plan, page]);

  return (
    <div>
      <PageHeader
        title="Companies"
        sub="Provisioning, plan assignment and lifecycle state for every tenant on the platform. Opening a company's configuration or usage requires a live Support Access session."
        actions={
          <>
            <button className="btn secondary sm" onClick={() => reload()}>Refresh</button>
            {isPlatformSuperAdmin && (
              <button className="btn sm" onClick={() => setWizard(true)}>+ Provision a company</button>
            )}
          </>
        }
      />

      {!isPlatformSuperAdmin && (
        <div className="info-box mb">
          Provisioning a new company is restricted to the Platform Super Admin. Every other control-plane
          action available to your role is listed on the left.
        </div>
      )}

      <div className="card mb">
        <div className="card-b" style={{ paddingBottom: 0 }}>
          <div className="row wrap">
            <div className="searchbox" style={{ minWidth: 240, flex: 1 }}>
              <input placeholder="Search name or slug…" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
            </div>
            <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} style={{ width: 180 }}>
              <option value="">Any state</option>
              {tenantStatuses.map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
            </select>
            <select value={plan} onChange={(e) => { setPlan(e.target.value); setPage(1); }} style={{ width: 160 }}>
              <option value="">Any plan</option>
              {plans.map((p) => <option key={p.key} value={p.key}>{p.name}</option>)}
            </select>
          </div>
        </div>
      </div>

      <div className="card">
        <PlatformTable
          id="companies" rows={data || []} loading={loading} error={error} onRetry={reload}
          serverMeta={meta} onPage={setPage} hideSearch
          onRowClick={(t) => nav(`/platform/companies/${t.id}`)}
          columns={[
            { key: 'name', label: 'Company', sortable: true, render: (t) => (<>
              <Link to={`/platform/companies/${t.id}`} onClick={(e) => e.stopPropagation()}><strong>{t.name}</strong></Link>
              <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{t.slug} · created {fmtDate(t.created_at)}</div></>) },
            { key: 'plan', label: 'Plan', sortable: true, render: (t) => <span className="badge purple">{t.plan}</span> },
            { key: 'status', label: 'Lifecycle', sortable: true, render: (t) => <TenantBadge status={t.status} /> },
            { key: 'subscription_status', label: 'Subscription', sortable: true, render: (t) => (t.subscription_status ? <SubBadge status={t.subscription_status} /> : <span style={{ color: 'var(--muted)' }}>none</span>) },
            { key: 'employees', label: 'Employees', sortable: true, align: 'right', value: (t) => Number(t.employees), render: (t) => num(t.employees) },
            { key: 'active_users', label: 'Users', sortable: true, align: 'right', value: (t) => Number(t.active_users), render: (t) => num(t.active_users) },
            { key: 'legal_entities', label: 'Entities', sortable: true, align: 'right', value: (t) => Number(t.legal_entities), render: (t) => num(t.legal_entities) },
            { key: 'period_end', label: 'Renews', sortable: true, render: (t) => (t.period_end ? fmtDate(t.period_end) : '—') },
          ]}
          empty={<EmptyState title="No companies" text="No companies match those filters." action={<button className="btn secondary sm" onClick={() => { setQ(''); setStatus(''); setPlan(''); setPage(1); }}>Clear filters</button>} />}
        />
      </div>

      {wizard && <ProvisioningWizard onClose={() => setWizard(false)} onDone={() => { setWizard(false); reload(); }} />}
    </div>
  );
}

/**
 * The provisioning wizard (spec §18).
 *
 * All nine steps submit together as one transaction — the server either creates
 * the tenant, its roles, its first legal entity, its subscription and its owner
 * account, or writes nothing at all. The steps here exist so an operator can see
 * and check what they are about to create before they commit to it.
 */
const STEPS = [
  { n: 1, title: 'Company profile', hint: 'Legal name, slug, industry and the country whose statutory rules apply.' },
  { n: 2, title: 'Legal entity', hint: 'The first statutory registration unit. A tenant is not itself a legal entity.' },
  { n: 3, title: 'Plan', hint: 'Decides the entitlement baseline. Everything can be overridden per company afterwards.' },
  { n: 4, title: 'Modules', hint: 'Checked against the dependency graph before anything is written.' },
  { n: 5, title: 'Subscription', hint: 'Starts as a trial or an active paid subscription.' },
  { n: 6, title: 'First owner', hint: 'The account that can sign in and set everything else up.' },
  { n: 7, title: 'Branding', hint: 'Optional — a tenant can inherit the platform default.' },
  { n: 8, title: 'Review', hint: 'Nothing is written until you confirm.' },
];

function ProvisioningWizard({ onClose, onDone }) {
  const toast = useToast();
  const nav = useNavigate();
  const { plans, modules } = usePlatform();
  const [step, setStep] = useState(1);
  const [busy, setBusy] = useState(false);
  // The plan's actual grant list, fetched so the operator reviews what they are
  // about to hand over rather than a plan name they have to already know.
  const [planGrants, setPlanGrants] = useState(null);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const [form, setForm] = useState({
    legalName: '', displayName: '', slug: '', industry: '', country: 'IN', timezone: 'Asia/Kolkata', currency: 'INR',
    contactEmail: '', contactPhone: '',
    entityName: '', addressLine1: '', city: '', state: '', stateCode: '', pincode: '',
    planKey: 'trial', modules: [],
    billingCycle: 'monthly',
    ownerEmail: '', ownerName: '',
    primaryColor: '', logoUrl: '',
  });
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  const chosenPlan = plans.find((p) => p.key === form.planKey);
  // Mirrors services/tenant.js: the subscription opens trialing exactly when the
  // plan carries a trial, otherwise active. Shown rather than chosen, because it
  // is a consequence of the plan and not an independent decision.
  const willTrial = !!(chosenPlan && chosenPlan.trialDays > 0);

  const toggleModule = (key, deps = []) => {
    setForm((f) => {
      const has = f.modules.includes(key);
      if (has) return { ...f, modules: f.modules.filter((m) => m !== key) };
      // Selecting a dependent module pulls its prerequisites in, because the
      // server would reject the combination otherwise.
      return { ...f, modules: [...new Set([...deps, ...f.modules, key])] };
    });
  };

  const validate = (s) => {
    if (s === 1 && !form.legalName.trim()) return 'A legal name is required.';
    if (s === 2 && !form.entityName.trim()) return 'A legal entity name is required.';
    if (s === 6 && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.ownerEmail.trim())) return 'A valid owner email is required.';
    return '';
  };

  const next = () => {
    const v = validate(step);
    if (v) { setError(v); return; }
    setError('');
    setStep((s) => Math.min(STEPS.length, s + 1));
  };

  const submit = async () => {
    setBusy(true); setError('');
    try {
      const { data } = await api.post('/platform/tenants', {
        tenant: {
          legalName: form.legalName, displayName: form.displayName || null, slug: form.slug || null,
          industry: form.industry || null, country: form.country, timezone: form.timezone, currency: form.currency,
          contactEmail: form.contactEmail || null, contactPhone: form.contactPhone || null,
        },
        legalEntities: [{
          name: form.entityName, addressLine1: form.addressLine1 || null, city: form.city || null,
          state: form.state || null, stateCode: form.stateCode || null, pincode: form.pincode || null,
        }],
        planKey: form.planKey,
        modules: form.modules,
        billingCycle: form.billingCycle,
        owner: { email: form.ownerEmail.trim().toLowerCase(), name: form.ownerName || null },
        branding: {
          companyName: form.displayName || form.legalName,
          primaryColor: form.primaryColor || null,
          logoUrl: form.logoUrl || null,
        },
      });
      setResult(data.data);
      toast('Company provisioned');
    } catch (e) {
      setError(errMsg(e));
    }
    setBusy(false);
  };

  useEffect(() => {
    let live = true;
    api.get('/platform/plans')
      .then(({ data: res }) => {
        if (!live) return;
        const plan = (res.data || []).find((p) => p.plan_key === form.planKey);
        setPlanGrants(plan ? plan.entitlements || [] : []);
      })
      .catch(() => { if (live) setPlanGrants([]); });
    return () => { live = false; };
  }, [form.planKey]);

  if (result) {
    return (
      <Overlay>
        <div className="modal">
          <div className="modal-h"><h3>Company provisioned</h3></div>
          <div className="modal-b">
            <p style={{ fontSize: 13.5 }}>
              <strong>{result.name}</strong> is live on the <strong>{result.planKey}</strong> plan
              (tenant #{result.id}, slug <code>{result.slug}</code>).
            </p>
            <div className="info-box mt">
              The owner's temporary password is shown once. It is not stored in readable form, so
              copy it now — the owner should change it at first sign-in.
            </div>
            <div className="row mt" style={{ alignItems: 'stretch', flexDirection: 'column', gap: 6 }}>
              <div><span style={{ fontSize: 12.5, color: 'var(--muted)' }}>Owner email&nbsp;&nbsp;</span><code>{result.ownerEmail}</code></div>
              <div><span style={{ fontSize: 12.5, color: 'var(--muted)' }}>Temporary password&nbsp;&nbsp;</span><code style={{ fontSize: 14, fontWeight: 700 }}>{result.tempPassword}</code></div>
            </div>
          </div>
          <div className="modal-f">
            <button className="btn secondary" onClick={onDone}>Close</button>
            <button className="btn" onClick={() => { onDone(); nav(`/platform/companies/${result.id}`); }}>Open company</button>
          </div>
        </div>
      </Overlay>
    );
  }

  const current = STEPS.find((s) => s.n === step);

  return (
    <Overlay>
      <div className="modal wide">
        <div className="modal-h">
          <h3>Provision a company — step {step} of {STEPS.length}: {current.title}</h3>
          <button className="x-btn" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="modal-b">
          <p style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 0 }}>{current.hint}</p>

          {step === 1 && (
            <div className="form-grid">
              <TextField label="Legal name *" value={form.legalName} onChange={(v) => set({ legalName: v })} />
              <TextField label="Display name" value={form.displayName} onChange={(v) => set({ displayName: v })} hint="Shown in the sidebar and on the login page" />
              <TextField label="Slug" value={form.slug} onChange={(v) => set({ slug: v })} placeholder="derived from the legal name" />
              <TextField label="Industry" value={form.industry} onChange={(v) => set({ industry: v })} />
              <TextField label="Country" value={form.country} onChange={(v) => set({ country: v })} />
              <TextField label="Timezone" value={form.timezone} onChange={(v) => set({ timezone: v })} />
              <TextField label="Currency" value={form.currency} onChange={(v) => set({ currency: v })} />
              <TextField label="Contact email" value={form.contactEmail} onChange={(v) => set({ contactEmail: v })} />
              <TextField label="Contact phone" value={form.contactPhone} onChange={(v) => set({ contactPhone: v })} />
            </div>
          )}

          {step === 2 && (
            <div className="form-grid">
              <TextField label="Entity name *" value={form.entityName} onChange={(v) => set({ entityName: v })} />
              <TextField label="Address" value={form.addressLine1} onChange={(v) => set({ addressLine1: v })} />
              <TextField label="City" value={form.city} onChange={(v) => set({ city: v })} />
              <TextField label="State" value={form.state} onChange={(v) => set({ state: v })} />
              <TextField label="State code" value={form.stateCode} onChange={(v) => set({ stateCode: v })} />
              <TextField label="PIN code" value={form.pincode} onChange={(v) => set({ pincode: v })} />
            </div>
          )}

          {step === 3 && (
            <>
              <div className="grid c2">
                {plans.map((p) => (
                  <div
                    key={p.key}
                    className={'card' + (form.planKey === p.key ? ' plan-card selected' : ' plan-card')}
                    onClick={() => set({ planKey: p.key })}
                    style={{ cursor: 'pointer', padding: 14 }}
                  >
                    <div className="spread">
                      <strong style={{ fontSize: 14 }}>{p.name}</strong>
                      <span className="badge purple">{p.key}</span>
                    </div>
                    <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 4 }}>
                      {p.priceMonthly ? `${p.priceMonthly} / month` : 'custom pricing'}
                      {p.trialDays ? ` · ${p.trialDays}-day trial` : ''}
                    </div>
                  </div>
                ))}
              </div>
              {chosenPlan && (
                <p className="hint" style={{ marginTop: 12 }}>
                  The next step starts from the module set this plan includes. Leave it alone to accept
                  the plan's default, or change it here to grant something extra at launch.
                </p>
              )}
            </>
          )}

          {step === 4 && (
            <>
            <div className="row wrap" style={{ gap: 8 }}>
              {modules.map((m) => {
                const on = form.modules.includes(m.key);
                return (
                  <button
                    key={m.key}
                    className={'module-chip ' + (on ? 'on' : 'off')}
                    onClick={() => toggleModule(m.key, m.requires)}
                    type="button"
                    title={m.requires?.length ? `Requires: ${m.requires.join(', ')}` : m.description}
                  >
                    <span className="dot" />{m.name}
                  </button>
                );
              })}
            </div>
            <p className="hint" style={{ marginTop: 12 }}>
              {form.modules.length
                ? `${form.modules.length} of ${modules.length} modules selected.`
                : 'Nothing selected — the server will use the plan’s own default module set.'}
            </p>
            </>
          )}

          {step === 5 && (
            <div className="form-grid">
              <SelectField
                label="Billing cycle"
                value={form.billingCycle}
                onChange={(v) => set({ billingCycle: v })}
                options={[
                  { value: 'monthly', label: 'Monthly' },
                  { value: 'quarterly', label: 'Quarterly' },
                  { value: 'annual', label: 'Annual' },
                ]}
              />
              <div className="field">
                <label>Opens as</label>
                <div>
                  <span className={'badge ' + (willTrial ? 'blue' : 'green')} style={{ fontSize: 13, padding: '5px 11px' }}>
                    {willTrial ? 'trialing' : 'active'}
                  </span>
                </div>
                <span className="hint">
                  {willTrial
                    ? `${chosenPlan.name} carries a ${chosenPlan.trialDays}-day trial, so the subscription starts trialing.`
                    : chosenPlan
                      ? `${chosenPlan.name} has no trial period, so the subscription starts active and billable.`
                      : 'Pick a plan on step 3 to see how it opens.'}
                </span>
              </div>
              <div className="info-box" style={{ gridColumn: '1 / -1' }}>
                This is derived from the plan, not chosen separately — the server works it out the
                same way. Every later move goes through the transition graph, which rejects illegal
                jumps such as <code>cancelled → active</code> without a new plan.
              </div>
            </div>
          )}

          {step === 6 && (
            <div className="form-grid">
              <TextField label="Owner email *" value={form.ownerEmail} onChange={(v) => set({ ownerEmail: v })} hint="Must not already exist as an account" />
              <TextField label="Owner name" value={form.ownerName} onChange={(v) => set({ ownerName: v })} />
              <div className="info-box" style={{ gridColumn: '1 / -1' }}>
                The server generates a temporary password and returns it once. The owner is given the
                Company Owner role inside the new tenant and nothing on the platform itself.
              </div>
            </div>
          )}

          {step === 7 && (
            <div className="form-grid">
              <TextField label="Primary colour" value={form.primaryColor} onChange={(v) => set({ primaryColor: v })} placeholder="#1d4ed8" hint="Blank inherits the platform default" />
              <TextField label="Logo URL" value={form.logoUrl} onChange={(v) => set({ logoUrl: v })} />
            </div>
          )}

          {step === 8 && (
            <div className="table-wrap">
              <table className="tbl">
                <tbody>
                  {[
                    ['Legal name', form.legalName],
                    ['Slug', form.slug || '(derived)'],
                    ['Legal entity', form.entityName],
                    ['Registered address', [form.addressLine1, form.city, form.state, form.pincode].filter(Boolean).join(', ') || '—'],
                    ['Plan', chosenPlan?.name || form.planKey],
                    ['Modules', `${form.modules.length} selected`],
                    ['Opens as', willTrial ? 'trialing' : 'active'],
                    ['Billing', form.billingCycle],
                    ['Owner', form.ownerEmail],
                  ].map(([k, v]) => (
                    <tr key={k}><td style={{ width: 190, color: 'var(--muted)', fontSize: 12.5 }}>{k}</td><td><strong>{v || '—'}</strong></td></tr>
                  ))}
                </tbody>
              </table>

              <h4 style={{ margin: '18px 0 8px', fontSize: 13 }}>
                What {chosenPlan?.name || form.planKey} includes
              </h4>
              {planGrants === null ? (
                <p className="hint" style={{ margin: 0 }}>Loading the plan’s entitlements…</p>
              ) : planGrants.length === 0 ? (
                <p className="hint" style={{ margin: 0 }}>
                  This plan grants no explicit entitlements, so the company inherits the platform
                  default. Any limit can be overridden per company afterwards.
                </p>
              ) : (
                <div className="table-wrap">
                  <table className="tbl">
                    <thead><tr><th>Entitlement</th><th>Kind</th><th>Included</th></tr></thead>
                    <tbody>
                      {planGrants.map((g) => (
                        <tr key={g.entitlement_key}>
                          <td>{g.name}</td>
                          <td style={{ color: 'var(--muted)', fontSize: 12.5 }}>{g.kind}</td>
                          <td>
                            <strong>
                              {g.kind === 'metered' ? `${num(g.value)} ${g.unit}/mo`
                                : g.kind === 'cap' ? `${num(g.value)} ${g.unit}`
                                  : g.value ? 'Included' : 'Not included'}
                            </strong>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <p className="hint" style={{ marginTop: 8 }}>
                These are the baseline. Metered limits start at zero, so nothing is consumed by
                provisioning, and the first write that would exceed a cap is refused with the
                limit named.
              </p>
            </div>
          )}

          {error && <div className="error-box mt">{error}</div>}
        </div>
        <div className="modal-f">
          <div className="wizard-dots">
            {STEPS.map((s) => (
              <span key={s.n} className={'wizard-dot' + (s.n === step ? ' active' : s.n < step ? ' done' : '')} title={s.title} />
            ))}
          </div>
          <button className="btn secondary" onClick={step === 1 ? onClose : () => setStep((s) => s - 1)}>
            {step === 1 ? 'Cancel' : 'Back'}
          </button>
          {step < STEPS.length ? (
            <button className="btn" onClick={next}>Continue</button>
          ) : (
            <button className="btn" onClick={submit} disabled={busy}>{busy ? 'Provisioning…' : 'Provision'}</button>
          )}
        </div>
      </div>
    </Overlay>
  );
}
