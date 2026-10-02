import React, { useState } from 'react';
import { api, errMsg, fmtDate } from '../../api';
import { useAuth } from '../../auth';
import DataTable from '../../components/DataTable';
import { Confirm, Modal, SelectField, StatCard, Tabs, TextField, useToast } from '../../components/ui';
import { AdminSection, PageHeader, listLoader, num, useLoader } from './shared';

const SCOPE = [{ value: 'allow', label: 'Allow' }, { value: 'deny', label: 'Deny' }];
const APPLIES = [
  { value: 'admin', label: 'Administration' },
  { value: 'all', label: 'Everything' },
];

export default function AdminSecurity() {
  return (
    <AdminSection sectionKey="security">
      <Security />
    </AdminSection>
  );
}

function Security() {
  const [tab, setTab] = useState('policies');
  return (
    <div>
      <PageHeader
        title="Security"
        sub="Password, session and access policies for this company, plus the IP ranges allowed to reach them."
      />
      <Tabs
        tabs={[
          { key: 'policies', label: 'Policies' },
          { key: 'overview', label: 'Posture' },
          { key: 'ips', label: 'IP restrictions' },
        ]}
        active={tab}
        onChange={setTab}
      />
      {tab === 'policies' && <Policies />}
      {tab === 'overview' && <Overview />}
      {tab === 'ips' && <IpRestrictions />}
    </div>
  );
}

/** Effective policy values: company override, else platform default. */
function Policies() {
  const { can } = useAuth();
  const toast = useToast();
  const { data, loading, reload } = useLoader(listLoader('/administration/security/policies'), []);
  const [editing, setEditing] = useState(null);
  const [value, setValue] = useState('');
  const [resetting, setResetting] = useState(null);

  const canManage = can('administration.security.manage');
  const open = (p) => { setEditing(p); setValue(p.value); };
  const setF = (k) => (v) => setValue(v);

  const save = async () => {
    try {
      let payload = value;
      if (editing.type === 'boolean') payload = value === true || value === 'true';
      else if (editing.type === 'number') payload = Number(value);
      await api.put(`/administration/security/policies/${editing.key}`, { value: payload });
      toast('Policy updated');
      setEditing(null);
      reload();
    } catch (e) { toast(errMsg(e), true); }
  };

  const doReset = async () => {
    try {
      await api.post(`/administration/security/policies/${resetting.key}/reset`);
      toast('Override removed');
      setResetting(null);
      reload();
    } catch (e) { toast(errMsg(e), true); }
  };

  const renderValue = (p) => {
    if (typeof p.value === 'boolean') return <span className={'badge ' + (p.value ? 'green' : 'gray')}>{p.value ? 'enabled' : 'disabled'}</span>;
    if (p.value === null || p.value === undefined) return <span style={{ color: 'var(--muted)' }}>not set</span>;
    return <strong>{String(p.value)}</strong>;
  };

  return (
    <>
      <div className="row mb" style={{ gap: 8 }}>
        <span className="badge gray">{num(data?.length)} policies</span>
        <span className="badge amber">{num((data || []).filter((p) => p.overridden).length)} overridden</span>
      </div>
      <DataTable
        rows={data}
        loading={loading}
        columns={[
          { key: 'key', label: 'Policy', render: (r) => <code style={{ fontSize: 12 }}>{r.key}</code> },
          { key: 'description', label: 'What it does', render: (r) => <span style={{ color: 'var(--muted)', fontSize: 12.5 }}>{r.description || '—'}</span> },
          { key: 'value', label: 'Effective', render: renderValue },
          {
            key: 'default', label: 'Platform default',
            render: (r) => (typeof r.default === 'boolean' ? String(r.default) : (r.default ?? '—')),
          },
          { key: 'overridden', label: 'Source', render: (r) => (r.overridden ? <span className="badge amber">this company</span> : <span className="badge gray">platform</span>) },
        ]}
        actions={(row) => (canManage ? (
          <>
            <button className="btn ghost sm" onClick={() => open(row)}>Set</button>
            {row.overridden && <button className="btn ghost sm" onClick={() => setResetting(row)}>Reset</button>}
          </>
        ) : null)}
      />

      {editing && (
        <Modal title={editing.key} onClose={() => setEditing(null)}
          footer={<><button className="btn secondary" onClick={() => setEditing(null)}>Cancel</button><button className="btn" onClick={save}>Save</button></>}>
          <div className="info-box">{editing.description || `Current value: ${editing.value}`}</div>
          {editing.type === 'boolean' ? (
            <label className="check">
              <input type="checkbox" checked={value === true} onChange={(e) => setValue(e.target.checked)} />
              Enabled
            </label>
          ) : (
            <TextField
              label="Value"
              type={editing.type === 'number' ? 'number' : 'text'}
              value={value ?? ''}
              onChange={setF('value')}
              min={editing.min ?? undefined}
              max={editing.max ?? undefined}
            />
          )}
        </Modal>
      )}

      {resetting && (
        <Confirm
          title="Reset policy?"
          message={`“${resetting.key}” returns to the platform default (${resetting.default ?? 'unset'}).`}
          onYes={doReset}
          onClose={() => setResetting(null)}
        />
      )}
    </>
  );
}

