import React, { useState } from 'react';
import { api, errMsg, fmtDate } from '../../api';
import { useAuth } from '../../auth';
import DataTable from '../../components/DataTable';
import { Modal, SelectField, Spinner, StatusBadge, TextField, useToast } from '../../components/ui';
import { AdminSection, PageHeader, listLoader, num, useLoader } from './shared';

const PLAN = [
  { value: 'standard', label: 'Standard' },
  { value: 'professional', label: 'Professional' },
  { value: 'enterprise', label: 'Enterprise' },
];
const STATUS = [
  { value: 'active', label: 'Active' },
  { value: 'suspended', label: 'Suspended' },
  { value: 'archived', label: 'Archived' },
];

/**
 * Cross-tenant roster. Reachable only with `platform.tenants.view` — a company
 * administrator cannot list other companies, and no alias reaches this page.
 */
export default function AdminCompanies() {
  return (
    <AdminSection sectionKey="tenants">
      <Companies />
    </AdminSection>
  );
}

function Companies() {
  const { can } = useAuth();
  const toast = useToast();
  const { data, loading, reload } = useLoader(listLoader('/administration/tenants'), []);
  const [creating, setCreating] = useState(false);
  const [detail, setDetail] = useState(null);

  return (
    <div>
      <PageHeader
        title="Companies"
        sub="Every company on the platform. Platform scope only — this list is never visible to a company administrator."
        actions={can('platform.tenants.manage') ? <button className="btn sm" onClick={() => setCreating(true)}>+ New company</button> : null}
      />

      <div className="info-box mb">
        Suspending a company blocks its logins at authentication time. Employee data is untouched.
      </div>

      <DataTable
        rows={data}
        loading={loading}
        onRowClick={(row) => setDetail(row.id)}
        columns={[
          { key: 'name', label: 'Company' },
          { key: 'slug', label: 'Slug', render: (r) => <code style={{ fontSize: 12 }}>{r.slug}</code> },
          { key: 'plan', label: 'Plan' },
          { key: 'employees', label: 'Employees', align: 'right', render: (r) => num(r.employees) },
          { key: 'active_users', label: 'Active logins', align: 'right', render: (r) => num(r.active_users) },
          { key: 'employee_limit', label: 'Limit', align: 'right', render: (r) => (r.employee_limit ? num(r.employee_limit) : '—') },
          { key: 'status', label: 'Status', render: (r) => <StatusBadge value={r.status} /> },
          { key: 'created_at', label: 'Created', render: (r) => fmtDate(r.created_at) },
        ]}
      />

      {creating && <CreateCompany onClose={() => setCreating(false)} onDone={() => { setCreating(false); reload(); }} />}
      {detail && <CompanyDetail id={detail} canManage={can('platform.tenants.manage')} onClose={() => setDetail(null)} onChanged={() => reload()} />}
    </div>
  );
}

