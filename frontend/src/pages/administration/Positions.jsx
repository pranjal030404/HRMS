import React, { useState } from 'react';
import { api, errMsg, fmtDate } from '../../api';
import DataTable from '../../components/DataTable';
import { Confirm, Empty, Modal, SelectField, Spinner, StatusBadge, TextField, useToast } from '../../components/ui';
import { AdminSection, PageHeader, listLoader, num, useLoader } from './shared';

const STATUS = [
  { value: 'open', label: 'Open' },
  { value: 'filled', label: 'Filled' },
  { value: 'on_hold', label: 'On hold' },
  { value: 'closed', label: 'Closed' },
  { value: 'inactive', label: 'Inactive' },
];
const EMPLOYMENT = [
  { value: 'full_time', label: 'Full time' },
  { value: 'part_time', label: 'Part time' },
  { value: 'contract', label: 'Contract' },
  { value: 'intern', label: 'Intern' },
];

export default function AdminPositions() {
  return (
    <AdminSection sectionKey="positions">
      <Positions />
    </AdminSection>
  );
}

function Positions() {
  const toast = useToast();
  const { data, loading, reload } = useLoader(listLoader('/administration/positions'), []);
  const { data: structure } = useLoader(listLoader('/administration/organization/structure'), []);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({});
  const [deleting, setDeleting] = useState(null);
  const [pipelineFor, setPipelineFor] = useState(null);

  const depts = (structure?.businessUnits || []).flatMap((bu) => (bu.departments || []).map((d) => ({ ...d, unit: bu.name })));
  const deptOptions = depts.map((d) => ({ value: d.id, label: `${d.unit ? `${d.unit} › ` : ''}${d.name}` }));

  const openNew = () => { setEditing({}); setForm({ status: 'open', openings: '1', filled: '0', employment_type: 'full_time' }); };
  const openEdit = (row) => {
    setEditing(row);
    setForm({
      ...row,
      openings: String(row.openings ?? ''), filled: String(row.filled ?? ''),
    });
  };
  const setF = (k) => (v) => setForm((f) => ({ ...f, [k]: v === '' ? null : v }));

  const save = async () => {
    try {
      const payload = {
        title: form.title, code: form.code || null, description: form.description || null,
        department_id: form.department_id ?? null, employment_type: form.employment_type || null,
        openings: form.openings === null || form.openings === '' ? null : Number(form.openings),
        filled: form.filled === null || form.filled === '' ? null : Number(form.filled),
        status: form.status || 'open',
      };
      if (editing?.id) await api.put(`/administration/positions/${editing.id}`, payload);
      else await api.post('/administration/positions', payload);
      toast(editing?.id ? 'Position updated' : 'Position created');
      setEditing(null);
      reload();
    } catch (e) { toast(errMsg(e), true); }
  };

  const doDelete = async () => {
    try {
      await api.delete(`/administration/positions/${deleting.id}`);
      toast('Position deleted');
      reload();
    } catch (e) { toast(errMsg(e), true); }
  };

  return (
    <div>
      <PageHeader
        title="Positions"
        sub="Headcount, openings and the hiring pipeline behind each role."
        actions={<button className="btn sm" onClick={openNew}>+ Add position</button>}
      />
      <DataTable
        rows={data}
        loading={loading}
        columns={[
          { key: 'title', label: 'Title' },
          { key: 'code', label: 'Code' },
          { key: 'department_id', label: 'Department', sortValue: (r) => r.department_id || 0, render: (r) => (depts.find((d) => Number(d.id) === Number(r.department_id))?.name || <span className="badge amber">unassigned</span>) },
          { key: 'employment_type', label: 'Type', render: (r) => (r.employment_type || '—').replace(/_/g, ' ') },
          {
            key: 'openings', label: 'Filled / Open', align: 'right',
            sortValue: (r) => Number(r.openings || 0) - Number(r.filled || 0),
            render: (r) => {
              const open = Math.max(0, Number(r.openings || 0) - Number(r.filled || 0));
              return (
                <>
                  {num(r.filled)} / {num(r.openings)}
                  {open > 0 && <span className="badge amber" style={{ marginLeft: 6 }}>{open} open</span>}
                </>
              );
            },
          },
          { key: 'status', label: 'Status', render: (r) => <StatusBadge value={r.status} /> },
        ]}
        actions={(row) => (
          <>
            <button className="btn ghost sm" onClick={() => setPipelineFor(row)}>Pipeline</button>
            <button className="btn ghost sm" onClick={() => openEdit(row)}>Edit</button>
            <button className="btn ghost sm" style={{ color: 'var(--red)' }} onClick={() => setDeleting(row)}>Delete</button>
          </>
        )}
      />

      {editing !== null && (
        <Modal
          title={editing.id ? `Edit ${editing.title}` : 'Add position'}
          onClose={() => setEditing(null)}
          footer={<><button className="btn secondary" onClick={() => setEditing(null)}>Cancel</button><button className="btn" onClick={save}>Save</button></>}
        >
          <div className="form-grid">
            <TextField label="Title" value={form.title} onChange={setF('title')} required />
            <TextField label="Code" value={form.code} onChange={setF('code')} />
            <SelectField label="Department" value={form.department_id} onChange={setF('department_id')} options={deptOptions} />
            <SelectField label="Employment type" value={form.employment_type} onChange={setF('employment_type')} options={EMPLOYMENT} />
            <TextField label="Openings" type="number" value={form.openings} onChange={setF('openings')} min={0} />
            <TextField label="Filled" type="number" value={form.filled} onChange={setF('filled')} min={0} />
            <SelectField label="Status" value={form.status} onChange={setF('status')} options={STATUS} />
            <div style={{ gridColumn: '1 / -1' }}>
              <TextField label="Description" value={form.description} onChange={setF('description')} />
            </div>
          </div>
        </Modal>
      )}

      {deleting && (
        <Confirm title="Delete position?" message={`"${deleting.title}" will be removed from the structure.`} danger onYes={doDelete} onClose={() => setDeleting(null)} />
      )}

      {pipelineFor && <PipelineModal position={pipelineFor} onClose={() => setPipelineFor(null)} />}
    </div>
  );
}

