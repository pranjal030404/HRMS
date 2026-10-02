import React, { useState } from 'react';
import { api, errMsg } from '../../api';
import DataTable from '../../components/DataTable';
import { CheckField, Confirm, Empty, Modal, SelectField, Spinner, StatusBadge, TextField, useToast } from '../../components/ui';
import { AdminSection, PageHeader, listLoader, useLoader } from './shared';

const STATUS = [{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }];
const MEMBER_ROLE = [
  { value: 'member', label: 'Member' },
  { value: 'lead', label: 'Lead' },
  { value: 'manager', label: 'Manager' },
];

export default function AdminTeams() {
  return (
    <AdminSection sectionKey="teams">
      <Teams />
    </AdminSection>
  );
}

function Teams() {
  const toast = useToast();
  const { data, loading, reload } = useLoader(listLoader('/administration/teams'), []);
  const { data: structure } = useLoader(listLoader('/administration/organization/structure'), []);
  const { data: employees } = useLoader(
    // /employees caps `limit` at 100 server-side.
    async () => (await api.get('/employees', { params: { limit: 100, status: 'active' } })).data.data || [],
    []
  );
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({});
  const [deleting, setDeleting] = useState(null);
  const [membersFor, setMembersFor] = useState(null);

  const depts = (structure?.businessUnits || []).flatMap((bu) => (bu.departments || []).map((d) => ({ ...d, unit: bu.name })));
  const units = (structure?.businessUnits || []);
  const deptOptions = depts.map((d) => ({ value: d.id, label: `${d.unit ? `${d.unit} › ` : ''}${d.name}` }));
  const unitOptions = units.map((u) => ({ value: u.id, label: u.name }));
  const people = (employees || []).map((e) => ({
    value: e.id, label: `${e.first_name || ''} ${e.last_name || ''} ${e.employee_code ? `(${e.employee_code})` : ''}`.trim(),
  }));

  const openNew = () => { setEditing({}); setForm({ status: 'active' }); };
  const openEdit = (row) => { setEditing(row); setForm({ status: 'active', ...row }); };
  const setF = (k) => (v) => setForm((f) => ({ ...f, [k]: v === '' ? null : v }));

  const save = async () => {
    try {
      const payload = {
        name: form.name, code: form.code || null, description: form.description || null,
        department_id: form.department_id ?? null, business_unit_id: form.business_unit_id ?? null,
        team_lead_id: form.team_lead_id ?? null, status: form.status || 'active',
      };
      if (editing?.id) await api.put(`/administration/teams/${editing.id}`, payload);
      else await api.post('/administration/teams', payload);
      toast(editing?.id ? 'Team updated' : 'Team created');
      setEditing(null);
      reload();
    } catch (e) { toast(errMsg(e), true); }
  };

  const doDelete = async () => {
    try {
      await api.delete(`/administration/teams/${deleting.id}`);
      toast('Team deleted');
      reload();
    } catch (e) { toast(errMsg(e), true); }
  };

  return (
    <div>
      <PageHeader
        title="Teams"
        sub="Membership is employees, not logins — access follows people."
        actions={<button className="btn sm" onClick={openNew}>+ Add team</button>}
      />
      <DataTable
        rows={data}
        loading={loading}
        columns={[
          { key: 'name', label: 'Team' },
          { key: 'code', label: 'Code' },
          { key: 'team_lead_id', label: 'Lead', sortValue: (r) => r.team_lead_id || 0, render: (r) => (people.find((p) => Number(p.value) === Number(r.team_lead_id))?.label || <span className="badge amber">unassigned</span>) },
          { key: 'member_count', label: 'Members', align: 'right', render: (r) => num(r.member_count) },
          { key: 'description', label: 'Description' },
          { key: 'status', label: 'Status', render: (r) => <StatusBadge value={r.status} /> },
        ]}
        actions={(row) => (
          <>
            <button className="btn ghost sm" onClick={() => setMembersFor(row)}>Members</button>
            <button className="btn ghost sm" onClick={() => openEdit(row)}>Edit</button>
            <button className="btn ghost sm" style={{ color: 'var(--red)' }} onClick={() => setDeleting(row)}>Delete</button>
          </>
        )}
      />

      {editing !== null && (
        <Modal
          title={editing.id ? `Edit ${editing.name}` : 'Add team'}
          onClose={() => setEditing(null)}
          footer={<><button className="btn secondary" onClick={() => setEditing(null)}>Cancel</button><button className="btn" onClick={save}>Save</button></>}
        >
          <div className="form-grid">
            <TextField label="Team name" value={form.name} onChange={setF('name')} required />
            <TextField label="Code" value={form.code} onChange={setF('code')} />
            <SelectField label="Business unit" value={form.business_unit_id} onChange={setF('business_unit_id')} options={unitOptions} />
            <SelectField label="Department" value={form.department_id} onChange={setF('department_id')} options={deptOptions} />
            <SelectField label="Team lead" value={form.team_lead_id} onChange={setF('team_lead_id')} options={people} />
            <SelectField label="Status" value={form.status} onChange={setF('status')} options={STATUS} />
            <div style={{ gridColumn: '1 / -1' }}>
              <TextField label="Description" value={form.description} onChange={setF('description')} />
            </div>
          </div>
        </Modal>
      )}

      {deleting && (
        <Confirm title="Delete team?" message={`"${deleting.name}" will be removed. Members keep their employee records.`} danger onYes={doDelete} onClose={() => setDeleting(null)} />
      )}

      {membersFor && <MembersModal team={membersFor} people={people} onClose={() => setMembersFor(null)} onChange={reload} />}
    </div>
  );
}