function CreateCompany({ onClose, onDone }) {
  const toast = useToast();
  const [form, setForm] = useState({ name: '', slug: '', plan: 'standard', adminEmail: '', adminName: '' });
  const [result, setResult] = useState(null);
  const setF = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async () => {
    try {
      const { data } = await api.post('/administration/tenants', {
        name: form.name,
        slug: form.slug || String(form.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
        plan: form.plan,
        adminEmail: form.adminEmail,
        adminName: form.adminName || undefined,
        branding: { companyName: form.name },
      });
      setResult(data);
    } catch (e) { toast(errMsg(e), true); }
  };

  if (result) {
    return (
      <Modal title="Company provisioned" onClose={onDone} footer={<button className="btn" onClick={onDone}>Done</button>}>
        <div className="info-box">
          The tenant, its system roles and the first owner were created in one transaction. Hand the credentials over once.
        </div>
        <div className="form-grid">
          <TextField label="Owner email" value={result.adminEmail} onChange={() => {}} />
          <TextField label="Temporary password" value={result.tempPassword} onChange={() => {}} />
        </div>
        <button
          className="btn mt"
          onClick={() => { navigator.clipboard?.writeText(`${result.adminEmail} / ${result.tempPassword}`); }}
        >
          Copy credentials
        </button>
      </Modal>
    );
  }

  return (
    <Modal
      title="New company"
      onClose={onClose}
      footer={<><button className="btn secondary" onClick={onClose}>Cancel</button><button className="btn" onClick={submit} disabled={!form.name || !form.adminEmail}>Provision</button></>}
    >
      <div className="form-grid">
        <TextField label="Company name" value={form.name} onChange={setF('name')} />
        <TextField label="Slug" value={form.slug} onChange={setF('slug')} hint="lowercase letters, numbers, dashes" />
        <SelectField label="Plan" value={form.plan} onChange={setF('plan')} options={PLAN} />
        <TextField label="Owner email" type="email" value={form.adminEmail} onChange={setF('adminEmail')} />
        <TextField label="Owner name" value={form.adminName} onChange={setF('adminName')} />
      </div>
    </Modal>
  );
}

function CompanyDetail({ id, canManage, onClose, onChanged }) {
  const toast = useToast();
  const { data, loading, reload } = useLoader(
    async () => (await api.get(`/administration/tenants/${id}`)).data.data,
    [id]
  );
  const [form, setForm] = useState(null);

  React.useEffect(() => {
    if (data) setForm({ name: data.name, plan: data.plan, status: data.status, employee_limit: data.employee_limit ?? '' });
  }, [data]);

  const save = async () => {
    try {
      await api.put(`/administration/tenants/${id}`, {
        name: form.name,
        plan: form.plan,
        status: form.status,
        employee_limit: form.employee_limit === '' ? null : Number(form.employee_limit),
      });
      toast('Company updated');
      reload();
      onChanged();
    } catch (e) { toast(errMsg(e), true); }
  };

  if (loading && !data) return <Modal title="Company" onClose={onClose} wide><Spinner /></Modal>;
  if (!data || !form) return null;

  const enabled = (data.modules || []).filter((m) => Number(m.enabled)).length;

  return (
    <Modal title={data.name} onClose={onClose} wide>
      <div className="row wrap mb" style={{ gap: 6 }}>
        <span className="badge blue">{data.plan}</span>
        <StatusBadge value={data.status} />
        <span className="badge gray">#{data.id}</span>
        <span className="badge purple">{enabled}/{data.modules?.length || 0} modules on</span>
      </div>

      {canManage && (
        <>
          <div className="form-grid">
            <TextField label="Name" value={form.name} onChange={(v) => setForm((f) => ({ ...f, name: v }))} />
            <SelectField label="Plan" value={form.plan} onChange={(v) => setForm((f) => ({ ...f, plan: v }))} options={PLAN} />
            <SelectField label="Status" value={form.status} onChange={(v) => setForm((f) => ({ ...f, status: v }))} options={STATUS} />
            <TextField label="Employee limit" type="number" value={form.employee_limit} onChange={(v) => setForm((f) => ({ ...f, employee_limit: v }))} min={0} />
          </div>
          <div className="row mt"><button className="btn" onClick={save}>Save</button></div>
        </>
      )}

      <div className="mt">
        <b style={{ fontSize: 13.5 }}>Logins ({data.users.length})</b>
        <div className="table-wrap mt">
          <table className="tbl">
            <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Last login</th></tr></thead>
            <tbody>
              {data.users.map((u) => (
                <tr key={u.id}>
                  <td>{u.name}</td>
                  <td>{u.email}</td>
                  <td>{(u.role || 'none').replace(/_/g, ' ')}</td>
                  <td><StatusBadge value={u.status} /></td>
                  <td>{u.last_login_at ? fmtDate(u.last_login_at, true) : <span className="badge amber">never</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Modal>
  );
}