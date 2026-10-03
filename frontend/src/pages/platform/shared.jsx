import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../../auth';
import { api, errMsg } from '../../api';
import { useToast } from '../../components/ui';

const Icon = ({ d }) => <svg viewBox="0 0 24 24" width="17" height="17">{d}</svg>;

const I = {
  dash: <path d="M3 12l9-8 9 8M5 10v10h5v-6h4v6h5V10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />,
  bldg: <><path d="M4 21V6a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v15M12 11h7a1 1 0 0 1 1 1v9M2 21h20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /><path d="M7 9h2M7 13h2M7 17h2M15 15h2" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></>,
  card: <><rect x="2" y="5" width="20" height="14" rx="2" fill="none" stroke="currentColor" strokeWidth="1.8" /><path d="M2 10h20M6 15h4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></>,
  layers: <><path d="M12 3l9 5-9 5-9-5 9-5z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" /><path d="M3 13l9 5 9-5M3 17l9 5 9-5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" /></>,
  key: <><circle cx="8" cy="15" r="4" fill="none" stroke="currentColor" strokeWidth="1.8" /><path d="M11 12l8-8 2 2-2 2 2 2-2 2-2-2-2 2" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></>,
  gauge: <><path d="M12 21a9 9 0 1 0-9-9" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /><path d="M12 12l5-3" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></>,
  life: <path d="M12 21c-4-3-8-6.2-8-10a4.5 4.5 0 0 1 8-2.8A4.5 4.5 0 0 1 20 11c0 3.8-4 7-8 10z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />,
  users: <><circle cx="9" cy="8" r="3.5" fill="none" stroke="currentColor" strokeWidth="1.8" /><path d="M2.5 20c.6-3.6 3.2-5.5 6.5-5.5s5.9 1.9 6.5 5.5M16 5.2a3.5 3.5 0 0 1 0 6.6M18 14.8c2 .6 3.2 2.4 3.5 5.2" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></>,
  shield: <path d="M12 3l8 3v6c0 4.5-3.2 7.8-8 9-4.8-1.2-8-4.5-8-9V6l8-3z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />,
  scroll: <><path d="M5 3h11a2 2 0 0 1 2 2v13a3 3 0 0 0 3 3H8a3 3 0 0 1-3-3V3z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" /><path d="M9 8h6M9 12h6M9 16h4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></>,
};

/**
 * The control plane's own navigation.
 *
 * Every entry names the platform permission behind it. The predicate is the same
 * `can()` the API's `requirePermission` uses, so a Billing Admin never even sees
 * Support Access — and, more importantly, the server refuses it regardless of what
 * the browser drew.
 */
export const SECTIONS = [
  { group: 'Overview', key: 'dashboard', path: '/platform', label: 'Dashboard', perm: 'platform.dashboard.view', icon: I.dash },
  { group: 'Customers', key: 'companies', path: '/platform/companies', label: 'Companies', perm: 'platform.tenants.view', icon: I.bldg },
  { group: 'Customers', key: 'subscriptions', path: '/platform/subscriptions', label: 'Subscriptions', perm: 'platform.subscriptions.view', icon: I.card },
  { group: 'Customers', key: 'invoices', path: '/platform/invoices', label: 'Invoices & payments', perm: 'platform.subscriptions.view', icon: I.card },
  { group: 'Customers', key: 'tickets', path: '/platform/support-tickets', label: 'Support tickets', perm: 'platform.support.view', icon: I.life },
  { group: 'Customers', key: 'plans', path: '/platform/plans', label: 'Plans', perm: 'platform.plans.view', icon: I.layers },
  { group: 'Customers', key: 'entitlements', path: '/platform/entitlements', label: 'Entitlements & usage', perm: 'platform.entitlements.view', icon: I.gauge },
  { group: 'Access & security', key: 'support', path: '/platform/support-access', label: 'Support access', perm: 'platform.support.view', icon: I.life },
  { group: 'Access & security', key: 'operators', path: '/platform/operators', label: 'Operators', perm: 'platform.users.view', icon: I.users },
  { group: 'Access & security', key: 'roles', path: '/platform/roles', label: 'Roles & permissions', perm: 'platform.users.view', icon: I.shield },
  { group: 'Access & security', key: 'operations', path: '/platform/operations', label: 'Operations', perm: 'platform.dashboard.view', icon: I.gauge },
  { group: 'Access & security', key: 'security', path: '/platform/security', label: 'Platform security', perm: 'platform.security.view', icon: I.shield },
  { group: 'Access & security', key: 'audit', path: '/platform/audit', label: 'Audit log', perm: 'platform.audit.view', icon: I.scroll },
];

