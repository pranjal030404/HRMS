import React, { useState } from 'react';
import { api, downloadFile, fmtDate } from '../../api';
import DataTable from '../../components/DataTable';
import { BarList, Empty, Modal, Spinner, useToast } from '../../components/ui';
import { AdminSection, PageHeader, num, useLoader } from './shared';

export default function AdminAudit() {
  return (
    <AdminSection sectionKey="audit">
      <Audit />
    </AdminSection>
  );
}

function Audit() {
  const [filters, setFilters] = useState({ module: '', action: '', actor: '', outcome: '', from: '', to: '' });
  const [page, setPage] = useState(1);
  const [viewing, setViewing] = useState(null);
  const { data, loading } = useLoader(
    async () => (await api.get('/administration/audit', { params: { ...filters, page, limit: 50 } })).data,
    [filters, page]
  );

  const rows = data?.data || [];
  const meta = data?.meta || {};
  const modules = data?.meta?.modules || [];
  const setF = (k) => (v) => { setFilters((f) => ({ ...f, [k]: v })); setPage(1); };

  const exportCsv = async () => {
    try {
      // Dedicated CSV endpoint (the list route also accepts ?format=csv).
      const params = new URLSearchParams(filters);
      await downloadFile(`/administration/audit/export?${params.toString()}`, 'audit-trail.csv');
    } catch (e) {
      // downloadFile throws a plain Error; surface it through the same channel
      toast(e.message || 'Export failed', true);
    }
  };

  return (
    <div>
      <PageHeader
        title="Audit Trail"
        sub="Every administrative change: who, what, when, from where, and whether it succeeded."
        actions={<button className="btn secondary sm" onClick={exportCsv}>Export CSV</button>}
      />

      <div className="form-grid mb">
        <div className="field">
          <label>Module</label>
          <select value={filters.module} onChange={(e) => setF('module')(e.target.value)}>
            <option value="">All</option>
            {modules.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>
        <div className="field">
          <label>Action contains</label>
          <input value={filters.action} placeholder="role.create" onChange={(e) => setF('action')(e.target.value)} />
        </div>
        <div className="field">
          <label>Actor</label>
          <input value={filters.actor} placeholder="name" onChange={(e) => setF('actor')(e.target.value)} />
        </div>
        <div className="field">
          <label>Outcome</label>
          <select value={filters.outcome} onChange={(e) => setF('outcome')(e.target.value)}>
            <option value="">All</option>
            <option value="success">success</option>
            <option value="failure">failure</option>
          </select>
        </div>
        <div className="field">
          <label>From</label>
          <input type="date" value={filters.from} onChange={(e) => setF('from')(e.target.value)} />
        </div>
        <div className="field">
          <label>To</label>
          <input type="date" value={filters.to} onChange={(e) => setF('to')(e.target.value)} />
        </div>
      </div>

      <DataTable
        rows={rows}
        loading={loading}
        pageSize={50}
        onRowClick={(row) => setViewing(row.id)}
        columns={[
          { key: 'created_at', label: 'When', render: (r) => fmtDate(r.created_at, true) },
          { key: 'actor_name', label: 'Actor', render: (r) => (r.actor_name || 'system') },
          { key: 'action', label: 'Action', render: (r) => <code style={{ fontSize: 12 }}>{r.action}</code> },
          { key: 'module', label: 'Module' },
          { key: 'entity_type', label: 'Entity', render: (r) => (r.entity_type ? `${r.entity_type} #${r.entity_id ?? ''}` : '—') },
          { key: 'ip', label: 'IP' },
          { key: 'outcome', label: 'Outcome', render: (r) => <span className={'badge ' + (r.outcome === 'failure' ? 'red' : 'green')}>{r.outcome || 'success'}</span> },
        ]}
        emptyText="No audit entries match"
      />

      {meta?.pages > 1 && (
        <div className="spread mt">
          <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>
            Page {meta.page} of {meta.pages} — {num(meta.total)} entries
          </span>
          <div className="row">
            <button className="btn sm secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>Prev</button>
            <button className="btn sm secondary" disabled={page >= meta.pages} onClick={() => setPage(page + 1)}>Next</button>
          </div>
        </div>
      )}

      <div className="mt"><Stats /></div>

      {viewing && <AuditDetail id={viewing} onClose={() => setViewing(null)} />}
    </div>
  );
}

function Stats() {
  const { data } = useLoader(
    async () => (await api.get('/administration/audit/stats', { params: { days: 30 } })).data.data,
    []
  );
  if (!data) return null;
  return (
    <div className="grid c3">
      <div className="card">
        <div className="card-h"><h3>By module (30 days)</h3></div>
        <div className="card-b">
          <BarList data={(data.byModule || []).map((m) => ({ label: m.module || '—', value: Number(m.c) }))} />
        </div>
      </div>
      <div className="card">
        <div className="card-h"><h3>By day</h3></div>
        <div className="card-b">
          <BarList data={(data.byDay || []).slice(-14).map((d) => ({ label: String(d.day).slice(5), value: Number(d.c) }))} />
        </div>
      </div>
      <div className="card">
        <div className="card-h"><h3>Most active actors</h3></div>
        <div className="card-b">
          <BarList data={(data.byActor || []).map((a) => ({ label: a.actor_name || 'system', value: Number(a.c) }))} color="#6941c6" />
        </div>
      </div>
    </div>
  );
}

function AuditDetail({ id, onClose }) {
  const { data, loading } = useLoader(
    async () => (await api.get(`/administration/audit/${id}`)).data.data,
    [id]
  );
  return (
    <Modal title={`Audit entry #${id}`} onClose={onClose} wide>
      {loading && !data ? <Spinner /> : !data ? <Empty /> : (
        <>
          <div className="row wrap mb" style={{ gap: 6 }}>
            <span className="badge blue">{data.action}</span>
            <span className="badge gray">{data.module}</span>
            <span className={'badge ' + (data.outcome === 'failure' ? 'red' : 'green')}>{data.outcome || 'success'}</span>
          </div>
          <div className="table-wrap">
            <table className="tbl">
              <tbody>
                <tr><td>When</td><td>{fmtDate(data.created_at, true)}</td></tr>
                <tr><td>Actor</td><td>{data.actor_name || 'system'} <span style={{ color: 'var(--muted)' }}>({data.actor_role || '—'})</span></td></tr>
                <tr><td>Entity</td><td>{data.entity_type || '—'} {data.entity_id ? `#${data.entity_id}` : ''}</td></tr>
                <tr><td>IP</td><td>{data.ip || '—'}</td></tr>
                <tr><td>Request</td><td><code style={{ fontSize: 11.5 }}>{data.request_id || '—'}</code></td></tr>
              </tbody>
            </table>
          </div>
          {(data.before || data.after) && (
            <div className="grid c2 mt">
              <div>
                <b style={{ fontSize: 13 }}>Before</b>
                <pre className="code-block">{JSON.stringify(data.before ?? null, null, 2)}</pre>
              </div>
              <div>
                <b style={{ fontSize: 13 }}>After</b>
                <pre className="code-block">{JSON.stringify(data.after ?? null, null, 2)}</pre>
              </div>
            </div>
          )}
        </>
      )}
    </Modal>
  );
}