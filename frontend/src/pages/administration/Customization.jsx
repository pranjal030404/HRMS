import React, { useState } from 'react';
import { api, errMsg } from '../../api';
import { useAuth } from '../../auth';
import DataTable from '../../components/DataTable';
import { CheckField, Confirm, Empty, Modal, SelectField, Spinner, StatusBadge, Tabs, TextField, useToast } from '../../components/ui';
import { AdminSection, PageHeader, listLoader, num, useLoader } from './shared';

const FIELD_TYPES = [
  'text', 'textarea', 'number', 'date', 'datetime', 'boolean', 'select', 'multi_select',
  'email', 'phone', 'url', 'currency', 'percent', 'json',
].map((v) => ({ value: v, label: v.replace(/_/g, ' ') }));

const ENTITIES = ['employee', 'department', 'position', 'team', 'location', 'grade', 'leave', 'expense', 'payroll', 'attendance']
  .map((v) => ({ value: v, label: v }));

export default function AdminCustomization() {
  return (
    <AdminSection sectionKey="customization">
      <Customization />
    </AdminSection>
  );
}

function Customization() {
  const [tab, setTab] = useState('fields');
  return (
    <div>
      <PageHeader
        title="Custom Fields & Forms"
        sub="Extend the records this HRMS keeps, without a code change."
      />
      <Tabs
        tabs={[
          { key: 'fields', label: 'Custom fields' },
          { key: 'forms', label: 'Forms' },
        ]}
        active={tab}
        onChange={setTab}
      />
      {tab === 'fields' && <Fields />}
      {tab === 'forms' && <Forms />}
    </div>
  );
}

function Fields() {
  const { can } = useAuth();
  const toast = useToast();
  const { data, loading, reload } = useLoader(listLoader('/administration/custom-fields'), []);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({});
  const [deleting, setDeleting] = useState(null);
  const canManage = can('administration.custom_fields.manage');

  const open = (row) => {
    setEditing(row || {});
    setForm(row
      ? { ...row, options: (row.options || []).map((o) => o.option_value || o.value).join('\n') }
      : { entity_type: 'employee', field_type: 'text', required: 0, status: 'active' });
  };
  const setF = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));

  const save = async () => {
    const options = String(form.options || '')
      .split('\n').map((s) => s.trim()).filter(Boolean)
      .map((v) => (v.includes('=') ? { option_label: v.split('=')[0].trim(), option_value: v.split('=').slice(1).join('=').trim() } : { option_label: v, option_value: v }));
    const payload = {
      entity_type: form.entity_type,
      field_key: form.field_key,
      label: form.label,
      description: form.description || null,
      field_type: form.field_type,
      required: form.required ? 1 : 0,
      default_value: form.default_value || null,
      placeholder: form.placeholder || null,
      help_text: form.help_text || null,
      options,
    };
    try {
      if (editing?.id) await api.put(`/administration/custom-fields/${editing.id}`, payload);
      else await api.post('/administration/custom-fields', payload);
      toast(editing?.id ? 'Field updated' : 'Field created');
      setEditing(null);
      reload();
    } catch (e) { toast(errMsg(e), true); }
  };

  const doDelete = async () => {
    try {
      await api.delete(`/administration/custom-fields/${deleting.id}`);
      toast('Field deleted');
      setDeleting(null);
      reload();
    } catch (e) { toast(errMsg(e), true); }
  };

  return (
    <>
      <div className="row mb" style={{ justifyContent: 'flex-end' }}>
        {canManage && <button className="btn sm" onClick={() => open(null)}>+ Add custom field</button>}
      </div>
      <DataTable
        rows={data}
        loading={loading}
        columns={[
          { key: 'label', label: 'Field' },
          { key: 'field_key', label: 'Key', render: (r) => <code style={{ fontSize: 12 }}>{r.field_key}</code> },
          { key: 'entity_type', label: 'Applies to' },
          { key: 'field_type', label: 'Type', render: (r) => <span className="badge gray">{String(r.field_type).replace(/_/g, ' ')}</span> },
          { key: 'required', label: 'Required', render: (r) => (Number(r.required) ? <span className="badge amber">yes</span> : '—') },
          { key: 'value_count', label: 'Values', align: 'right', render: (r) => num(r.value_count) },
          { key: 'status', label: 'Status', render: (r) => <StatusBadge value={r.status} /> },
        ]}
        actions={(row) => (canManage ? (
          <>
            <button className="btn ghost sm" onClick={() => open(row)}>Edit</button>
            <button className="btn ghost sm" style={{ color: 'var(--red)' }} onClick={() => setDeleting(row)}>Delete</button>
          </>
        ) : null)}
      />

      {editing !== null && (
        <Modal
          title={editing.id ? `Edit “${editing.label}”` : 'Add custom field'}
          onClose={() => setEditing(null)}
          footer={<><button className="btn secondary" onClick={() => setEditing(null)}>Cancel</button><button className="btn" onClick={save}>Save</button></>}
        >
          <div className="form-grid">
            <SelectField label="Applies to" value={form.entity_type} onChange={setF('entity_type')} options={ENTITIES} />
            <SelectField label="Type" value={form.field_type} onChange={setF('field_type')} options={FIELD_TYPES} />
            <TextField label="Key" value={form.field_key} onChange={setF('field_key')} hint="lowercase identifier" />
            <TextField label="Label" value={form.label} onChange={setF('label')} />
            <TextField label="Placeholder" value={form.placeholder} onChange={setF('placeholder')} />
            <TextField label="Default value" value={form.default_value} onChange={setF('default_value')} />
            <div style={{ gridColumn: '1 / -1' }}>
              <TextField label="Help text" value={form.help_text} onChange={setF('help_text')} />
            </div>
            {(form.field_type === 'select' || form.field_type === 'multi_select') && (
              <div className="field" style={{ gridColumn: '1 / -1' }}>
                <label>Options (one per line, or Label=value)</label>
                <textarea rows={4} value={form.options || ''} onChange={(e) => setF('options')(e.target.value)} />
              </div>
            )}
            <CheckField label="Required" checked={Number(form.required) === 1} onChange={setF('required')} />
          </div>
        </Modal>
      )}

      {deleting && (
        <Confirm
          title="Delete custom field?"
          message={`“${deleting.label}” and every value stored for it will be removed.`}
          danger
          onYes={doDelete}
          onClose={() => setDeleting(null)}
        />
      )}
    </>
  );
}

