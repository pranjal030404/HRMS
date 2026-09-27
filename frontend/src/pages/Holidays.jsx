import React, { useEffect, useState } from 'react';
import { api, errMsg, fmtDate } from '../api';
import { useAuth } from '../auth';
import { Spinner, useToast, Modal, TextField, SelectField, Confirm, Empty } from '../components/ui';

export default function Holidays() {
  const { can } = useAuth();
  const toast = useToast();
  const year = new Date().getFullYear();
  const [rows, setRows] = useState(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({});
  const [del, setDel] = useState(null);

  const load = async () => {
    try {
      const { data } = await api.get('/org/holidays', { params: { year } });
      setRows(data.data);
    } catch (e) { toast(errMsg(e), true); }
  };
  useEffect(() => { load(); }, []); // eslint-disable-line

  const save = async () => {
    try {
      await api.post('/org/holidays', form);
      toast('Holiday saved');
      setAdding(false);
      load();
    } catch (e) { toast(errMsg(e), true); }
  };

  if (!rows) return <Spinner />;

  return (
    <div className="card">
      <div className="card-h">
        <h3>Holiday calendar {year}</h3>
        {can('org.manage') && <button className="btn sm" onClick={() => { setForm({ htype: 'public' }); setAdding(true); }}>+ Add holiday</button>}
      </div>
      <div className="table-wrap">
        <table className="tbl">
          <thead><tr><th>Date</th><th>Day</th><th>Holiday</th><th>Type</th><th></th></tr></thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={5}><Empty text="No holidays configured for this year" /></td></tr>}
            {rows.map((h) => (
              <tr key={h.id}>
                <td>{fmtDate(h.hdate)}</td>
                <td>{new Date(h.hdate).toLocaleDateString('en-IN', { weekday: 'long' })}</td>
                <td><b>{h.name}</b></td>
                <td><span className="badge blue">{h.htype}</span></td>
                <td className="actions">{can('org.manage') && <button className="btn ghost sm" style={{ color: 'var(--red)' }} onClick={() => setDel(h)}>Delete</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {adding && (
        <Modal title="Add holiday" onClose={() => setAdding(false)} footer={
          <><button className="btn secondary" onClick={() => setAdding(false)}>Cancel</button><button className="btn" onClick={save}>Save</button></>
        }>
          <TextField label="Date *" type="date" value={form.hdate} onChange={(v) => setForm((f) => ({ ...f, hdate: v }))} />
          <TextField label="Name *" value={form.name} onChange={(v) => setForm((f) => ({ ...f, name: v }))} />
          <SelectField label="Type" value={form.htype} onChange={(v) => setForm((f) => ({ ...f, htype: v }))}
            options={[{ value: 'public', label: 'Public' }, { value: 'optional', label: 'Optional' }, { value: 'restricted', label: 'Restricted' }]} />
        </Modal>
      )}
      {del && <Confirm title="Delete holiday?" message={`Remove "${del.name}" from the calendar?`} danger onYes={async () => { await api.delete(`/org/holidays/${del.id}`); load(); }} onClose={() => setDel(null)} />}
    </div>
  );
}
