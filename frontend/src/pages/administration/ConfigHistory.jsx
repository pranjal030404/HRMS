import React, { useState } from 'react';
import { api, errMsg, fmtDate } from '../../api';
import { useAuth } from '../../auth';
import DataTable from '../../components/DataTable';
import { Confirm, Empty, Modal, SelectField, Spinner, StatusBadge, TextField, useToast } from '../../components/ui';
import { AdminSection, PageHeader, listLoader, useLoader } from './shared';

const STATUS = [
  { value: 'draft', label: 'Draft' },
  { value: 'published', label: 'Published' },
  { value: 'superseded', label: 'Superseded' },
];

export default function AdminConfigHistory() {
  return (
    <AdminSection sectionKey="config">
      <ConfigHistory />
    </AdminSection>
  );
}

function ConfigHistory() {
  const { can } = useAuth();
  const toast = useToast();
  const { data, loading, reload } = useLoader(listLoader('/administration/config/versions'), []);
  const [viewing, setViewing] = useState(null);
  const [rolling, setRolling] = useState(null);
  const [creating, setCreating] = useState(false);

  const canManage = can('administration.config.manage');

  return (
    <div>
      <PageHeader
        title="Configuration History"
        sub="Every tracked configuration change, versioned and reversible."
        actions={canManage ? <button className="btn sm" onClick={() => setCreating(true)}>+ Snapshot</button> : null}
      />

      <DataTable
        rows={data}
        loading={loading}
        onRowClick={(row) => setViewing(row.id)}
        columns={[
          { key: 'config_key', label: 'Config key', render: (r) => <code style={{ fontSize: 12 }}>{r.config_key}</code> },
          { key: 'module', label: 'Module' },
          { key: 'version', label: 'Version', align: 'right', sortValue: (r) => Number(r.version || 0) },
          { key: 'status', label: 'Status', render: (r) => <StatusBadge value={r.status} /> },
          { key: 'notes', label: 'Notes' },
          { key: 'effective_from', label: 'Effective from', render: (r) => (r.effective_from ? fmtDate(r.effective_from) : '—') },
          { key: 'created_at', label: 'Created', render: (r) => fmtDate(r.created_at, true) },
        ]}
        actions={(row) => (canManage ? <button className="btn ghost sm" onClick={() => setRolling(row)}>Roll back</button> : null)}
      />

      {viewing && <VersionDetail id={viewing} onClose={() => setViewing(null)} />}
      {creating && <CreateVersion onClose={() => setCreating(false)} onDone={() => { setCreating(false); reload(); }} />}
      {rolling && (
        <Rollback
          version={rolling}
          onClose={() => setRolling(null)}
          onDone={() => { setRolling(null); reload(); }}
        />
      )}
    </div>
  );
}

function VersionDetail({ id, onClose }) {
  const { data, loading } = useLoader(
    async () => (await api.get(`/administration/config/versions/${id}`)).data.data,
    [id]
  );
  return (
    <Modal title={`${data?.config_key || 'Version'} v${data?.version ?? ''}`} onClose={onClose} wide>
      {loading && !data ? <Spinner /> : !data ? <Empty /> : (
        <>
          <div className="row wrap mb" style={{ gap: 6 }}>
            <StatusBadge value={data.status} />
            <span className="badge gray">{data.module}</span>
            <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>{fmtDate(data.created_at, true)}</span>
          </div>
          {data.notes && <p style={{ fontSize: 13 }}>{data.notes}</p>}
          <pre className="code-block">{JSON.stringify(data.config, null, 2)}</pre>
        </>
      )}
    </Modal>
  );
}

function CreateVersion({ onClose, onDone }) {
  const toast = useToast();
  const [form, setForm] = useState({ config_key: '', module: 'general', notes: '', config: '{}' });
  const submit = async () => {
    let parsed;
    try { parsed = JSON.parse(form.config); } catch (_) { toast('Config must be valid JSON', true); return; }
    try {
      await api.post('/administration/config/versions', {
        config_key: form.config_key, module: form.module, notes: form.notes, config: parsed,
      });
      toast('Snapshot created');
      onDone();
    } catch (e) { toast(errMsg(e), true); }
  };
  return (
    <Modal title="New configuration version" onClose={onClose}
      footer={<><button className="btn secondary" onClick={onClose}>Cancel</button><button className="btn" onClick={submit} disabled={!form.config_key}>Create</button></>}>
      <div className="form-grid">
        <TextField label="Config key" value={form.config_key} onChange={(v) => setForm((f) => ({ ...f, config_key: v }))} />
        <TextField label="Module" value={form.module} onChange={(v) => setForm((f) => ({ ...f, module: v }))} />
        <div style={{ gridColumn: '1 / -1' }}>
          <TextField label="Notes" value={form.notes} onChange={(v) => setForm((f) => ({ ...f, notes: v }))} />
        </div>
        <div className="field" style={{ gridColumn: '1 / -1' }}>
          <label>Config (JSON)</label>
          <textarea rows={6} value={form.config} onChange={(e) => setForm((f) => ({ ...f, config: e.target.value }))} />
        </div>
      </div>
    </Modal>
  );
}

/** Rollback never edits history: it appends a new published version. */
function Rollback({ version, onClose, onDone }) {
  const toast = useToast();
  const doRollback = async () => {
    try {
      await api.post(`/administration/config/versions/${version.id}/rollback`);
      toast(`Rolled back to v${version.version}`);
      onDone();
    } catch (e) { toast(errMsg(e), true); }
  };
  return (
    <Confirm
      title="Roll back configuration?"
      message={`The snapshot of ${version.config_key} v${version.version} is republished as a new version. History is preserved.`}
      onYes={doRollback}
      onClose={onClose}
    />
  );
}