const ShellCtx = createContext(null);
export const usePlatform = () => useContext(ShellCtx);

/**
 * The control plane shell. It is deliberately *not* the tenant `Layout`: a
 * platform operator belongs to no company, has no employee record, and no
 * employee-facing notification feed. Drawing the HRMS chrome would imply access
 * they do not have.
 */
/** Header search over the one entity the API can search for every operator: companies. */
function GlobalSearch() {
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [hits, setHits] = useState([]);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (q.trim().length < 2) { setHits([]); return undefined; }
    let live = true;
    const t = setTimeout(() => {
      api.get('/platform/tenants', { params: { q: q.trim(), limit: 6 } })
        .then(({ data }) => live && setHits(data.data || []))
        .catch(() => live && setHits([]));
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [q]);
  const go = (t) => { setOpen(false); setQ(''); nav(`/platform/companies/${t.id}`); };
  return (
    <div className="gsearch" role="search">
      <input type="search" placeholder="Search companies…" aria-label="Search companies" value={q}
        onChange={(e) => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => { if (e.key === 'Enter' && hits[0]) go(hits[0]); if (e.key === 'Escape') setOpen(false); }} />
      {open && q.trim().length >= 2 && (
        <div className="gsearch-pop" role="listbox">
          {hits.map((t) => (
            <button key={t.id} type="button" role="option" onMouseDown={() => go(t)}>
              <strong>{t.name}</strong><span>{t.slug} · {String(t.status).replace(/_/g, ' ')}</span>
            </button>
          ))}
          {!hits.length && <div className="gsearch-empty">No company matches “{q.trim()}”</div>}
        </div>
      )}
    </div>
  );
}

export function PlatformShell() {
  const { me, logout, can } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem('platform.sidebar') === 'collapsed'; } catch { return false; }
  });
  const toggleCollapsed = () => setCollapsed((c) => {
    try { localStorage.setItem('platform.sidebar', c ? 'open' : 'collapsed'); } catch { /* storage unavailable */ }
    return !c;
  });
  const [showMenu, setShowMenu] = useState(false);
  const [catalog, setCatalog] = useState(null);

  // The catalogue drives the wizard's module picker and every status dropdown.
  // It needs `platform.dashboard.view`, which not every operator holds, so a
  // failure here is non-fatal — those screens fall back to what they already know.
  useEffect(() => {
    let stop = false;
    api.get('/platform/catalog')
      .then(({ data }) => { if (!stop) setCatalog(data.data); })
      .catch(() => {});
    return () => { stop = true; };
  }, []);

  const value = useMemo(() => ({
    catalog,
    sections: SECTIONS.filter((s) => can(s.perm)),
    can: (perm) => can(perm),
    tenantStatuses: catalog?.tenantStatuses || [],
    subscriptionStatuses: catalog?.subscriptionStatuses || [],
    plans: catalog?.plans || [],
    modules: catalog?.modules || [],
    accessTypes: catalog?.accessTypes || [],
  }), [catalog, can]);

  const title = SECTIONS.find((s) => s.path === loc.pathname)?.label
    || (loc.pathname.startsWith('/platform/companies/') ? 'Company' : 'ARTHVEX Platform');

  return (
    <ShellCtx.Provider value={value}>
      <div className={'shell platform-shell' + (collapsed ? ' collapsed' : '')}>
        <aside className={'sidebar platform-sidebar' + (sidebarOpen ? ' open' : '')} aria-label="Platform navigation">
          <div className="brand">
            <div className="logo">A</div>
            <b className="nav-text">ARTHVEX Platform</b>
          </div>
          <nav style={{ flex: 1, paddingBottom: 20 }}>
            {[...new Set(value.sections.map((x) => x.group))].map((g) => (
              <div className="nav-group" key={g}>
                <div className="nav-label">{g}</div>
                {value.sections.filter((x) => x.group === g).map((x) => (
                  <NavLink key={x.key} to={x.path} end={x.path === '/platform'} title={x.label}
                    className={({ isActive }) => 'nav-item' + (isActive ? ' active' : '')}
                    onClick={() => setSidebarOpen(false)}>
                    <Icon d={x.icon} /><span className="nav-text">{x.label}</span>
                  </NavLink>
                ))}
              </div>
            ))}
          </nav>
          <button type="button" className="collapse-btn" onClick={toggleCollapsed} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
            {collapsed ? '»' : '«'}<span className="nav-text"> Collapse</span>
          </button>
          <div className="platform-sidebar-foot">
            Not tenant data. To open a customer's records, take a
            {' '}<NavLink to="/platform/support-access">Support Access</NavLink> session first.
          </div>
        </aside>

        <div className="main">
          <header className="topbar">
            <button className="icon-btn burger" onClick={() => setSidebarOpen((s) => !s)}>☰</button>
            <nav className="crumbs" aria-label="Breadcrumb">
              <NavLink to="/platform">Platform</NavLink>
              {loc.pathname !== '/platform' && <><span>/</span><span className="cur">{title}</span></>}
            </nav>
            <div style={{ flex: 1 }} />
            {can('platform.tenants.view') && <GlobalSearch />}
            <div style={{ position: 'relative' }}>
              <button className="userchip" onClick={() => setShowMenu((s) => !s)}>
                <div className="avatar">{(me?.name || '?').split(' ').map((p) => p[0]).slice(0, 2).join('')}</div>
                <div className="meta" style={{ textAlign: 'left' }}>
                  <b>{me?.name}</b>
                  <span>{(me?.role || '').replace(/^platform_/, '').replace(/_/g, ' ')}</span>
                </div>
              </button>
              {showMenu && (
                <div className="menu-pop">
                  <div style={{ padding: '8px 12px', fontSize: 12, color: 'var(--muted)' }}>{me?.email}</div>
                  <div style={{ padding: '0 12px 8px', fontSize: 11.5, color: 'var(--muted)' }}>
                    {me?.permissions?.length || 0} platform permissions
                  </div>
                  <button className="mi" onClick={async () => { await logout(); nav('/login'); }}>Sign out</button>
                </div>
              )}
            </div>
          </header>
          <div className="content page-enter" key={loc.pathname}>
            <Outlet />
          </div>
        </div>
      </div>
    </ShellCtx.Provider>
  );
}

