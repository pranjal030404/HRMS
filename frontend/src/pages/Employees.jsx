import React, { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, errMsg, fmtDate } from '../api';
import { useAuth } from '../auth';
import DataTable from '../components/DataTable';
import { Modal, TextField, SelectField, useToast, StatusBadge, downloadFile } from '../components/ui';

const EMP_TYPES = [
  { value: 'full_time', label: 'Full time' }, { value: 'part_time', label: 'Part time' },
  { value: 'contract', label: 'Contract' }, { value: 'intern', label: 'Intern' }, { value: 'consultant', label: 'Consultant' },
];
const STATUSES = [
  { value: 'onboarding', label: 'Onboarding' }, { value: 'on_probation', label: 'On probation' },
  { value: 'active', label: 'Active' }, { value: 'on_notice', label: 'On notice' },
];

export default function Employees() {
  const { me, can } = useAuth();
  const nav = useNavigate();
  const toast = useToast();
  const [rows, setRows] = useState([]);
  const [meta, setMeta] = useState({ total: 0, page: 1, pages: 1 });
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState(null);
  const [lookups, setLookups] = useState(null);
  const [created, setCreated] = useState(null);
  const fileRef = useRef();

  const [form, setForm] = useState({});

  const load = async (p = page, query = q) => {
    setLoading(true);
    try {
      const { data } = await api.get('/employees', { params: { page: p, limit: 15, q: query || undefined, status: status || undefined } });
      setRows(data.data);
      setMeta(data.meta);
    } catch (e) { toast(errMsg(e), true); }
    setLoading(false);
  };

  React.useEffect(() => {
    load(1, '');
    api.get('/org/lookups').then(({ data }) => setLookups(data.data)).catch(() => {});
    // eslint-disable-next-line
  }, []);

  const openAdd = () => {
    setForm({ status: 'onboarding', employment_type: 'full_time', probation_months: 6, tax_regime: 'new' });
    setAdding(true);
  };

  const saveAdd = async () => {
    try {
      const { data } = await api.post('/employees', form);
      setAdding(false);
      load(1, '');
      if (data.tempPassword) setCreated({ email: form.email, password: data.tempPassword, name: `${form.first_name} ${form.last_name}` });
      else toast('Employee created');
    } catch (e) { toast(errMsg(e), true); }
  };

  const doImport = async () => {
    const file = fileRef.current?.files?.[0];
    if (!file) return toast('Choose a CSV file first', true);
    const fd = new FormData();
    fd.append('file', file);
    try {
      const { data } = await api.post('/employees/import', fd);
      setImportResult(data.data);
      load(1, '');
    } catch (e) { toast(errMsg(e), true); }
  };

  const setF = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));

  const columns = [
    { key: 'employee_code', label: 'Code' },
    {
      key: 'first_name', label: 'Employee', render: (r) => (
        <div className="row">
          <div className="avatar" style={{ width: 28, height: 28, fontSize: 11 }}>{r.first_name[0]}{r.last_name[0]}</div>
          <div><b>{r.first_name} {r.last_name}</b><div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{r.email}</div></div>
        </div>
      ), sortValue: (r) => r.first_name
    },
    { key: 'designation_name', label: 'Designation', render: (r) => r.designation_name || '—' },
    { key: 'department_name', label: 'Department', render: (r) => r.department_name || '—' },
    { key: 'location_name', label: 'Location', render: (r) => r.location_name || '—' },
    { key: 'joined_on', label: 'Joined', render: (r) => fmtDate(r.joined_on) },
    { key: 'status', label: 'Status', render: (r) => <StatusBadge value={r.status} /> },
  ];

  return (
    <>
      <DataTable
        columns={columns}
        rows={rows}
        loading={loading}
        emptyText="No employees found"
        toolbar={
          <div className="row">
            <select className="btn sm secondary" value={status} onChange={(e) => { setStatus(e.target.value); load(1, q); }} style={{ paddingRight: 8 }}>
              <option value="">All statuses</option>
              <option value="active">Active</option><option value="on_probation">Probation</option>
              <option value="on_notice">Notice</option><option value="exited">Exited</option>
            </select>
            {can('employee.import') && <button className="btn sm secondary" onClick={() => setImporting(true)}>⬆ Import CSV</button>}
            {can('employee.create') && <button className="btn sm" onClick={openAdd}>+ Add employee</button>}
          </div>
        }
        onRowClick={(r) => nav(`/employees/${r.id}`)}
        actions={(r) => <button className="btn ghost sm" onClick={() => nav(`/employees/${r.id}`)}>View</button>}
      />
      <div className="spread" style={{ marginTop: 12 }}>
        <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>{meta.total} employees</span>
        <div className="row">
          <button className="btn sm secondary" disabled={meta.page <= 1} onClick={() => { const p = meta.page - 1; setPage(p); load(p); }}>Prev</button>
          <span style={{ fontSize: 12.5 }}>Page {meta.page} / {meta.pages}</span>
          <button className="btn sm secondary" disabled={meta.page >= meta.pages} onClick={() => { const p = meta.page + 1; setPage(p); load(p); }}>Next</button>
        </div>
      </div>

      {adding && (
        <Modal title="Add employee" wide onClose={() => setAdding(false)} footer={
          <><button className="btn secondary" onClick={() => setAdding(false)}>Cancel</button>
            <button className="btn" onClick={saveAdd}>Create employee & portal login</button></>
        }>
          <div className="form-grid">
            <TextField label="First name *" value={form.first_name} onChange={setF('first_name')} required />
            <TextField label="Last name *" value={form.last_name} onChange={setF('last_name')} required />
            <TextField label="Work email *" type="email" value={form.email} onChange={setF('email')} required />
            <TextField label="Phone" value={form.phone} onChange={setF('phone')} />
            <TextField label="Date of joining *" type="date" value={form.joined_on} onChange={setF('joined_on')} required />
            <TextField label="Date of birth" type="date" value={form.dob} onChange={setF('dob')} />
            <SelectField label="Gender" value={form.gender} onChange={setF('gender')} options={[{ value: 'male', label: 'Male' }, { value: 'female', label: 'Female' }, { value: 'other', label: 'Other' }]} />
            <SelectField label="Employment type" value={form.employment_type} onChange={setF('employment_type')} options={EMP_TYPES} />
            <SelectField label="Department" value={form.department_id} onChange={setF('department_id')} options={(lookups?.departments || []).map((d) => ({ value: d.id, label: d.name }))} />
            <SelectField label="Designation" value={form.designation_id} onChange={setF('designation_id')} options={(lookups?.designations || []).map((d) => ({ value: d.id, label: d.name }))} />
            <SelectField label="Location" value={form.location_id} onChange={setF('location_id')} options={(lookups?.locations || []).map((d) => ({ value: d.id, label: d.name }))} />
            <SelectField label="Reporting manager" value={form.manager_id} onChange={setF('manager_id')} options={(lookups?.departments || []).length ? [] : []} hint="Set from the employee profile after creation" />
            <SelectField label="Status" value={form.status} onChange={setF('status')} options={STATUSES} />
            <TextField label="PAN" value={form.pan_plain} onChange={setF('pan_plain')} hint="Encrypted at rest" />
            <TextField label="Bank account" value={form.bank_account} onChange={setF('bank_account')} hint="Encrypted at rest" />
            <TextField label="IFSC" value={form.ifsc} onChange={setF('ifsc')} />
            <TextField label="Bank name" value={form.bank_name} onChange={setF('bank_name')} />
          </div>
          <p className="hint" style={{ fontSize: 12, color: 'var(--muted)' }}>
            A portal login is created automatically with a temporary password (shown after save).
          </p>
        </Modal>
      )}

      {created && (
        <Modal title="Employee created ✅" onClose={() => setCreated(null)} footer={<button className="btn" onClick={() => setCreated(null)}>Done</button>}>
          <div className="info-box">Share these credentials with the employee. They will be asked to change the password on first login.</div>
          <p><b>{created.name}</b></p>
          <p>Email: <code>{created.email}</code></p>
          <p>Temp password: <code>{created.password}</code></p>
        </Modal>
      )}

      {importing && (
        <Modal title="Bulk import employees" onClose={() => { setImporting(false); setImportResult(null); }} footer={
          <><button className="btn secondary" onClick={() => downloadFile('/api/employees/import/template', 'employee_import_template.csv')}>Download template</button>
            <button className="btn" onClick={doImport}>Upload & import</button></>
        }>
          <div className="field">
            <label>CSV file</label>
            <input type="file" accept=".csv,text/csv" ref={fileRef} />
          </div>
          <p className="hint" style={{ fontSize: 12, color: 'var(--muted)' }}>
            Required columns: first_name, last_name, email, joined_on (YYYY-MM-DD). Optional: employee_code, phone, dob, gender,
            employment_type, department, designation, location (by name), manager_email. Rows are validated before commit —
            duplicates and errors are reported row-by-row.
          </p>
          {importResult && (
            <div style={{ marginTop: 12 }}>
              <div className={importResult.errors.length ? 'error-box' : 'info-box'}>
                Imported {importResult.success}/{importResult.total} rows. {importResult.errors.length} error(s).
              </div>
              {importResult.errors.slice(0, 8).map((e, i) => (
                <p key={i} style={{ fontSize: 12.5, color: 'var(--red)' }}>Row {e.row}: {e.error}</p>
              ))}
            </div>
          )}
        </Modal>
      )}
    </>
  );
}