/** Who holds the position now, and who is lined up next. */
function PipelineModal({ position, onClose }) {
  const { data, loading, reload } = useLoader(
    async () => (await api.get(`/administration/positions/${position.id}/pipeline`)).data.data,
    [position.id]
  );
  const [tab, setTab] = useState('incumbents');

  return (
    <Modal title={`${position.title} — pipeline`} onClose={onClose} wide>
      {loading && !data ? <Spinner /> : !data ? <Empty /> : (
        <>
          <div className="row mb" style={{ gap: 8 }}>
            <span className="badge blue">{data.incumbents?.length || 0} incumbent</span>
            <span className="badge purple">{data.candidates?.length || 0} candidate</span>
            <span className="badge amber">{num(Number(data.position?.openings || 0) - Number(data.position?.filled || 0))} open</span>
          </div>
          <div className="tabs">
            <button className={'tab' + (tab === 'incumbents' ? ' active' : '')} onClick={() => setTab('incumbents')}>Incumbents</button>
            <button className={'tab' + (tab === 'candidates' ? ' active' : '')} onClick={() => setTab('candidates')}>Candidates</button>
          </div>
          {tab === 'incumbents' ? (
            <div className="table-wrap mt">
              <table className="tbl">
                <thead><tr><th>Employee</th><th>Code</th><th>Joined</th><th>Status</th></tr></thead>
                <tbody>
                  {(data.incumbents || []).map((e) => (
                    <tr key={e.id}>
                      <td>{e.first_name} {e.last_name}<div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{e.email}</div></td>
                      <td>{e.employee_code}</td>
                      <td>{fmtDate(e.joined_on)}</td>
                      <td><StatusBadge value={e.status} /></td>
                    </tr>
                  ))}
                  {!(data.incumbents || []).length && (
                    <tr><td colSpan={4} style={{ textAlign: 'center', color: 'var(--muted)', padding: 24 }}>Nobody holds this position yet</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="table-wrap mt">
              <table className="tbl">
                <thead><tr><th>Candidate</th><th>Stage</th><th>Source</th><th>Applied</th></tr></thead>
                <tbody>
                  {(data.candidates || []).map((c) => (
                    <tr key={c.id}>
                      <td>{c.name}<div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{c.email}</div></td>
                      <td><StatusBadge value={c.stage} /></td>
                      <td>{c.source || '—'}</td>
                      <td>{fmtDate(c.applied_at)}</td>
                    </tr>
                  ))}
                  {!(data.candidates || []).length && (
                    <tr><td colSpan={4} style={{ textAlign: 'center', color: 'var(--muted)', padding: 24 }}>No candidates in the pipeline</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </Modal>
  );
}