/**
 * Gate one control-plane section. Uses the same `can` predicate as the server's
 * `requirePermission`, so a hidden tab and a refused request always agree.
 */
export function PlatformSection({ perm, children }) {
  const { can } = usePlatform();
  if (!can(perm)) {
    return (
      <div className="card" style={{ padding: 40, textAlign: 'center' }}>
        <h3>Access denied</h3>
        <p style={{ color: 'var(--muted)', fontSize: 13.5 }}>
          Your platform role does not include <code>{perm}</code>. Platform roles are narrow by
          design — ask a Platform Super Admin if this is part of your job.
        </p>
      </div>
    );
  }
  return children;
}

/** Same loader contract as the Administration Center, reused by every page here. */
export function useLoader(loader, deps = []) {
  const [data, setData] = useState(null);
  const [raw, setRaw] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const toast = useToast();
  const loaderRef = useCallback(loader, deps); // eslint-disable-line

  const reload = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const result = await loaderRef();
      // List endpoints answer { data: [...], meta, ... }. Pages want the rows in `data`
      // and the envelope (meta, summary, …) in `raw`, so unwrap once, here.
      if (result && !Array.isArray(result) && typeof result === 'object' && Array.isArray(result.data)) {
        setRaw(result);
        setData(result.data);
      } else {
        setRaw(null);
        setData(result);
      }
      setError(null);
      return result;
    } catch (e) {
      setError(errMsg(e));
      if (!quiet) toast(errMsg(e), true);
      return null;
    } finally {
      setLoading(false);
    }
  }, [loaderRef, toast]);

  useEffect(() => { reload(); }, [reload]);
  return { data, raw, meta: raw?.meta, loading, error, reload, setData };
}

/** Loading placeholder with the shape of the page, instead of a bare spinner. */
export function PageSkeleton({ rows = 5 }) {
  return (
    <div aria-busy="true" aria-label="Loading">
      <div className="skel" style={{ height: 26, width: 260, marginBottom: 10 }} />
      <div className="skel" style={{ height: 14, width: 420, marginBottom: 22 }} />
      <div className="grid c4 mb">{[0, 1, 2, 3].map((i) => <div key={i} className="skel" style={{ height: 78 }} />)}</div>
      {Array.from({ length: rows }).map((_, i) => <div key={i} className="skel" style={{ height: 38, marginBottom: 8 }} />)}
    </div>
  );
}

