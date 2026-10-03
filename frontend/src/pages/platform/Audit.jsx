import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, fmtDate } from '../../api';
import { Empty, Modal, downloadFile, useToast } from '../../components/ui';
import { PageHeader, Pager, PlatformSection, useLoader, usePlatform } from './shared';

export default function PlatformAudit() {
  return (
    <PlatformSection perm="platform.audit.view">
      <Audit />
    </PlatformSection>
  );
}

const CATEGORIES = ['tenant', 'subscription', 'plan', 'entitlement', 'support', 'security', 'data', 'usage'];

const OUTCOME_COLOR = { success: 'green', failure: 'red', denied: 'amber' };

/**
 * What ARTHVEX did, to whom, and why.
 *
 * This is separate from the tenant `audit_logs` table on purpose: that trail
 * records what happened *inside* a company, this one records decisions ARTHVEX
 * made about a company — provisioning, suspension, plan edits, overrides and
 * support access. It is append-only and carries the reason field.
 */
function Audit() {
  const { can } = usePlatform();
  const toast = useToast();
  const [category, setCategory] = useState('');
  const [tenantId, setTenantId] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [detail, setDetail] = useState(null);

  const { data, meta, loading, reload } = useLoader(async () => {
    const { data } = await api.get('/platform/audit', {
      params: { category: category || undefined, tenantId: tenantId || undefined, q: q || undefined, page, limit: 50 },
    });
    return data;
  }, [category, tenantId, q, page]);

  const rows = data || [];

  const exportCsv = async () => {
    try {
      // Streamed by the server in keyset pages — not capped, not assembled in the browser.
      const qs = new URLSearchParams();
      if (category) qs.set('category', category);
      if (tenantId) qs.set('tenantId', tenantId);
      await downloadFile(`/api/platform/audit/export?${qs}`, `platform-audit-${new Date().toISOString().slice(0, 10)}.csv`);
      toast('Export downloaded');
    } catch (e) {
      toast(e?.message || 'Export failed', true);
    }
  };

  return (
    <div>
      <PageHeader
        title="Platform audit log"
        sub="Append-only. Every control-plane decision, with the reason given at the time and the request that carried it."
        actions={
          <>
            <button className="btn secondary sm" onClick={() => reload()}>Refresh</button>
            {can('platform.audit.export') && <button className="btn secondary sm" onClick={exportCsv} title="Exports every matching row, streamed by the server">Export CSV</button>}
          </>
        }
      />

      <div className="card mb">
        <div className="card-b" style={{ paddingBottom: 0 }}>
          <div className="row wrap">
            <div className="searchbox" style={{ minWidth: 240, flex: 1 }}>
              <input placeholder="Search action, reason or entity…" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
            </div>
            <input type="number" placeholder="Tenant #" value={tenantId} style={{ width: 110 }}
              onChange={(e) => { setTenantId(e.target.value); setPage(1); }} />
            <div className="row wrap">
              <button className={'btn sm ' + (category === '' ? '' : 'secondary')}
                onClick={() => { setCategory(''); setPage(1); }}>All</button>
              {CATEGORIES.map((c) => (
                <button key={c} className={'btn sm ' + (category === c ? '' : 'secondary')}
                  onClick={() => { setCategory(c); setPage(1); }}>{c}</button>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="table-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>When</th><th>Actor</th><th>Action</th><th>Category</th>
                <th>Target</th><th>Reason</th><th>Outcome</th>
              </tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={7} style={{ textAlign: 'center', color: 'var(--muted)', padding: 28 }}>Loading…</td></tr>}
              {!loading && !rows.length && (
                <tr><td colSpan={7}><Empty icon="📜" text="Nothing recorded for those filters" /></td></tr>
              )}
              {!loading && rows.map((r) => (
                <tr key={r.id} style={{ cursor: 'pointer' }} onClick={() => setDetail(r)}>
                  <td style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{fmtDate(r.created_at, true)}</td>
                  <td>
                    <strong style={{ fontSize: 12.5 }}>{r.actor_name || 'system'}</strong>
                    <div style={{ fontSize: 11, color: 'var(--muted)' }}>{String(r.actor_role || '').replace(/_/g, ' ')}</div>
                  </td>
                  <td><code style={{ fontSize: 11.5 }}>{r.action}</code></td>
                  <td><span className="badge gray">{r.category || '—'}</span></td>
                  <td style={{ fontSize: 12 }}>
                    {r.tenant_id
                      ? <Link to={`/platform/companies/${r.tenant_id}`} onClick={(e) => e.stopPropagation()}>#{r.tenant_id}</Link>
                      : <span style={{ color: 'var(--muted)' }}>platform</span>}
                    {r.entity_type && <div style={{ fontSize: 11, color: 'var(--muted)' }}>{r.entity_type} {r.entity_id}</div>}
                  </td>
                  <td style={{ fontSize: 12, maxWidth: 320 }}>{r.reason || '—'}</td>
                  <td><span className={'badge ' + (OUTCOME_COLOR[r.outcome] || 'gray')}>{r.outcome || 'success'}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Pager meta={meta} onPage={setPage} />
      </div>

      {detail && <AuditDetail row={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}

function AuditDetail({ row, onClose }) {
  const pretty = (v) => {
    if (v == null) return null;
    if (typeof v === 'string') { try { return JSON.stringify(JSON.parse(v), null, 2); } catch { return v; } }
    return JSON.stringify(v, null, 2);
  };

  return (
    <Modal title={row.action} onClose={onClose} wide
      footer={<button className="btn" onClick={onClose}>Close</button>}>
      <div className="table-wrap mb">
        <table className="tbl">
          <tbody>
            {[
              ['When', fmtDate(row.created_at, true)],
              ['Actor', `${row.actor_name || 'system'} (${row.actor_email || '—'})`],
              ['Role', String(row.actor_role || '—').replace(/_/g, ' ')],
              ['Category', row.category || '—'],
              ['Entity', `${row.entity_type || '—'} ${row.entity_id || ''}`.trim() || '—'],
              ['Tenant', row.tenant_id ? <Link to={`/platform/companies/${row.tenant_id}`}>#{row.tenant_id}</Link> : 'platform-wide'],
              ['Outcome', row.outcome || 'success'],
              ['Reason', row.reason || '—'],
              ['IP', row.ip || '—'],
              ['Request id', row.request_id || '—'],
            ].map(([k, v]) => (
              <tr key={k}><td style={{ width: 150, color: 'var(--muted)', fontSize: 12.5 }}>{k}</td><td>{v}</td></tr>
            ))}
          </tbody>
        </table>
      </div>

      {['before', 'after'].map((side) => {
        const json = pretty(row[`${side}_json`]);
        if (!json) return null;
        return (
          <div key={side} className="mb">
            <h4 style={{ fontSize: 12.5, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--muted)', margin: '0 0 6px' }}>{side}</h4>
            <pre className="code-block">{json}</pre>
          </div>
        );
      })}
    </Modal>
  );
}
