import React, { useMemo, useState } from 'react';

/**
 * DataTable: search + sort + pagination + optional row actions + CSV export hook.
 * columns: [{key, label, render?, align?, sortValue?}]
 */
export default function DataTable({ columns, rows, loading, pageSize = 12, actions, emptyText, toolbar, onRowClick }) {
  const [q, setQ] = useState('');
  const [sort, setSort] = useState({ key: null, dir: 1 });
  const [page, setPage] = useState(1);

  const filtered = useMemo(() => {
    let out = rows || [];
    if (q.trim()) {
      const needle = q.toLowerCase();
      out = out.filter((r) =>
        columns.some((c) => String(r[c.key] ?? '').toLowerCase().includes(needle))
      );
    }
    if (sort.key) {
      const col = columns.find((c) => c.key === sort.key);
      out = [...out].sort((a, b) => {
        const av = col?.sortValue ? col.sortValue(a) : a[sort.key];
        const bv = col?.sortValue ? col.sortValue(b) : b[sort.key];
        return (av > bv ? 1 : av < bv ? -1 : 0) * sort.dir;
      });
    }
    return out;
  }, [rows, q, sort, columns]);

  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const pageSafe = Math.min(page, pages);
  const slice = filtered.slice((pageSafe - 1) * pageSize, pageSafe * pageSize);

  const toggleSort = (key) =>
    setSort((s) => (s.key === key ? { key, dir: -s.dir } : { key, dir: 1 }));

  return (
    <div className="card">
      <div className="card-h">
        <h3>{filtered.length} record{filtered.length === 1 ? '' : 's'}</h3>
        {toolbar}
        <div className="searchbox">
          <input placeholder="Search…" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
        </div>
      </div>
      <div className="table-wrap">
        <table className="tbl">
          <thead>
            <tr>
              {columns.map((c, ci) => (
                <th key={`${c.key}-${ci}`} style={{ cursor: 'pointer', textAlign: c.align || 'left' }} onClick={() => toggleSort(c.key)}>
                  {c.label}{sort.key === c.key ? (sort.dir > 0 ? ' ↑' : ' ↓') : ''}
                </th>
              ))}
              {actions && <th style={{ textAlign: 'right' }}></th>}
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={columns.length + (actions ? 1 : 0)} style={{ textAlign: 'center', color: 'var(--muted)', padding: 30 }}>Loading…</td></tr>
            )}
            {!loading && !slice.length && (
              <tr><td colSpan={columns.length + (actions ? 1 : 0)} style={{ textAlign: 'center', color: 'var(--muted)', padding: 30 }}>{emptyText || 'No records found'}</td></tr>
            )}
            {!loading && slice.map((row, i) => (
              <tr key={row.id ?? i} style={onRowClick ? { cursor: 'pointer' } : undefined} onClick={onRowClick ? () => onRowClick(row) : undefined}>
                {columns.map((c, ci) => (
                  <td key={`${c.key}-${ci}`} className={c.align === 'right' ? 'num' : ''}>
                    {c.render ? c.render(row) : (row[c.key] ?? '—')}
                  </td>
                ))}
                {actions && <td className="actions" onClick={(e) => e.stopPropagation()}>{actions(row)}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {pages > 1 && (
        <div className="spread" style={{ padding: '10px 14px' }}>
          <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>Page {pageSafe} of {pages}</span>
          <div className="row">
            <button className="btn sm secondary" disabled={pageSafe <= 1} onClick={() => setPage(pageSafe - 1)}>Prev</button>
            <button className="btn sm secondary" disabled={pageSafe >= pages} onClick={() => setPage(pageSafe + 1)}>Next</button>
          </div>
        </div>
      )}
    </div>
  );
}
