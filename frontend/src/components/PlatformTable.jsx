import React, { useEffect, useMemo, useRef, useState } from 'react';

/**
 * Compact, accessible table with client-side search, sort and pagination.
 *
 * columns: [{ key, label, sortable, render(row), value(row), align, width, hidden }]
 * Rows come from the caller; nothing is invented here. Column visibility is
 * remembered per `id` in localStorage (a convenience only — failures are ignored).
 */
export function PlatformTable({
  id, columns, rows, loading, error, onRetry, searchPlaceholder = 'Search…', pageSize = 15,
  rowKey = (r) => r.id, empty, toolbar, onRowClick, selectable, onSelectionChange,
  serverMeta, onPage, hideSearch,
}) {
  const storeKey = id ? `dt.${id}.hidden` : null;
  const [q, setQ] = useState('');
  const [sort, setSort] = useState({ key: null, dir: 'asc' });
  const [page, setPage] = useState(1);
  const [menu, setMenu] = useState(false);
  const [picked, setPicked] = useState(new Set());
  const [hidden, setHidden] = useState(() => {
    try { return new Set(JSON.parse(localStorage.getItem(storeKey) || '[]')); } catch { return new Set(); }
  });
  const menuRef = useRef(null);

  useEffect(() => {
    if (!menu) return undefined;
    const close = (e) => { if (menuRef.current && !menuRef.current.contains(e.target)) setMenu(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [menu]);

  const toggleCol = (key) => setHidden((h) => {
    const n = new Set(h); n.has(key) ? n.delete(key) : n.add(key);
    if (storeKey) { try { localStorage.setItem(storeKey, JSON.stringify([...n])); } catch { /* storage unavailable */ } }
    return n;
  });

  const cols = columns.filter((c) => !hidden.has(c.key));
  const valueOf = (c, r) => (c.value ? c.value(r) : r[c.key]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    let out = rows || [];
    if (needle) out = out.filter((r) => columns.some((c) => String(valueOf(c, r) ?? '').toLowerCase().includes(needle)));
    if (sort.key) {
      const c = columns.find((x) => x.key === sort.key);
      out = [...out].sort((a, b) => {
        const av = valueOf(c, a); const bv = valueOf(c, b);
        if (av == null && bv == null) return 0;
        if (av == null) return 1;
        if (bv == null) return -1;
        const cmp = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv), undefined, { numeric: true });
        return sort.dir === 'asc' ? cmp : -cmp;
      });
    }
    return out;
  }, [rows, q, sort, columns]); // eslint-disable-line react-hooks/exhaustive-deps

  // Server mode: the API already returned exactly one page and its meta; sorting stays
  // within that page and the footer drives the caller's own pager.
  const server = !!serverMeta;
  const pages = server ? Math.max(1, serverMeta.pages || 1) : Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = server ? (serverMeta.page || 1) : Math.min(page, pages);
  const view = server ? filtered : filtered.slice((safePage - 1) * pageSize, safePage * pageSize);
  const goPage = (n) => (server ? onPage?.(n) : setPage(n));
  useEffect(() => { setPage(1); }, [q, sort]);

  const flipSort = (c) => {
    if (!c.sortable) return;
    setSort((s) => (s.key === c.key ? { key: c.key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key: c.key, dir: 'asc' }));
  };
  const setSel = (next) => { setPicked(next); onSelectionChange?.(next); };
  const allOnPage = view.length > 0 && view.every((r) => picked.has(rowKey(r)));

  if (error) return <ErrorState message={error} onRetry={onRetry} />;

  return (
    <div className="dt">
      <div className="dt-bar">
        {!hideSearch && (
          <input type="search" className="dt-search" placeholder={searchPlaceholder} value={q}
            onChange={(e) => setQ(e.target.value)} aria-label="Search table" />
        )}
        <div className="row" style={{ marginLeft: 'auto', gap: 8 }}>
          {picked.size > 0 && <span className="badge blue">{picked.size} selected</span>}
          {toolbar}
          <div style={{ position: 'relative' }} ref={menuRef}>
            <button type="button" className="btn secondary sm" onClick={() => setMenu((m) => !m)} aria-haspopup="true" aria-expanded={menu}>Columns</button>
            {menu && (
              <div className="dt-menu" role="menu">
                {columns.map((c) => (
                  <label key={c.key} className="check" style={{ fontSize: 13 }}>
                    <input type="checkbox" checked={!hidden.has(c.key)} onChange={() => toggleCol(c.key)} /> {c.label || c.key}
                  </label>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="table-wrap">
        <table className="tbl">
          <thead>
            <tr>
              {selectable && (
                <th style={{ width: 36 }}>
                  <input type="checkbox" aria-label="Select all on this page" checked={allOnPage}
                    onChange={() => { const n = new Set(picked); view.forEach((r) => (allOnPage ? n.delete(rowKey(r)) : n.add(rowKey(r)))); setSel(n); }} />
                </th>
              )}
              {cols.map((c) => (
                <th key={c.key} style={{ textAlign: c.align, width: c.width }}
                  aria-sort={sort.key === c.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}>
                  {c.sortable ? (
                    <button type="button" className="dt-sort" onClick={() => flipSort(c)}>
                      {c.label}<span aria-hidden="true">{sort.key === c.key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ' ↕'}</span>
                    </button>
                  ) : c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading && Array.from({ length: 5 }).map((_, i) => (
              <tr key={`s${i}`}><td colSpan={cols.length + (selectable ? 1 : 0)}><div className="skel" style={{ height: 18 }} /></td></tr>
            ))}
            {!loading && view.map((r) => (
              <tr key={rowKey(r)} onClick={onRowClick ? () => onRowClick(r) : undefined}
                style={onRowClick ? { cursor: 'pointer' } : undefined}>
                {selectable && (
                  <td onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" aria-label="Select row" checked={picked.has(rowKey(r))}
                      onChange={() => { const n = new Set(picked); n.has(rowKey(r)) ? n.delete(rowKey(r)) : n.add(rowKey(r)); setSel(n); }} />
                  </td>
                )}
                {cols.map((c) => <td key={c.key} style={{ textAlign: c.align }} className={c.align === 'right' ? 'num' : undefined}>{c.render ? c.render(r) : (valueOf(c, r) ?? '—')}</td>)}
              </tr>
            ))}
            {!loading && !view.length && (
              <tr><td colSpan={cols.length + (selectable ? 1 : 0)}>
                {empty || <EmptyState title="Nothing to show" text={q ? 'No rows match your search.' : 'There are no records yet.'}
                  action={q ? <button className="btn secondary sm" onClick={() => setQ('')}>Clear search</button> : null} />}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="dt-foot">
        <span>{server ? (serverMeta.total ?? filtered.length) : filtered.length} {(server ? serverMeta.total : filtered.length) === 1 ? 'row' : 'rows'}</span>
        <div className="row" style={{ gap: 6 }}>
          <button type="button" className="btn secondary sm" disabled={safePage <= 1} onClick={() => goPage(safePage - 1)}>Previous</button>
          <span style={{ fontSize: 12.5 }}>Page {safePage} of {pages}</span>
          <button type="button" className="btn secondary sm" disabled={safePage >= pages} onClick={() => goPage(safePage + 1)}>Next</button>
        </div>
      </div>
    </div>
  );
}

export function EmptyState({ title = 'Nothing here', text, action }) {
  return (
    <div className="state" role="status">
      <div className="state-icon" aria-hidden="true">∅</div>
      <strong>{title}</strong>
      {text && <p>{text}</p>}
      {action}
    </div>
  );
}

export function ErrorState({ title = 'Unable to load this', message, onRetry }) {
  return (
    <div className="state error" role="alert">
      <div className="state-icon" aria-hidden="true">!</div>
      <strong>{title}</strong>
      {message && <p>{message}</p>}
      {onRetry && <button className="btn secondary sm" onClick={onRetry}>Retry</button>}
    </div>
  );
}