function Overview() {
  const { data } = useLoader(listLoader('/administration/security/overview'), []);
  if (!data) return null;
  const u = data.users || {};
  const s = data.sessions || {};
  return (
    <div>
      <div className="stat-grid mb">
        <StatCard label="Active logins" value={num(u.active)} sub={`${num(u.total)} total`} />
        <StatCard label="Suspended / disabled" value={num(Number(u.suspended || 0) + Number(u.disabled || 0))} />
        <StatCard label="Locked out" value={num(u.locked)} sub="temporary lockouts" />
        <StatCard label="Must change password" value={num(u.must_change)} />
        <StatCard label="Active sessions" value={num(s.active_sessions)} sub={`${num(s.users_with_sessions)} people`} />
        <StatCard label="Dormant accounts" value={num(data.dormantAccounts)} sub="no login in 90 days" />
        <StatCard label="Failed logins (7d)" value={num(data.recentFailures)} />
        <StatCard label="IP restrictions" value={num(data.activeIpRestrictions)} sub={`${num(data.activeDelegations)} delegations`} />
      </div>
      <div className="info-box">
        Failed-login spikes usually mean a password-spray attempt. Locked accounts and the IP list below are the first
        two things to check.
      </div>
    </div>
  );
}

function IpRestrictions() {
  const { can } = useAuth();
  const toast = useToast();
  const { data, loading, reload } = useLoader(listLoader('/administration/security/ip-restrictions'), []);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ cidr: '', scope: 'allow', applies_to: 'admin', note: '' });
  const [deleting, setDeleting] = useState(null);

  const canManage = can('administration.security.manage');

  const add = async () => {
    try {
      await api.post('/administration/security/ip-restrictions', form);
      toast('Restriction added');
      setAdding(false);
      setForm({ cidr: '', scope: 'allow', applies_to: 'admin', note: '' });
      reload();
    } catch (e) { toast(errMsg(e), true); }
  };

  const doDelete = async () => {
    try {
      await api.delete(`/administration/security/ip-restrictions/${deleting.id}`);
      toast('Restriction removed');
      setDeleting(null);
      reload();
    } catch (e) { toast(errMsg(e), true); }
  };

  return (
    <>
      <div className="row mb" style={{ justifyContent: 'flex-end' }}>
        {canManage && <button className="btn sm" onClick={() => setAdding(true)}>+ Add range</button>}
      </div>
      <DataTable
        rows={data}
        loading={loading}
        columns={[
          { key: 'cidr', label: 'Range', render: (r) => <code style={{ fontSize: 12 }}>{r.cidr}</code> },
          { key: 'scope', label: 'Action', render: (r) => <span className={'badge ' + (r.scope === 'deny' ? 'red' : 'green')}>{r.scope}</span> },
          { key: 'applies_to', label: 'Applies to' },
          { key: 'note', label: 'Note' },
          { key: 'active', label: 'State', render: (r) => <span className={'badge ' + (r.active ? 'green' : 'gray')}>{r.active ? 'active' : 'inactive'}</span> },
          { key: 'created_at', label: 'Added', render: (r) => fmtDate(r.created_at) },
        ]}
        actions={(row) => (canManage ? <button className="btn ghost sm" style={{ color: 'var(--red)' }} onClick={() => setDeleting(row)}>Remove</button> : null)}
      />

      {adding && (
        <Modal title="Add IP restriction" onClose={() => setAdding(false)}
          footer={<><button className="btn secondary" onClick={() => setAdding(false)}>Cancel</button><button className="btn" onClick={add} disabled={!form.cidr}>Add</button></>}>
          <div className="form-grid">
            <TextField label="Address or CIDR" value={form.cidr} onChange={(v) => setForm((f) => ({ ...f, cidr: v }))} placeholder="203.0.113.0/24" />
            <SelectField label="Action" value={form.scope} onChange={(v) => setForm((f) => ({ ...f, scope: v }))} options={SCOPE} />
            <SelectField label="Applies to" value={form.applies_to} onChange={(v) => setForm((f) => ({ ...f, applies_to: v }))} options={APPLIES} />
            <TextField label="Note" value={form.note} onChange={(v) => setForm((f) => ({ ...f, note: v }))} />
          </div>
        </Modal>
      )}

      {deleting && (
        <Confirm title="Remove restriction?" message={`${deleting.cidr} will no longer be ${deleting.scope === 'deny' ? 'blocked' : 'allowed'}.`} danger onYes={doDelete} onClose={() => setDeleting(null)} />
      )}
    </>
  );
}