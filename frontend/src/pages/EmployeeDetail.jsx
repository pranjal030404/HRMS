import React, { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api, errMsg, fmtDate, money } from '../api';
import { useAuth } from '../auth';
import { Spinner, Tabs, StatusBadge, useToast, Modal, TextField, SelectField, Empty } from '../components/ui';

export default function EmployeeDetail() {
  const { id } = useParams();
  const { can } = useAuth();
  const toast = useToast();
  const [data, setData] = useState(null);
  const [salaries, setSalaries] = useState([]);
  const [lookups, setLookups] = useState(null);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({});
  const [salaryModal, setSalaryModal] = useState(false);
  const [salForm, setSalForm] = useState({});
  const [editTab, setEditTab] = useState('job');

  const load = async () => {
    try {
      const [emp, sal, lk] = await Promise.all([
        api.get(`/employees/${id}`),
        api.get(`/payroll/employee-salaries/${id}`).catch(() => ({ data: { data: [] } })),
        api.get('/org/lookups'),
      ]);
      setData(emp.data);
      setSalaries(sal.data.data);
      setLookups(lk.data.data);
    } catch (e) { toast(errMsg(e), true); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [id]);

  if (!data) return <Spinner />;
  const e = data.data;
  const current = salaries[0];

  const openEdit = () => {
    setEditTab('job');
    setForm({
      first_name: e.first_name, last_name: e.last_name, phone: e.phone, personal_email: e.personal_email,
      dob: e.dob?.slice(0, 10), gender: e.gender, marital_status: e.marital_status, blood_group: e.blood_group,
      address: e.address, city: e.city, state: e.state, pincode: e.pincode,
      emergency_name: e.emergency_name, emergency_relation: e.emergency_relation, emergency_phone: e.emergency_phone,
      department_id: e.department_id, designation_id: e.designation_id, grade_id: e.grade_id, location_id: e.location_id,
      manager_id: e.manager_id, status: e.status, work_mode: e.work_mode, employment_type: e.employment_type,
      confirmation_date: e.confirmation_date?.slice(0, 10), pan_plain: e.pan_plain, bank_name: e.bank_name,
      bank_account: e.bank_account, ifsc: e.ifsc, uan: e.uan, tax_regime: e.tax_regime,
    });
    setEditing(true);
  };

  const saveEdit = async () => {
    try {
      await api.put(`/employees/${id}`, form);
      toast('Employee updated');
      setEditing(false);
      load();
    } catch (err) { toast(errMsg(err), true); }
  };

  const saveSalary = async () => {
    try {
      const gross = Number(salForm.gross || 0);
      const basic = Math.round(gross * 0.5);
      await api.post('/payroll/employee-salaries', {
        employeeId: Number(id),
        effectiveFrom: salForm.effective_from,
        ctcAnnual: gross * 12,
        revisionReason: salForm.revision_reason,
        items: [
          { code: 'BASIC', name: 'Basic', type: 'earning', calcType: 'fixed', amount: basic, taxable: true, prorated: true, partOfGross: true },
          { code: 'HRA', name: 'House Rent Allowance', type: 'earning', calcType: 'fixed', amount: Math.round(basic * 0.4), taxable: true, prorated: true, partOfGross: true },
          { code: 'CONV', name: 'Conveyance Allowance', type: 'earning', calcType: 'fixed', amount: 1600, taxable: true, prorated: true, partOfGross: true },
          { code: 'SPECIAL', name: 'Special Allowance', type: 'earning', calcType: 'fixed', amount: gross - basic - Math.round(basic * 0.4) - 1600, taxable: true, prorated: true, partOfGross: true },
        ],
      });
      toast('Salary revision recorded (effective-dated)');
      setSalaryModal(false);
      load();
    } catch (err) { toast(errMsg(err), true); }
  };

  const setF = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));
  const setS = (k) => (v) => setSalForm((f) => ({ ...f, [k]: v }));

  return (
    <div>
      <div className="card mb">
        <div style={{ padding: 20 }} className="spread wrap">
          <div className="row">
            <div className="avatar" style={{ width: 56, height: 56, fontSize: 20 }}>{e.first_name[0]}{e.last_name[0]}</div>
            <div>
              <h2 style={{ fontSize: 18 }}>{e.first_name} {e.last_name} <StatusBadge value={e.status} /></h2>
              <p style={{ color: 'var(--muted)', fontSize: 13 }}>
                {e.employee_code} · {e.designation_name || '—'} · {e.department_name || '—'} · {e.location_name || '—'}
              </p>
              <p style={{ color: 'var(--muted)', fontSize: 12.5 }}>Joined {fmtDate(e.joined_on)} · {e.email}</p>
            </div>
          </div>
          <div className="row">
            {can('letter.generate') && <Link className="btn secondary sm" to="/documents">Generate letter</Link>}
            {can('employee.edit') && <button className="btn sm" onClick={openEdit}>Edit</button>}
          </div>
        </div>
      </div>

      <EmployeeTabs data={data} salaries={salaries} current={current} can={can} onRevise={() => { setSalForm({ effective_from: new Date().toISOString().slice(0, 10) }); setSalaryModal(true); }} />
      {data.onboardingTasks?.length > 0 && (
        <div className="card mt">
          <div className="card-h"><h3>Onboarding checklist</h3></div>
          <div className="card-b">
            {data.onboardingTasks.map((t) => (
              <div className="spread" key={t.id} style={{ padding: '6px 0' }}>
                <span style={{ fontSize: 13.5 }}>{t.status === 'completed' ? '✅' : '⬜'} {t.title}</span>
                <span style={{ fontSize: 12, color: 'var(--muted)' }}>{t.category} · {t.assignee_role}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {editing && (
        <Modal title="Edit employee" wide onClose={() => setEditing(false)} footer={
          <><button className="btn secondary" onClick={() => setEditing(false)}>Cancel</button>
            <button className="btn" onClick={saveEdit}>Save changes</button></>
        }>
          <Tabs tabs={[
            { key: 'job', label: 'Job' },
            { key: 'personal', label: 'Personal' },
            { key: 'payroll', label: 'Payroll & bank' },
          ]} active={editTab} onChange={setEditTab} />
          <div className="form-grid">
            {editTab === 'job' && (<>
              <SelectField label="Department" value={form.department_id} onChange={setF('department_id')} options={(lookups?.departments || []).map((d) => ({ value: d.id, label: d.name }))} />
              <SelectField label="Designation" value={form.designation_id} onChange={setF('designation_id')} options={(lookups?.designations || []).map((d) => ({ value: d.id, label: d.name }))} />
              <SelectField label="Grade" value={form.grade_id} onChange={setF('grade_id')} options={(lookups?.grades || []).map((d) => ({ value: d.id, label: d.name }))} />
              <SelectField label="Location" value={form.location_id} onChange={setF('location_id')} options={(lookups?.locations || []).map((d) => ({ value: d.id, label: d.name }))} />
              <SelectField label="Status" value={form.status} onChange={setF('status')} options={[
                { value: 'onboarding', label: 'Onboarding' }, { value: 'on_probation', label: 'On probation' },
                { value: 'active', label: 'Active' }, { value: 'on_notice', label: 'On notice' },
                { value: 'resigned', label: 'Resigned' }, { value: 'exited', label: 'Exited' }]} />
              <SelectField label="Work mode" value={form.work_mode} onChange={setF('work_mode')} options={[{ value: 'office', label: 'Office' }, { value: 'hybrid', label: 'Hybrid' }, { value: 'remote', label: 'Remote' }]} />
            </>)}
            {editTab === 'personal' && (<>
              <TextField label="Phone" value={form.phone} onChange={setF('phone')} />
              <TextField label="Personal email" type="email" value={form.personal_email} onChange={setF('personal_email')} />
              <TextField label="Date of birth" type="date" value={form.dob} onChange={setF('dob')} />
              <TextField label="Blood group" value={form.blood_group} onChange={setF('blood_group')} />
              <TextField label="Emergency contact" value={form.emergency_name} onChange={setF('emergency_name')} />
              <TextField label="Emergency phone" value={form.emergency_phone} onChange={setF('emergency_phone')} />
              <TextField label="Address" value={form.address} onChange={setF('address')} />
              <TextField label="City" value={form.city} onChange={setF('city')} />
              <TextField label="State" value={form.state} onChange={setF('state')} />
              <TextField label="Pincode" value={form.pincode} onChange={setF('pincode')} />
            </>)}
            {editTab === 'payroll' && (<>
              {can('employee.edit_sensitive') && <>
                <TextField label="PAN" value={form.pan_plain} onChange={setF('pan_plain')} hint="Encrypted at rest" />
                <TextField label="Bank account" value={form.bank_account} onChange={setF('bank_account')} hint="Encrypted at rest" />
                <TextField label="IFSC" value={form.ifsc} onChange={setF('ifsc')} />
                <TextField label="UAN" value={form.uan} onChange={setF('uan')} />
              </>}
              <SelectField label="Tax regime" value={form.tax_regime} onChange={setF('tax_regime')} options={[{ value: 'new', label: 'New regime' }, { value: 'old', label: 'Old regime' }]} />
            </>)}
          </div>
          {editTab === 'payroll' && !can('employee.edit_sensitive') && (
            <p className="hint" style={{ fontSize: 12, color: 'var(--muted)' }}>
              You don't have permission to edit statutory identifiers (PAN, bank details). Ask an HR/Payroll admin.
            </p>
          )}
        </Modal>
      )}

      {salaryModal && (
        <Modal title="Salary revision" onClose={() => setSalaryModal(false)} footer={
          <><button className="btn secondary" onClick={() => setSalaryModal(false)}>Cancel</button>
            <button className="btn" onClick={saveSalary}>Save revision</button></>
        }>
          <TextField label="New gross monthly (₹) *" type="number" value={salForm.gross} onChange={setS('gross')} hint="Split as Basic 50% + HRA 20% + Conveyance + Special" />
          <TextField label="Effective from *" type="date" value={salForm.effective_from} onChange={setS('effective_from')} />
          <TextField label="Reason" value={salForm.revision_reason} onChange={setS('revision_reason')} hint="e.g. Annual increment, Promotion" />
          <p className="hint" style={{ fontSize: 12, color: 'var(--muted)' }}>Previous salary record is closed-dated; locked payroll runs are never rewritten.</p>
        </Modal>
      )}
    </div>
  );
}

function EmployeeTabs({ data, salaries, current, can, onRevise }) {
  const [tab, setTab] = useState('job');
  const e = data.data;
  const [letters, setLetters] = useState([]);
  useEffect(() => {
    if (tab === 'docs') api.get(`/documents/letters/${e.id}`).then(({ data }) => setLetters(data.data)).catch(() => {});
  }, [tab, e.id]);

  return (
    <>
      <Tabs active={tab} onChange={setTab} tabs={[
        { key: 'job', label: 'Job & timeline' },
        { key: 'salary', label: 'Salary history' },
        { key: 'docs', label: `Documents (${data.documents.length})` },
      ]} />
      {tab === 'job' && (
        <div className="grid c2">
          <div className="card">
            <div className="card-h"><h3>Job details</h3></div>
            <div className="card-b" style={{ fontSize: 13.5 }}>
              <KV k="Employee code" v={e.employee_code} />
              <KV k="Department" v={e.department_name} />
              <KV k="Designation" v={e.designation_name} />
              <KV k="Grade" v={e.grade_name} />
              <KV k="Location" v={e.location_name} />
              <KV k="Shift" v={e.shift_name} />
              <KV k="Manager" v={e.manager_first_name ? `${e.manager_first_name} ${e.manager_last_name}` : '—'} />
              <KV k="Employment type" v={e.employment_type?.replace('_', ' ')} />
              <KV k="Work mode" v={e.work_mode} />
              <KV k="Tax regime" v={e.tax_regime} />
            </div>
          </div>
          <div className="card">
            <div className="card-h"><h3>Timeline</h3></div>
            <div className="card-b">
              {data.timeline.length === 0 && <Empty text="No events yet" />}
              <div className="timeline">
                {data.timeline.map((t) => (
                  <div className="tl-item" key={t.id}>
                    <b>{t.title}</b>
                    <span>{t.event_type.replace(/_/g, ' ')} · {fmtDate(t.event_date)}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
      {tab === 'salary' && (
        <div className="card">
          <div className="card-h">
            <h3>Effective-dated salary history</h3>
            {can('payroll.configure') && <button className="btn sm" onClick={onRevise}>+ Salary revision</button>}
          </div>
          <div className="table-wrap">
            <table className="tbl">
              <thead><tr><th>Effective from</th><th>To</th><th className="num">Gross / month</th><th className="num">CTC / year</th><th>Reason</th></tr></thead>
              <tbody>
                {salaries.map((s) => (
                  <tr key={s.id}>
                    <td>{fmtDate(s.effective_from)}</td>
                    <td>{s.effective_to ? fmtDate(s.effective_to) : 'Current'}</td>
                    <td className="num">{money(s.gross_monthly)}</td>
                    <td className="num">{money(s.ctc_annual)}</td>
                    <td>{s.revision_reason || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {current && (
            <div className="card-b" style={{ borderTop: '1px solid var(--border)' }}>
              <h4 style={{ fontSize: 13.5, marginBottom: 8 }}>Current components</h4>
              {current.items.map((it) => (
                <div className="bar-row" key={it.code}>
                  <div className="bar-lbl">{it.name}</div>
                  <div className="bar-track"><div className="bar-fill" style={{ width: `${(it.amount / current.gross_monthly) * 100}%` }} /></div>
                  <div className="bar-val">{money(it.amount)}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {tab === 'docs' && (
        <div className="grid c2">
          <div className="card">
            <div className="card-h"><h3>Documents</h3></div>
            <div className="card-b">
              {data.documents.length === 0 && <Empty text="No documents uploaded" />}
              {data.documents.map((d) => (
                <div className="spread" key={d.id} style={{ padding: '7px 0', borderBottom: '1px solid var(--border)' }}>
                  <div>
                    <b style={{ fontSize: 13 }}>{d.name}</b>
                    <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{d.doc_type.replace(/_/g, ' ')} · expires {d.expires_on ? fmtDate(d.expires_on) : '—'}</div>
                  </div>
                  <a className="btn ghost sm" href={`/api/files/${d.file_path}`} target="_blank" rel="noreferrer">View</a>
                </div>
              ))}
            </div>
          </div>
          <div className="card">
            <div className="card-h"><h3>Generated letters</h3></div>
            <div className="card-b">
              {letters.length === 0 && <Empty text="No letters generated" />}
              {letters.map((l) => (
                <div className="spread" key={l.id} style={{ padding: '7px 0', borderBottom: '1px solid var(--border)' }}>
                  <div><b style={{ fontSize: 13 }}>{l.title}</b><div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{fmtDate(l.generated_at, true)}</div></div>
                  <a className="btn ghost sm" href={`/api/files/${l.pdf_path}`} target="_blank" rel="noreferrer">PDF</a>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

const KV = ({ k, v }) => (
  <div className="spread" style={{ padding: '5px 0', borderBottom: '1px solid var(--border)' }}>
    <span style={{ color: 'var(--muted)' }}>{k}</span><b>{v || '—'}</b>
  </div>
);