function Forms() {
  const { can } = useAuth();
  const toast = useToast();
  const { data, loading, reload } = useLoader(listLoader('/administration/forms'), []);
  const [creating, setCreating] = useState(false);
  const [viewing, setViewing] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const canManage = can('administration.forms.manage');

  const doDelete = async () => {
    try {
      await api.delete(`/administration/forms/${deleting.id}`);
      toast('Form deleted');
      setDeleting(null);
      reload();
    } catch (e) { toast(errMsg(e), true); }
  };

  const publish = async (form) => {
    try {
      await api.put(`/administration/forms/${form.id}`, { status: 'published' });
      toast('Form published');
      reload();
    } catch (e) { toast(errMsg(e), true); }
  };

  return (
    <>
      <div className="row mb" style={{ justifyContent: 'flex-end' }}>
        {canManage && <button className="btn sm" onClick={() => setCreating(true)}>+ Create form</button>}
      </div>
      <DataTable
        rows={data}
        loading={loading}
        onRowClick={(row) => setViewing(row.id)}
        columns={[
          { key: 'name', label: 'Form' },
          { key: 'form_key', label: 'Key', render: (r) => <code style={{ fontSize: 12 }}>{r.form_key}</code> },
          { key: 'entity_type', label: 'Applies to' },
          { key: 'section_count', label: 'Sections', align: 'right' },
          { key: 'field_count', label: 'Fields', align: 'right' },
          { key: 'version', label: 'Version', align: 'right', render: (r) => `v${r.version}` },
          { key: 'status', label: 'Status', render: (r) => <StatusBadge value={r.status} /> },
        ]}
        actions={(row) => (canManage ? (
          <>
            {row.status !== 'published' && <button className="btn ghost sm" onClick={() => publish(row)}>Publish</button>}
            {!row.is_system && <button className="btn ghost sm" style={{ color: 'var(--red)' }} onClick={() => setDeleting(row)}>Delete</button>}
          </>
        ) : null)}
      />

      {creating && <CreateForm onClose={() => setCreating(false)} onDone={() => { setCreating(false); reload(); }} />}
      {viewing && <FormDetail id={viewing} onClose={() => setViewing(null)} />}
      {deleting && <Confirm title="Delete form?" message={`“${deleting.name}” and its layout will be removed.`} danger onYes={doDelete} onClose={() => setDeleting(null)} />}
    </>
  );
}

function CreateForm({ onClose, onDone }) {
  const toast = useToast();
  const [form, setForm] = useState({ form_key: '', name: '', entity_type: 'employee', description: '' });
  const submit = async () => {
    try {
      await api.post('/administration/forms', {
        form_key: form.form_key, name: form.name, entity_type: form.entity_type,
        description: form.description, sections: [], fields: [],
      });
      toast('Form created');
      onDone();
    } catch (e) { toast(errMsg(e), true); }
  };
  return (
    <Modal title="Create form" onClose={onClose}
      footer={<><button className="btn secondary" onClick={onClose}>Cancel</button><button className="btn" onClick={submit} disabled={!form.name || !form.form_key}>Create</button></>}>
      <div className="form-grid">
        <TextField label="Name" value={form.name} onChange={(v) => setForm((f) => ({ ...f, name: v }))} />
        <TextField label="Key" value={form.form_key} onChange={(v) => setForm((f) => ({ ...f, form_key: v }))} />
        <SelectField label="Applies to" value={form.entity_type} onChange={(v) => setForm((f) => ({ ...f, entity_type: v }))} options={ENTITIES} />
        <div style={{ gridColumn: '1 / -1' }}>
          <TextField label="Description" value={form.description} onChange={(v) => setForm((f) => ({ ...f, description: v }))} />
        </div>
      </div>
    </Modal>
  );
}

function FormDetail({ id, onClose }) {
  const { data, loading } = useLoader(
    async () => (await api.get(`/administration/forms/${id}`)).data.data,
    [id]
  );
  return (
    <Modal title={data?.name || 'Form'} onClose={onClose} wide>
      {loading && !data ? <Spinner /> : !data ? <Empty /> : (
        <>
          <div className="row wrap mb" style={{ gap: 6 }}>
            <span className="badge blue">{data.entity_type}</span>
            <StatusBadge value={data.status} />
            <span className="badge gray">v{data.version}</span>
          </div>
          {(data.sections || []).length === 0 && (data.fields || []).length === 0 ? (
            <Empty icon="📝" text="This form has no sections yet" />
          ) : (
            (data.sections || []).map((s) => (
              <div key={s.id} className="mb">
                <b style={{ fontSize: 13.5 }}>{s.title || s.section_key}</b>
                <div className="row wrap" style={{ gap: 6, marginTop: 6 }}>
                  {(data.fields || []).filter((f) => f.section_id === s.id).map((f) => (
                    <span key={f.id} className="badge gray">{f.label || f.field_key}</span>
                  ))}
                </div>
              </div>
            ))
          )}
        </>
      )}
    </Modal>
  );
}