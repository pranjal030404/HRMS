import React, { useState } from 'react';
import { api, downloadFile, errMsg } from '../../api';
import DataTable from '../../components/DataTable';
import { Confirm, Empty, Modal, SelectField, Spinner, Tabs, TextField, useToast } from '../../components/ui';
import { AdminSection, PageHeader, listLoader, num, useLoader } from './shared';

/** Mirrors BULK_OPERATIONS.users on the server — no `remove_role` there. */
const BULK_OPERATIONS = [
  { value: 'set_status:active', label: 'Activate logins' },
  { value: 'set_status:inactive', label: 'Deactivate logins' },
  { value: 'set_status:suspended', label: 'Suspend logins' },
  { value: 'set_status:disabled', label: 'Disable logins' },
  { value: 'assign_role:', label: 'Assign a role (replaces existing)' },
  { value: 'reset_password:', label: 'Reset password & force change' },
];

export default function AdminDataOps() {
  return (
    <AdminSection sectionKey="data">
      <DataOps />
    </AdminSection>
  );
}

function DataOps() {
  const [tab, setTab] = useState('bulk');
  return (
    <div>
      <PageHeader
        title="Bulk, Import & Export"
        sub="Move data in and out of the company, and change many records at once — always with a dry run first."
      />
      <Tabs
        tabs={[
          { key: 'bulk', label: 'Bulk operations' },
          { key: 'import', label: 'Import' },
          { key: 'export', label: 'Export' },
        ]}
        active={tab}
        onChange={setTab}
      />
      {tab === 'bulk' && <Bulk />}
      {tab === 'import' && <Import />}
      {tab === 'export' && <Export />}
    </div>
  );
}

