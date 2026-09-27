import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, errMsg, money, fmtDate } from '../../api';
import { useAuth } from '../../auth';
import { Spinner, StatusBadge, useToast, TextField, StatCard } from '../../components/ui';

const KV = ({ k, v }) => (
  <div className="spread" style={{ padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
    <span style={{ color: 'var(--muted)', fontSize: 13 }}>{k}</span><b style={{ fontSize: 13 }}>{v || '—'}</b>
  </div>
);

export default function MyProfile() {
  const { me, refreshMe } = useAuth();
  const nav = useNavigate();
  const toast = useToast();
  const [emp, setEmp] = useState(null);
  const [loans, setLoans] = useState(null);
  const [reqForm, setReqForm] = useState('');
  const [sepModal, setSepModal] = useState(false);
  const [sepForm, setSepForm] = useState({});

  useEffect(() => {
    if (!me?.employee_id) return;
    api.get(`/employees/${me.employee_id}`).then(({ data }) => setEmp(data.data)).catch((e) => toast(errMsg(e), true));
    api.get('/loans').then(({ data }) => setLoans(data.data)).catch(() => {});
  }, [me]);

  const requestChange = async () => {
    try {
      await api.post(`/employees/${me.employee_id}/profile-request`, { request: reqForm });
      toast('Request sent to HR');
      setReqForm('');
    } catch (e) { toast(errMsg(e), true); }
  };

  const resign = async () => {
    try {
      await api.post('/lifecycle/separations', sepForm);
      toast('Resignation submitted to HR');
      setSepModal(false);
    } catch (e) { toast(errMsg(e), true); }
  };

  if (!emp) return <Spinner />;
  const e = emp.data;

  return (
    <div>
      <div className="grid c3 mb">
        <StatCard label="Status" value={e.status.replace(/_/g, ' ')} sub={`Joined ${fmtDate(e.joined_on)}`} />
        <StatCard label="Employment" value={e.employment_type?.replace('_', ' ')} sub={e.work_mode} />
        <StatCard label="Active loans" value={(loans || []).filter((l) => l.status === 'active').length}
          sub={(loans || []).length ? `Outstanding: ${money((loans || []).reduce((s, l) => s + Number(l.outstanding), 0))}` : 'No loans'} />
      </div>

      <div className="grid c2">
        <div className="card">
          <div className="card-h"><h3>My details</h3></div>
          <div className="card-b">
            <KV k="Employee code" v={e.employee_code} />
            <KV k="Email" v={e.email} />
            <KV k="Phone" v={e.phone} />
            <KV k="Department" v={e.department_name} />
            <KV k="Designation" v={e.designation_name} />
            <KV k="Location" v={e.location_name} />
            <KV k="Manager" v={e.manager_first_name ? `${e.manager_first_name} ${e.manager_last_name}` : '—'} />
            <KV k="PAN" v={e.pan_plain_masked || (e.pan_plain ? '•••••' : null)} />
            <KV k="Bank" v={e.bank_account ? `••••••${String(e.bank_account).slice(-4)}` : null} />
          </div>
        </div>
        <div className="card">
          <div className="card-h"><h3>Requests</h3></div>
          <div className="card-b">
            <h4 style={{ fontSize: 13, marginBottom: 8 }}>Profile update request</h4>
            <p style={{ fontSize: 12.5, color: 'var(--muted)' }}>Profile edits go through HR approval. Describe what should change.</p>
            <div className="field">
              <textarea rows={3} value={reqForm} onChange={(ev) => setReqForm(ev.target.value)} placeholder="e.g. Update my phone number to 98xxxxxx" />
            </div>
            <button className="btn sm" onClick={requestChange} disabled={!reqForm.trim()}>Send to HR</button>

            <h4 style={{ fontSize: 13, margin: '20px 0 8px' }}>Resignation</h4>
            {e.status === 'on_notice' || e.status === 'resigned' ? (
              <span className="badge amber">Separation already in progress</span>
            ) : (
              <button className="btn sm danger" onClick={() => setSepModal(true)}>Submit resignation</button>
            )}
          </div>
        </div>
      </div>

      {sepModal && (
        <div className="overlay" onMouseDown={(ev) => ev.target === ev.currentTarget && setSepModal(false)}>
          <div className="modal">
            <div className="modal-h"><h3>Submit resignation</h3><button className="x-btn" onClick={() => setSepModal(false)}>×</button></div>
            <div className="modal-b">
              <TextField label="Last working day *" type="date" value={sepForm.lastWorkingDay}
                min={new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10)}
                onChange={(v) => setSepForm((f) => ({ ...f, lastWorkingDay: v }))} hint="Minimum 30 days notice" />
              <TextField label="Reason" value={sepForm.reason} onChange={(v) => setSepForm((f) => ({ ...f, reason: v }))} />
            </div>
            <div className="modal-f">
              <button className="btn secondary" onClick={() => setSepModal(false)}>Cancel</button>
              <button className="btn danger" onClick={resign} disabled={!sepForm.lastWorkingDay}>Submit</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
