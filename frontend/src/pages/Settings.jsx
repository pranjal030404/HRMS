import React, { useEffect, useState } from 'react';
import { api, errMsg, fmtDate } from '../api';
import { useAuth } from '../auth';
import { Spinner, Tabs, useToast, TextField, SelectField, CheckField, StatCard, Modal } from '../components/ui';
import DataTable from '../components/DataTable';

export default function Settings() {
  const { me, can } = useAuth();
  const toast = useToast();
  const [tab, setTab] = useState('company');
  const [company, setCompany] = useState(null);
  const [branding, setBranding] = useState(null);
  const [users, setUsers] = useState(null);
  const [roles, setRoles] = useState(null);
  const [notifCfg, setNotifCfg] = useState(null);
  const [audit, setAudit] = useState(null);
  const [states, setStates] = useState([]);
  const [addingUser, setAddingUser] = useState(false);
  const [userForm, setUserForm] = useState({});
  const [newPassword, setNewPassword] = useState({});
  const [pwForm, setPwForm] = useState({});

  const load = async () => {
    try {
      const [c, s] = await Promise.all([api.get('/admin/company'), api.get('/org/states')]);
      setCompany(c.data.data || {});
      setStates(s.data.data);
      setBranding({ ...me?.branding });
    } catch (e) { toast(errMsg(e), true); }
    if (can('user.manage')) {
      api.get('/admin/users').then(({ data }) => setUsers(data.data)).catch(() => {});
      api.get('/admin/roles').then(({ data }) => setRoles(data.data)).catch(() => {});
    }
  };
  useEffect(() => { load(); }, []); // eslint-disable-line

  useEffect(() => {
    if (tab === 'notifications') api.get('/admin/settings/notifications').then(({ data }) => setNotifCfg(data.data)).catch(() => {});
    if (tab === 'audit') api.get('/admin/audit').then(({ data }) => setAudit(data.data)).catch(() => {});
  }, [tab]);

  const saveCompany = async () => {
    try { await api.put('/admin/company', company); toast('Company profile saved'); }
    catch (e) { toast(errMsg(e), true); }
  };
  const saveBranding = async () => {
    try {
      await api.put('/admin/branding', branding);
      toast('Branding saved — refresh to see new theme');
      document.documentElement.style.setProperty('--primary', branding.primaryColor || '#1d4ed8');
    } catch (e) { toast(errMsg(e), true); }
  };
  const saveNotif = async () => {
    try { await api.put('/admin/settings/notifications', notifCfg); toast('Notification settings saved'); }
    catch (e) { toast(errMsg(e), true); }
  };

  const addUser = async () => {
    try {
      const { data } = await api.post('/admin/users', userForm);
      setNewPassword({ email: userForm.email, password: data.tempPassword });
      setAddingUser(false);
      load();
    } catch (e) { toast(errMsg(e), true); }
  };

  const changeMyPassword = async () => {
    try {
      await api.post('/auth/change-password', pwForm);
      toast('Password changed');
      setPwForm({});
    } catch (e) { toast(errMsg(e), true); }
  };

  const setCompanyF = (k) => (v) => setCompany((c) => ({ ...c, [k]: v }));
  const setB = (k) => (v) => setBranding((b) => ({ ...b, [k]: v }));
  const setN = (k) => (v) => setNotifCfg((n) => ({ ...n, [k]: v }));

  if (company === null) return <Spinner />;

  return (
    <div>
      <Tabs active={tab} onChange={setTab} tabs={[
        { key: 'company', label: 'Company profile' },
        { key: 'branding', label: 'Branding / white-label' },
        ...(can('user.manage') ? [{ key: 'users', label: 'Users & roles' }] : []),
        ...(can('settings.view') ? [{ key: 'notifications', label: 'Notifications' }] : []),
        ...(can('audit.view') ? [{ key: 'audit', label: 'Audit log' }] : []),
        { key: 'security', label: 'My security' },
      ]} />

      {tab === 'company' && (
        <div className="card">
          <div className="card-h"><h3>Legal entity & statutory identifiers</h3>
            {can('settings.manage') && <button className="btn sm" onClick={saveCompany}>Save</button>}
          </div>
          <div className="card-b">
            <div className="form-grid">
              <TextField label="Legal name" value={company.legal_name} onChange={setCompanyF('legal_name')} />
              <TextField label="Trade name" value={company.trade_name} onChange={setCompanyF('trade_name')} />
              <TextField label="CIN" value={company.cin} onChange={setCompanyF('cin')} />
              <TextField label="PAN" value={company.pan} onChange={setCompanyF('pan')} />
              <TextField label="TAN" value={company.tan} onChange={setCompanyF('tan')} />
              <TextField label="GSTIN" value={company.gstin} onChange={setCompanyF('gstin')} />
              <TextField label="Address line 1" value={company.address_line1} onChange={setCompanyF('address_line1')} />
              <TextField label="Address line 2" value={company.address_line2} onChange={setCompanyF('address_line2')} />
              <TextField label="City" value={company.city} onChange={setCompanyF('city')} />
              <SelectField label="State (place of supply for GST)" value={company.state_code} onChange={(v) => setCompany((c) => ({ ...c, state_code: v, state: states.find((s) => s.code === v)?.name }))}
                options={states.map((s) => ({ value: s.code, label: `${s.name} (${s.code})` }))} />
              <TextField label="Pincode" value={company.pincode} onChange={setCompanyF('pincode')} />
              <TextField label="Contact email" value={company.contact_email} onChange={setCompanyF('contact_email')} />
              <TextField label="Contact phone" value={company.contact_phone} onChange={setCompanyF('contact_phone')} />
            </div>
          </div>
        </div>
      )}

      {tab === 'branding' && (
        <div className="card">
          <div className="card-h"><h3>White-label branding</h3>
            {can('settings.manage') && <button className="btn sm" onClick={saveBranding}>Save & apply</button>}
          </div>
          <div className="card-b">
            <div className="form-grid">
              <TextField label="Company display name" value={branding?.companyName || ''} onChange={setB('companyName')} />
              <TextField label="Primary color" type="color" value={branding?.primaryColor || '#1d4ed8'} onChange={setB('primaryColor')} hint="Applies instantly across the app (white-label)" />
              <TextField label="Support email" value={branding?.supportEmail || ''} onChange={setB('supportEmail')} />
              <TextField label="Login tagline" value={branding?.loginTagline || ''} onChange={setB('loginTagline')} />
              <TextField label="Logo URL" value={branding?.logoUrl || ''} onChange={setB('logoUrl')} hint="Optional — shown in sidebar and login" />
            </div>
          </div>
        </div>
      )}

      {tab === 'users' && users && (
        <div className="grid c2">
          <DataTable
            columns={[
              { key: 'name', label: 'User' }, { key: 'email', label: 'Email' },
              { key: 'role', label: 'Role', render: (r) => <span className="badge gray">{r.role.replace(/_/g, ' ')}</span> },
              { key: 'status', label: 'Status', render: (r) => <span className={'badge ' + (r.status === 'active' ? 'green' : 'red')}>{r.status}</span> },
              { key: 'last_login_at', label: 'Last login', render: (r) => (r.last_login_at ? fmtDate(r.last_login_at, true) : '—') },
            ]}
            rows={users}
            toolbar={<button className="btn sm" onClick={() => { setUserForm({ role: 'employee' }); setAddingUser(true); }}>+ Add user</button>}
            actions={(r) => (
              <div className="row">
                <select className="btn sm secondary" value={r.role} onChange={async (e) => { await api.put(`/admin/users/${r.id}`, { role: e.target.value }); toast('Role updated'); load(); }}>
                  {['employee', 'manager', 'department_head', 'hr_admin', 'recruiter', 'payroll_admin', 'finance_admin', 'company_owner', 'auditor'].map((role) => <option key={role} value={role}>{role.replace(/_/g, ' ')}</option>)}
                </select>
                <button className="btn ghost sm" style={{ color: r.status === 'active' ? 'var(--red)' : 'var(--green)' }}
                  onClick={async () => { await api.put(`/admin/users/${r.id}`, { status: r.status === 'active' ? 'disabled' : 'active' }); load(); }}>
                  {r.status === 'active' ? 'Disable' : 'Enable'}
                </button>
              </div>
            )}
          />
          <div className="card">
            <div className="card-h"><h3>Role permission sets</h3></div>
            <div className="card-b">
              {(roles || []).map((r) => (
                <div key={r.id} style={{ padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
                  <b style={{ fontSize: 13.5 }}>{r.label}</b>
                  <div style={{ fontSize: 12, color: 'var(--muted)' }}>{r.permissions.length} permissions · {r.permissions.slice(0, 6).join(', ')}{r.permissions.length > 6 ? '…' : ''}</div>
                </div>
              ))}
              <p className="hint" style={{ fontSize: 12, color: 'var(--muted)', marginTop: 10 }}>
                Permissions use <code>module.action[:scope]</code> with scopes own / team / department / company. Role edits apply to new logins immediately.
              </p>
            </div>
          </div>
        </div>
      )}

      {tab === 'notifications' && notifCfg && (
        <div className="card">
          <div className="card-h"><h3>Email / SMTP configuration</h3><button className="btn sm" onClick={saveNotif}>Save</button></div>
          <div className="card-b">
            <div className="info-box">
              Without SMTP configured, emails are logged as "skipped" in the delivery log and in-app notifications still work — so the demo runs out of the box.
            </div>
            <div className="form-grid">
              <TextField label="SMTP host" value={notifCfg.smtpHost || ''} onChange={setN('smtpHost')} />
              <TextField label="SMTP port" type="number" value={notifCfg.smtpPort || 587} onChange={setN('smtpPort')} />
              <TextField label="SMTP user" value={notifCfg.smtpUser || ''} onChange={setN('smtpUser')} />
              <TextField label="SMTP password" type="password" value={notifCfg.smtpPass || ''} onChange={setN('smtpPass')} />
              <TextField label="From name" value={notifCfg.fromName || ''} onChange={setN('fromName')} />
              <TextField label="From email" value={notifCfg.fromEmail || ''} onChange={setN('fromEmail')} />
            </div>
          </div>
        </div>
      )}

      {tab === 'audit' && audit && (
        <div className="card">
          <div className="card-h"><h3>Audit trail ({audit.meta?.total ?? audit.length})</h3></div>
          <div className="table-wrap" style={{ maxHeight: 520, overflow: 'auto' }}>
            <table className="tbl">
              <thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Entity</th><th>IP</th></tr></thead>
              <tbody>
                {audit.data.map((a) => (
                  <tr key={a.id}>
                    <td style={{ whiteSpace: 'nowrap' }}>{fmtDate(a.created_at, true)}</td>
                    <td>{a.actor_name} <span style={{ color: 'var(--muted)', fontSize: 11.5 }}>({a.actor_role?.replace(/_/g, ' ')})</span></td>
                    <td><code style={{ fontSize: 11.5 }}>{a.action}</code></td>
                    <td>{a.entity_type}{a.entity_id ? ` #${a.entity_id}` : ''}</td>
                    <td style={{ fontSize: 11.5, color: 'var(--muted)' }}>{a.ip || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'security' && (
        <div className="card" style={{ maxWidth: 480 }}>
          <div className="card-h"><h3>Change my password</h3></div>
          <div className="card-b">
            <TextField label="Current password" type="password" value={pwForm.currentPassword} onChange={(v) => setPwForm((f) => ({ ...f, currentPassword: v }))} />
            <TextField label="New password (min 8 chars)" type="password" value={pwForm.newPassword} onChange={(v) => setPwForm((f) => ({ ...f, newPassword: v }))} />
            <button className="btn" onClick={changeMyPassword}>Update password</button>
            <p className="hint" style={{ fontSize: 12, color: 'var(--muted)', marginTop: 14 }}>
              Changing your password revokes all other sessions (refresh-token rotation with revocation).
            </p>
          </div>
        </div>
      )}

      {addingUser && (
        <Modal title="Add user" onClose={() => setAddingUser(false)} footer={
          <><button className="btn secondary" onClick={() => setAddingUser(false)}>Cancel</button><button className="btn" onClick={addUser}>Create</button></>
        }>
          <TextField label="Name *" value={userForm.name} onChange={(v) => setUserForm((f) => ({ ...f, name: v }))} />
          <TextField label="Email *" type="email" value={userForm.email} onChange={(v) => setUserForm((f) => ({ ...f, email: v }))} />
          <SelectField label="Role *" value={userForm.role} onChange={(v) => setUserForm((f) => ({ ...f, role: v }))}
            options={['employee', 'manager', 'department_head', 'hr_admin', 'recruiter', 'payroll_admin', 'finance_admin', 'company_owner', 'auditor'].map((r) => ({ value: r, label: r.replace(/_/g, ' ') }))} />
        </Modal>
      )}
      {newPassword.email && (
        <Modal title="User created" onClose={() => setNewPassword({})} footer={<button className="btn" onClick={() => setNewPassword({})}>Done</button>}>
          <div className="info-box">Share the temporary password — the user must change it at first login (Settings → My security).</div>
          <p><code>{newPassword.email}</code> / <code>{newPassword.password}</code></p>
        </Modal>
      )}
    </div>
  );
}
