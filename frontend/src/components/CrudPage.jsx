import React, { useCallback, useEffect, useState } from 'react';
import { api, errMsg } from '../api';
import DataTable from './DataTable';
import { Modal, TextField, SelectField, CheckField, useToast, Confirm } from './ui';

/**
 * Generic master-data page bound to a /org/<resource> CRUD endpoint.
 * fields: [{key, label, type: 'text'|'number'|'select'|'check'|'textarea'|'time'|'date', options?, hint?, required?}]
 * columns: DataTable columns
 */
export default function CrudPage({ resource, title, singular, fields, columns, extraActions, defaults = {} }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null); // null | {} | row
  const [form, setForm] = useState({});
  const [deleting, setDeleting] = useState(null);
  const toast = useToast();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get(`/org/${resource}`);
      setRows(data.data);
    } catch (e) { toast(errMsg(e), true); }
    setLoading(false);
  }, [resource]); // eslint-disable-line

  useEffect(() => { load(); }, [load]);

  const openNew = () => { setEditing({}); setForm({ status: 'active', ...defaults }); };
  const openEdit = (row) => {
    setEditing(row);
    const f = {};
    for (const fld of fields) {
      let v = row[fld.key];
      if (fld.type === 'check') v = !!v;
      if (v === null || v === undefined) v = fld.type === 'check' ? false : '';
      f[fld.key] = v;
    }
    setForm(f);
  };

  const save = async () => {
    try {
      const payload = {};
      for (const fld of fields) {
        let v = form[fld.key];
        if (fld.type === 'number') v = v === '' || v === null ? null : Number(v);
        if (fld.type === 'check') v = v ? 1 : 0;
        payload[fld.key] = v;
      }
      if (editing?.id) await api.put(`/org/${resource}/${editing.id}`, payload);
      else await api.post(`/org/${resource}`, payload);
      toast(editing?.id ? `${singular} updated` : `${singular} created`);
      setEditing(null);
      load();
    } catch (e) { toast(errMsg(e), true); }
  };

  const doDelete = async () => {
    try {
      await api.delete(`/org/${resource}/${deleting.id}`);
      toast(`${singular} deleted`);
      load();
    } catch (e) { toast(errMsg(e), true); }
  };

  const setF = (key) => (v) => setForm((f) => ({ ...f, [key]: v }));

  return (
    <>
      <DataTable
        columns={columns}
        rows={rows}
        loading={loading}
        toolbar={<button className="btn sm" onClick={openNew}>+ Add {singular}</button>}
        actions={(row) => (
          <>
            {extraActions?.(row)}
            <button className="btn ghost sm" onClick={() => openEdit(row)}>Edit</button>
            <button className="btn ghost sm" style={{ color: 'var(--red)' }} onClick={() => setDeleting(row)}>Delete</button>
          </>
        )}
      />
      {editing !== null && (
        <Modal
          title={editing.id ? `Edit ${singular}` : `Add ${singular}`}
          onClose={() => setEditing(null)}
          footer={
            <>
              <button className="btn secondary" onClick={() => setEditing(null)}>Cancel</button>
              <button className="btn" onClick={save}>Save</button>
            </>
          }
        >
          <div className="form-grid">
            {fields.map((fld) => {
              if (fld.type === 'select') {
                return <SelectField key={fld.key} label={fld.label} value={form[fld.key]} onChange={setF(fld.key)} options={fld.options} hint={fld.hint} />;
              }
              if (fld.type === 'check') {
                return <CheckField key={fld.key} label={fld.label} checked={form[fld.key]} onChange={setF(fld.key)} />;
              }
              if (fld.type === 'textarea') {
                return (
                  <div className="field" key={fld.key} style={{ gridColumn: '1 / -1' }}>
                    <label>{fld.label}</label>
                    <textarea rows={fld.rows || 3} value={form[fld.key] ?? ''} onChange={(e) => setF(fld.key)(e.target.value)} />
                  </div>
                );
              }
              return (
                <TextField key={fld.key} label={fld.label} type={fld.type || 'text'} value={form[fld.key]}
                  onChange={setF(fld.key)} hint={fld.hint} required={fld.required} />
              );
            })}
          </div>
        </Modal>
      )}
      {deleting && (
        <Confirm title={`Delete ${singular}?`} message={`This will permanently remove "${deleting.name || deleting.title}".`} danger onYes={doDelete} onClose={() => setDeleting(null)} />
      )}
    </>
  );
}