function MembersModal({ team, people, onClose, onChange }) {
  const toast = useToast();
  const { data, loading, reload } = useLoader(listLoader(`/administration/teams/${team.id}/members`), [team.id]);
  const [emp, setEmp] = useState('');
  const [role, setRole] = useState('member');
  const [alloc, setAlloc] = useState('100');

  const add = async () => {
    if (!emp) return;
    try {
      await api.post(`/administration/teams/${team.id}/members`, {
        employee_id: emp, member_role: role, allocation_pct: Number(alloc) || 100,
      });
      toast('Member added');
      setEmp('');
      reload();
      onChange?.();
    } catch (e) { toast(errMsg(e), true); }
  };

  const remove = async (member) => {
    try {
      await api.delete(`/administration/teams/members/${member.id}`);
      toast('Member removed');
      reload();
      onChange?.();
    } catch (e) { toast(errMsg(e), true); }
  };

  return (
    <Modal title={`${team.name} — members`} onClose={onClose} wide>
      {loading && !data ? <Spinner /> : !data?.length ? (
        <Empty icon="👥" text="No members yet" />
      ) : (
        <div className="table-wrap">
          <table className="tbl">
            <thead><tr><th>Employee</th><th>Code</th><th>Department</th><th>Role</th><th>Allocation</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {data.map((m) => (
                <tr key={m.id}>
                  <td>{m.first_name} {m.last_name}<div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{m.email}</div></td>
                  <td>{m.employee_code}</td>
                  <td>{m.department_name || '—'}</td>
                  <td>{m.member_role}</td>
                  <td>{m.allocation_pct}%</td>
                  <td><StatusBadge value={m.status} /></td>
                  <td className="actions">
                    {m.status === 'active' && (
                      <button className="btn ghost sm" style={{ color: 'var(--red)' }} onClick={() => remove(m)}>Remove</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="form-grid mt" style={{ alignItems: 'flex-end' }}>
        <SelectField label="Add employee" value={emp} onChange={setEmp} options={people} placeholder="— Choose —" />
        <SelectField label="Role" value={role} onChange={setRole} options={MEMBER_ROLE} placeholder={null} />
        <TextField label="Allocation %" type="number" value={alloc} onChange={setAlloc} min={0} max={100} />
        <div><button className="btn" onClick={add} disabled={!emp}>Add member</button></div>
      </div>
    </Modal>
  );
}