export function PageHeader({ title, sub, actions }) {
  return (
    <div className="spread mb" style={{ flexWrap: 'wrap', alignItems: 'flex-end' }}>
      <div>
        <h2 style={{ fontSize: 21, letterSpacing: '-0.01em' }}>{title}</h2>
        {sub && <p style={{ color: 'var(--muted)', fontSize: 13, marginTop: 3, maxWidth: 780 }}>{sub}</p>}
      </div>
      {actions && <div className="row wrap">{actions}</div>}
    </div>
  );
}

export function Toggle({ checked, onChange, disabled, label }) {
  return (
    <label className="toggle" title={label}>
      <input type="checkbox" checked={!!checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="track"><span className="knob" /></span>
    </label>
  );
}

export const num = (v) => Number(v || 0).toLocaleString('en-IN');

/** Colours for the control plane's own state machines. */
export const TENANT_STATUS_META = {
  provisioning: ['blue', 'Provisioning'],
  trial: ['blue', 'Trial'],
  active: ['green', 'Active'],
  past_due: ['amber', 'Past due'],
  grace_period: ['amber', 'Grace period'],
  suspended: ['red', 'Suspended'],
  cancelled: ['gray', 'Cancelled'],
  archived: ['gray', 'Archived'],
  deletion_pending: ['purple', 'Deletion pending'],
  deleted: ['gray', 'Deleted'],
};

export const SUBSCRIPTION_STATUS_META = {
  incomplete: ['amber', 'Incomplete'],
  incomplete_expired: ['red', 'Incomplete, expired'],
  trialing: ['blue', 'Trialing'],
  active: ['green', 'Active'],
  past_due: ['amber', 'Past due'],
  grace_period: ['amber', 'Grace period'],
  suspended: ['red', 'Suspended'],
  cancelled: ['gray', 'Cancelled'],
  unpaid: ['red', 'Unpaid'],
  paused: ['gray', 'Paused'],
  expired: ['gray', 'Expired'],
};

export const USAGE_STATUS_META = {
  ok: ['green', 'Within limit'],
  warning: ['amber', 'Approaching limit'],
  critical: ['red', 'Near the limit'],
  hard_limit: ['red', 'Limit reached'],
  exceeded: ['red', 'Over limit'],
  excluded: ['gray', 'Not included'],
};

export const SESSION_STATUS_META = {
  active: ['green', 'Active'],
  expired: ['gray', 'Expired'],
  revoked: ['red', 'Revoked'],
  pending_approval: ['amber', 'Awaiting approval'],
};

/** `<StatusBadge>` with the control plane's own labels merged in. */
export function StateBadge({ value, map }) {
  const [color, label] = (map || {})[value] || ['gray', String(value || '—').replace(/_/g, ' ')];
  return <span className={'badge ' + color}>{label}</span>;
}

export const TenantBadge = ({ status }) => <StateBadge value={status} map={TENANT_STATUS_META} />;
export const SubBadge = ({ status }) => <StateBadge value={status} map={SUBSCRIPTION_STATUS_META} />;
export const UsageBadge = ({ status }) => <StateBadge value={status} map={USAGE_STATUS_META} />;
export const SessionBadge = ({ status }) => <StateBadge value={status} map={SESSION_STATUS_META} />;

/** A short explanation of what an entitlement value actually means. */
export function explainValue(e) {
  if (!e) return '—';
  if (e.unlimited) return 'Unmetered';
  if (e.kind === 'boolean') return e.value ? 'Included' : 'Not included';
  return `${e.value ?? 0}${e.unit ? ' ' + e.unit : ''}`;
}

/** Pagination control for the list endpoints that return `meta.pages`. */
export function Pager({ meta, onPage }) {
  if (!meta || meta.pages <= 1) return null;
  return (
    <div className="spread" style={{ padding: '10px 14px' }}>
      <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>
        Page {meta.page} of {meta.pages} · {num(meta.total)} total
      </span>
      <div className="row">
        <button className="btn sm secondary" disabled={meta.page <= 1} onClick={() => onPage(meta.page - 1)}>Prev</button>
        <button className="btn sm secondary" disabled={meta.page >= meta.pages} onClick={() => onPage(meta.page + 1)}>Next</button>
      </div>
    </div>
  );
}
