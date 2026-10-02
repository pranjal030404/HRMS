import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { api, errMsg } from '../../api';
import { Spinner, useToast } from '../../components/ui';

/**
 * Shared plumbing for the Administration Center.
 *
 * `/administration/meta` is the contract: it lists every section with the
 * permission behind it and whether the signed-in user may open it. The UI uses
 * that to decide what to draw — never as a substitute for the server, which
 * re-checks every single route independently.
 */
const MetaCtx = createContext(null);
export const useAdminMeta = () => useContext(MetaCtx);

/** Fetch meta once and share it with every child route. */
export function AdminShell() {
  const [meta, setMeta] = useState(null);
  const [error, setError] = useState(null);
  const toast = useToast();

  const load = useCallback(async () => {
    try {
      const { data } = await api.get('/administration/meta');
      setMeta(data.data);
      setError(null);
    } catch (e) {
      setError(errMsg(e));
      toast(errMsg(e), true);
    }
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  const value = useMemo(() => {
    const sections = meta?.sections || [];
    return {
      meta,
      error,
      loading: !meta && !error,
      reload: load,
      sections,
      accessible: sections.filter((s) => s.accessible),
      can: (key) => !!sections.find((s) => s.key === key)?.accessible,
      section: (key) => sections.find((s) => s.key === key) || null,
    };
  }, [meta, error, load]);

  return (
    <MetaCtx.Provider value={value}>
      <div className="admin-shell">
        <div className="admin-subnav">
          <span className="admin-subnav-label">Administration</span>
          <div className="admin-subnav-items">
            {value.sections.map((s) =>
              s.accessible ? (
                <NavLink
                  key={s.key}
                  to={s.path}
                  end={s.path === '/administration'}
                  className={({ isActive }) => 'admin-pill' + (isActive ? ' active' : '')}
                >
                  {s.label}
                </NavLink>
              ) : null
            )}
          </div>
        </div>
        {value.loading ? <Spinner /> : <Outlet />}
      </div>
    </MetaCtx.Provider>
  );
}

/**
 * Gate one section. `accessible` comes from the server, which answers with the
 * same predicate `requirePermission` uses — so the tab and the API never
 * disagree about what a role may do.
 */
export function AdminSection({ sectionKey, children }) {
  const { can, section, loading } = useAdminMeta();
  if (loading) return <Spinner />;
  if (!can(sectionKey)) {
    const s = section(sectionKey);
    return (
      <div className="card" style={{ padding: 40, textAlign: 'center' }}>
        <h3>Access denied</h3>
        <p style={{ color: 'var(--muted)', fontSize: 13.5 }}>
          <strong>{s?.label}</strong> needs <code>{s?.permission}</code>, which your roles do not include.
        </p>
      </div>
    );
  }
  return children;
}

/** Small helper: run a loader, track loading, surface errors once. */
export function useLoader(loader, deps = []) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const toast = useToast();
  const loaderRef = useCallback(loader, deps); // eslint-disable-line

  const reload = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const result = await loaderRef();
      setData(result);
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
  return { data, loading, error, reload, setData };
}

/** GET a list endpoint; returns `data` (always an array). */
export const listLoader = (url) => async () => {
  const { data } = await api.get(url);
  return data.data;
};

/** GET an object endpoint; returns `data`. */
export const getLoader = (url) => async () => {
  const { data } = await api.get(url);
  return data.data;
};

export function PageHeader({ title, sub, actions }) {
  return (
    <div className="spread mb" style={{ flexWrap: 'wrap', alignItems: 'flex-end' }}>
      <div>
        <h2 style={{ fontSize: 21, letterSpacing: '-0.01em' }}>{title}</h2>
        {sub && <p style={{ color: 'var(--muted)', fontSize: 13, marginTop: 3 }}>{sub}</p>}
      </div>
      {actions && <div className="row wrap">{actions}</div>}
    </div>
  );
}

/** A switch that works without extra CSS noise. */
export function Toggle({ checked, onChange, disabled, label }) {
  return (
    <label className="toggle" title={label}>
      <input type="checkbox" checked={!!checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="track"><span className="knob" /></span>
    </label>
  );
}

/** Read-only label/value pill used by the detail panels. */
export function Pill({ children, color }) {
  return <span className={'badge ' + (color || 'gray')}>{children}</span>;
}

export const num = (v) => Number(v || 0).toLocaleString('en-IN');

/** Group rows by a key — used by several summary views. */
export const groupBy = (rows, keyOf) =>
  (rows || []).reduce((acc, r) => {
    const k = keyOf(r);
    (acc[k] = acc[k] || []).push(r);
    return acc;
  }, {});

export const unique = (arr) => [...new Set(arr)];