/** Bulk changes over the user list, with a mandatory preview. */
function Bulk() {
  const toast = useToast();
  const { data, loading } = useLoader(listLoader('/administration/users?limit=100'), []);
  const [selected, setSelected] = useState([]);
  const [operation, setOperation] = useState('set_status:active');
  const [value, setValue] = useState('');
  const [plan, setPlan] = useState(null);
  const [applying, setApplying] = useState(false);

  const send = (dryRun) => api.post('/administration/bulk/users', {
    ids: selected,
    operation: operation.split(':')[0],
    value: operation.split(':')[1] || value || undefined,
    dry_run: dryRun,
  });

  const preview = async () => {
    try {
      const { data: d } = await send(true);
      setPlan({ dry: true, ...d.data });
    } catch (e) { toast(errMsg(e), true); }
  };

  const apply = async () => {
    setApplying(true);
    try {
      const { data: d } = await send(false);
      toast(`${d.data.affected} record(s) updated`);
      setPlan(null);
      setSelected([]);
    } catch (e) { toast(errMsg(e), true); }
    setApplying(false);
  };

  const toggle = (id) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  return (
    <div>
      <div className="card mb">
        <div className="card-h"><h3>Select records</h3><span style={{ fontSize: 12.5, color: 'var(--muted)' }}>{selected.length} selected of {num(data?.length || 0)}</span></div>
        <div className="table-wrap" style={{ maxHeight: 360, overflowY: 'auto' }}>
          <table className="tbl">
            <thead><tr><th></th><th>Name</th><th>Email</th><th>Role</th><th>Status</th></tr></thead>
            <tbody>
              {loading && <tr><td colSpan={5} style={{ textAlign: 'center', padding: 24, color: 'var(--muted)' }}>Loading…</td></tr>}
              {(data || []).map((u) => (
                <tr key={u.id}>
                  <td><input type="checkbox" checked={selected.includes(u.id)} onChange={() => toggle(u.id)} /></td>
                  <td>{u.name}</td>
                  <td>{u.email}</td>
                  <td>{(u.role || 'none').replace(/_/g, ' ')}</td>
                  <td>{u.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <div className="card-h"><h3>Operation</h3></div>
        <div className="card-b">
          <div className="form-grid">
            <SelectField
              label="What to do"
              value={operation}
              onChange={(v) => { setOperation(v); setPlan(null); }}
              options={BULK_OPERATIONS}
            />
            {operation.startsWith('assign_role:') && (
              <TextField label="Role id" type="number" value={value} onChange={setValue} hint="from the Roles page" />
            )}
          </div>
          <div className="row wrap" style={{ gap: 8 }}>
            <button className="btn" onClick={preview} disabled={!selected.length}>Preview change</button>
            {selected.length > 0 && <button className="btn ghost sm" onClick={() => { setSelected([]); setPlan(null); }}>Clear selection</button>}
          </div>
          <div className="info-box mt">
            A dry run reports exactly what would change and stops before writing. Bulk operations refuse to touch your
            own account, and never leave the company without an active owner.
          </div>
        </div>
      </div>

      {plan && (
        <Modal
          title={plan.dry ? 'Preview' : 'Apply change'}
          onClose={() => setPlan(null)}
          footer={plan.dry
            ? <><button className="btn secondary" onClick={() => setPlan(null)}>Cancel</button><button className="btn danger" onClick={apply} disabled={!plan.target || applying}>Apply to {plan.target} record(s)</button></>
            : <button className="btn" onClick={() => setPlan(null)}>Close</button>}
        >
          <p style={{ fontSize: 13.5 }}>{plan.planned || `${plan.affected} record(s) updated.`}</p>
          {(plan.skipped || []).length > 0 && (
            <div className="error-box">
              {plan.skipped.length} selected record(s) do not belong to this company and were skipped:
              {plan.skipped.slice(0, 10).join(', ')}
            </div>
          )}
          {plan.result?.issued && (
            <div>
              <b style={{ fontSize: 13 }}>Issued temporary passwords</b>
              <ul style={{ fontSize: 12.5, color: 'var(--muted)' }}>
                {plan.result.issued.map((i) => <li key={i.userId}>user #{i.userId}: <code>{i.tempPassword}</code></li>)}
              </ul>
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}

/** CSV / row import with a dry run that returns rejected rows and reasons. */
function Import() {
  const toast = useToast();
  const { data: sets } = useLoader(listLoader('/administration/data-sets'), []);
  const [entity, setEntity] = useState('');
  const [csv, setCsv] = useState('');
  const [mode, setMode] = useState('create');
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);

  const spec = (sets || []).find((s) => s.key === entity);

  const run = async (dryRun) => {
    if (!csv.trim()) return;
    setBusy(true);
    try {
      const { data } = await api.post(`/administration/import/${entity}`, { csv, dry_run: dryRun, mode });
      setResult(data.data);
      if (!dryRun) toast('Import applied');
    } catch (e) { toast(errMsg(e), true); }
    setBusy(false);
  };

  return (
    <div className="grid c2">
      <div className="card">
        <div className="card-h"><h3>Upload</h3></div>
        <div className="card-b">
          <div className="form-grid">
            <SelectField
              label="Data set"
              value={entity}
              onChange={(v) => { setEntity(v); setResult(null); }}
              options={(sets || []).map((s) => ({ value: s.key, label: `${s.key}${s.canImport ? '' : ' (read only)'}` }))}
              placeholder="— Choose —"
            />
            <SelectField label="Mode" value={mode} onChange={setMode} options={[{ value: 'create', label: 'Create only' }, { value: 'upsert', label: 'Create or update' }]} />
          </div>
          {spec && (
            <p style={{ fontSize: 12.5, color: 'var(--muted)' }}>
              Columns: {spec.columns.join(', ')}. Required: {spec.required.join(', ') || 'none'}.
            </p>
          )}
          <div className="field">
            <label>CSV (first row = header)</label>
            <textarea rows={8} value={csv} onChange={(e) => setCsv(e.target.value)} placeholder={`${spec?.columns.slice(0, 5).join(',') || 'first_name,last_name'}`} />
          </div>
          <div className="row">
            <button className="btn" onClick={() => run(true)} disabled={busy || !csv.trim() || !entity || !spec?.canImport}>Dry run</button>
            <button className="btn danger" onClick={() => run(false)} disabled={busy || !csv.trim() || !entity || !spec?.canImport}>Import</button>
          </div>
          {spec && !spec.canImport && (
            <div className="error-box mt">You lack <code>administration.import.manage</code>, so this data set is read-only for you.</div>
          )}
        </div>
      </div>

      <div className="card">
        <div className="card-h"><h3>Result</h3></div>
        <div className="card-b">
          {!result ? <Empty icon="📄" text="Paste CSV and run a dry run first" /> : (
            <>
              <div className="row wrap mb" style={{ gap: 6 }}>
                <span className="badge blue">{num(result.received)} received</span>
                <span className="badge green">{num(result.valid)} valid</span>
                <span className="badge red">{num((result.rejected || []).length)} rejected</span>
                {!result.dryRun && <span className="badge purple">{num(result.created)} created</span>}
                {result.dryRun && <span className="badge amber">dry run — nothing written</span>}
              </div>
              {!!(result.rejected || []).length && (
                <div className="table-wrap">
                  <table className="tbl">
                    <thead><tr><th>Row</th><th>Reason</th></tr></thead>
                    <tbody>
                      {result.rejected.map((r, i) => (
                        <tr key={i}>
                          <td>{r.row ?? i + 1}</td>
                          <td style={{ color: 'var(--red)', fontSize: 12.5 }}>{r.reason || r.error}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Export() {
  const toast = useToast();
  const { data: sets } = useLoader(listLoader('/administration/data-sets'), []);
  return (
    <div className="grid c3">
      {(sets || []).map((s) => (
        <div className="card" key={s.key}>
          <div className="card-h"><h3 style={{ textTransform: 'capitalize' }}>{s.key}</h3></div>
          <div className="card-b">
            <p style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 0 }}>{s.columns.length} columns</p>
            <button
              className="btn sm"
              disabled={!s.canExport}
              onClick={async () => {
                try {
                  await downloadFile(`/administration/export/${s.key}`, `${s.key}.csv`);
                } catch (e) { toast(e.message || 'Export failed', true); }
              }}
            >
              Download CSV
            </button>
            {!s.canExport && <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 8 }}>You lack the read permission for this data set.</p>}
          </div>
        </div>
      ))}
    </div>
  );
}