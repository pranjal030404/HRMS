import React, { useEffect, useState } from 'react';
import { api, errMsg, money } from '../api';
import { useAuth } from '../auth';
import DataTable from '../components/DataTable';
import { Spinner, useToast, Modal, TextField, SelectField, CheckField } from '../components/ui';

export default function SalaryStructures() {
  const { can } = useAuth();
  const toast = useToast();
  const [structures, setStructures] = useState(null);
  const [components, setComponents] = useState(null);
  const [items, setItems] = useState(null);
  const [sel, setSel] = useState(null);
  const [editStructure, setEditStructure] = useState(null);
  const [form, setForm] = useState({});

  const load = async () => {
    const [s, c] = await Promise.all([api.get('/payroll/structures'), api.get('/payroll/components')]);
    setStructures(s.data.data);
    setComponents(c.data.data);
  };
  useEffect(() => { load().catch((e) => toast(errMsg(e), true)); }, []); // eslint-disable-line

  const openStructure = async (st) => {
    setSel(st);
    const { data } = await api.get(`/payroll/structures/${st.id}/items`);
    setItems(data.data);
  };

  const saveStructure = async () => {
    try {
      if (editStructure?.id) await api.put(`/payroll/structures/${editStructure.id}`, form);
      else await api.post('/payroll/structures', form);
      toast('Structure saved');
      setEditStructure(null);
      load();
    } catch (e) { toast(errMsg(e), true); }
  };

  const addComponentToStructure = async (componentId) => {
    if (!componentId) return;
    try {
      await api.post(`/payroll/structures/${sel.id}/items`, { componentId: Number(componentId) });
      openStructure(sel);
      toast('Component added');
    } catch (e) { toast(errMsg(e), true); }
  };

  const removeItem = async (itemId) => {
    try {
      await api.delete(`/payroll/structures/${sel.id}/items/${itemId}`);
      openStructure(sel);
    } catch (e) { toast(errMsg(e), true); }
  };

  if (!structures || !components) return <Spinner />;

  const earnings = components.filter((c) => c.ctype === 'earning');

  return (
    <div className="grid c2">
      <div className="card">
        <div className="card-h">
          <h3>Salary structures</h3>
          {can('payroll.configure') && <button className="btn sm" onClick={() => { setEditStructure({}); setForm({ active: 1 }); }}>+ New structure</button>}
        </div>
        <div className="table-wrap">
          <table className="tbl">
            <thead><tr><th>Name</th><th>Description</th><th></th></tr></thead>
            <tbody>
              {structures.map((s) => (
                <tr key={s.id} onClick={() => openStructure(s)} style={{ cursor: 'pointer' }}>
                  <td><b>{s.name}</b>{sel?.id === s.id && <span className="badge blue" style={{ marginLeft: 8 }}>selected</span>}</td>
                  <td style={{ color: 'var(--muted)' }}>{s.description || '—'}</td>
                  <td className="actions">{can('payroll.configure') && <button className="btn ghost sm" onClick={(e) => { e.stopPropagation(); setEditStructure(s); setForm({ name: s.name, description: s.description, active: s.active }); }}>Edit</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <div className="card-h">
          <h3>{sel ? `Components in "${sel.name}"` : 'Select a structure'}</h3>
          {sel && can('payroll.configure') && (
            <select className="btn sm secondary" value="" onChange={(e) => addComponentToStructure(e.target.value)}>
              <option value="">+ Add component…</option>
              {earnings.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          )}
        </div>
        {sel && items && (
          <div className="table-wrap">
            <table className="tbl">
              <thead><tr><th>Component</th><th>Fixed amount</th><th>Formula</th><th></th></tr></thead>
              <tbody>
                {items.length === 0 && <tr><td colSpan={4} style={{ textAlign: 'center', padding: 24, color: 'var(--muted)' }}>No components yet</td></tr>}
                {items.map((it) => (
                  <tr key={it.id}>
                    <td><b>{it.component_name}</b><div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{it.component_code}</div></td>
                    <td>{it.amount != null ? money(it.amount) : '—'}</td>
                    <td><code style={{ fontSize: 11.5 }}>{it.formula || '—'}</code></td>
                    <td className="actions">{can('payroll.configure') && <button className="btn ghost sm" style={{ color: 'var(--red)' }} onClick={() => removeItem(it.id)}>Remove</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card" style={{ gridColumn: '1 / -1' }}>
        <div className="card-h"><h3>Salary components library</h3></div>
        <div className="table-wrap">
          <table className="tbl">
            <thead><tr><th>Name</th><th>Code</th><th>Type</th><th>Calculation</th><th>Taxable</th><th>Formula / default</th></tr></thead>
            <tbody>
              {components.map((c) => (
                <tr key={c.id}>
                  <td><b>{c.name}</b></td>
                  <td><code>{c.code}</code></td>
                  <td><span className={'badge ' + (c.ctype === 'earning' ? 'green' : c.ctype === 'deduction' ? 'red' : 'purple')}>{c.ctype.replace(/_/g, ' ')}</span></td>
                  <td>{c.calc_type}</td>
                  <td>{c.taxable ? 'Yes' : 'No'}</td>
                  <td><code style={{ fontSize: 11.5 }}>{c.formula || '—'}</code></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="card-b" style={{ borderTop: '1px solid var(--border)', fontSize: 12.5, color: 'var(--muted)' }}>
          Formula variables: <code>BASIC</code>, <code>GROSS_BASE</code>, <code>PAYABLE_DAYS</code>, <code>MONTH_DAYS</code>, <code>LOP_DAYS</code>, <code>OT_MINUTES</code>, <code>CTC_MONTHLY</code>.
          Functions: min, max, round, ceil, floor, abs, ternary (cond ? a : b). Statutory components (PF, ESI, PT, TDS) are computed by the versioned rules engine, not formulas.
        </div>
      </div>

      {editStructure !== null && (
        <Modal title={editStructure.id ? 'Edit structure' : 'New structure'} onClose={() => setEditStructure(null)} footer={
          <><button className="btn secondary" onClick={() => setEditStructure(null)}>Cancel</button><button className="btn" onClick={saveStructure}>Save</button></>
        }>
          <TextField label="Name *" value={form.name} onChange={(v) => setForm((f) => ({ ...f, name: v }))} />
          <TextField label="Description" value={form.description} onChange={(v) => setForm((f) => ({ ...f, description: v }))} />
          <CheckField label="Active" checked={form.active} onChange={(v) => setForm((f) => ({ ...f, active: v ? 1 : 0 }))} />
        </Modal>
      )}
    </div>
  );
}
