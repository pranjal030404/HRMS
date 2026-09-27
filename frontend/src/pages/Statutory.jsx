import React, { useEffect, useState } from 'react';
import { api, errMsg, fmtDate } from '../api';
import { useAuth } from '../auth';
import { Spinner, useToast, Modal, TextField, SelectField } from '../components/ui';

const PARAM_DOCS = {
  PF: 'employeeRate, employerRate, epsRate, wageCeiling, capAtCeiling',
  ESI: 'employeeRate, employerRate, grossCeiling',
  PT: 'slabs: [{ upto, tax } …, { above: true, tax }]',
  TDS: 'slabs: [{ upto, rate } …, { above: true, rate }], stdDeduction, rebateLimit, rebateAmount, cess, old {…}',
  LWF: 'employeeAmount, employerAmount',
};

export default function Statutory() {
  const { can } = useAuth();
  const toast = useToast();
  const [rules, setRules] = useState(null);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({});

  const load = async () => {
    try {
      const { data } = await api.get('/payroll/statutory');
      setRules(data.data);
    } catch (e) { toast(errMsg(e), true); }
  };
  useEffect(() => { load(); }, []);

  const openNew = () => {
    setForm({
      ruleType: 'PF', jurisdiction: 'IN', effectiveFrom: new Date().toISOString().slice(0, 10),
      version: '', paramsText: JSON.stringify({ employeeRate: 12, employerRate: 12, epsRate: 8.33, wageCeiling: 15000, capAtCeiling: true }, null, 2),
    });
    setEditing({});
  };

  const save = async () => {
    try {
      const params = JSON.parse(form.paramsText);
      await api.post('/payroll/statutory', { ...form, params });
      toast('Statutory rule version created (effective-dated)');
      setEditing(null);
      load();
    } catch (e) {
      toast(e instanceof SyntaxError ? 'Invalid JSON in parameters' : errMsg(e), true);
    }
  };

  if (!rules) return <Spinner />;

  const grouped = {};
  for (const r of rules) (grouped[r.rule_type] ||= []).push(r);

  return (
    <div>
      <div className="card mb">
        <div className="card-h">
          <h3>Statutory rule versions</h3>
          {can('statutory.manage') && <button className="btn sm" onClick={openNew}>+ New rule version</button>}
        </div>
        <div className="card-b" style={{ fontSize: 13, color: 'var(--muted)', borderBottom: '1px solid var(--border)' }}>
          Rules are effective-dated and versioned: payroll always computes with the version active on the pay period end date,
          so historical runs remain reproducible. Verify rates against current government notifications before each production payroll year.
        </div>
        <div className="table-wrap">
          <table className="tbl">
            <thead><tr><th>Rule</th><th>Jurisdiction</th><th>Version</th><th>Effective from</th><th>Effective to</th><th>Parameters</th></tr></thead>
            <tbody>
              {Object.entries(grouped).flatMap(([type, list]) =>
                list.map((r, i) => (
                  <tr key={r.id}>
                    <td>{i === 0 && <b>{type}</b>}</td>
                    <td>{r.jurisdiction}</td>
                    <td><code>{r.version}</code></td>
                    <td>{fmtDate(r.effective_from)}</td>
                    <td>{r.effective_to ? fmtDate(r.effective_to) : <span className="badge green">active</span>}</td>
                    <td><code style={{ fontSize: 11 }}>{JSON.stringify(r.params).slice(0, 110)}…</code></td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {editing !== null && (
        <Modal title="New statutory rule version" wide onClose={() => setEditing(null)} footer={
          <><button className="btn secondary" onClick={() => setEditing(null)}>Cancel</button><button className="btn" onClick={save}>Create version</button></>
        }>
          <div className="form-grid">
            <SelectField label="Rule type" value={form.ruleType} onChange={(v) => setForm((f) => ({ ...f, ruleType: v }))}
              options={['PF', 'ESI', 'PT', 'TDS', 'LWF'].map((v) => ({ value: v, label: v }))} />
            <TextField label="Jurisdiction" value={form.jurisdiction} onChange={(v) => setForm((f) => ({ ...f, jurisdiction: v }))} hint="IN for central; state code (KA, MH…) for PT/LWF" />
            <TextField label="Version *" value={form.version} onChange={(v) => setForm((f) => ({ ...f, version: v }))} hint="e.g. PF-2027A" />
            <TextField label="Effective from *" type="date" value={form.effectiveFrom} onChange={(v) => setForm((f) => ({ ...f, effectiveFrom: v }))} />
          </div>
          <div className="field">
            <label>Parameters (JSON) *</label>
            <textarea rows={10} value={form.paramsText} onChange={(e) => setForm((f) => ({ ...f, paramsText: e.target.value }))}
              style={{ fontFamily: 'monospace', fontSize: 12.5, padding: 10, border: '1px solid var(--border)', borderRadius: 8 }} />
            <span className="hint">Shape for {form.ruleType}: {PARAM_DOCS[form.ruleType]}</span>
          </div>
        </Modal>
      )}
    </div>
  );
}
