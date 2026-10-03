import React, { useState } from 'react';
import { api, errMsg, fmtDate } from '../../api';
import { Empty, Modal, SelectField, TextAreaField, TextField, useToast } from '../../components/ui';
import { PlatformTable, EmptyState } from '../../components/PlatformTable';
import { PageHeader, PlatformSection, useLoader, usePlatform } from './shared';

export default function PlatformOperators() {
  return (
    <PlatformSection perm="platform.users.view">
      <Operators />
    </PlatformSection>
  );
}

function Operators() {
  const { can } = usePlatform();
  const toast = useToast();
  const [modal, setModal] = useState(null);
  const { data, raw, loading, error, reload } = useLoader(async () => {
    const { data } = await api.get('/platform/operators');
    return data;
  }, []);
  const rows = data || [];
  const roles = raw?.roles || [];
  const manage = can('platform.users.manage');

  return (
    <div>
      <PageHeader title="Platform operators"
        sub="ARTHVEX staff accounts. They belong to no company; each holds one narrow platform role, and reaching a customer's data always goes through Support Access."
        actions={manage && <button className="btn" onClick={() => setModal({ type: 'new' })}>Add operator</button>} />
      <div className="card">
        <PlatformTable
          id="operators"
          rows={rows}
          loading={loading}
          error={error}
          onRetry={reload}
          searchPlaceholder="Search operators…"
          columns={[
            { key: 'name', label: 'Name', sortable: true, render: (u) => <strong>{u.name}</strong> },
            { key: 'email', label: 'Email', sortable: true },
            { key: 'roleLabel', label: 'Role', sortable: true, render: (u) => <span className="badge purple">{u.roleLabel}</span> },
            { key: 'status', label: 'Status', sortable: true, render: (u) => <span className={'badge ' + (u.status === 'active' ? 'green' : 'gray')}>{u.status}</span> },
            { key: 'mfa_enabled', label: 'MFA', sortable: true, render: (u) => (u.mfa_enabled ? <span className="badge green">On</span> : <span className="badge amber">Off</span>) },
            { key: 'last_login_at', label: 'Last sign-in', sortable: true, render: (u) => (u.last_login_at ? fmtDate(u.last_login_at, true) : 'never') },
            { key: 'actions', label: '', render: (u) => (
              <span className="actions">
                {manage && <button className="btn ghost sm" onClick={() => setModal({ type: 'edit', u })}>Edit</button>}
                {manage && u.mfa_enabled ? <button className="btn ghost sm" onClick={() => setModal({ type: 'mfa', u })}>Reset MFA</button> : null}
              </span>) },
          ]}
          empty={<EmptyState title="No operators" text="Add the first ARTHVEX staff account." />}
        />
      </div>
      {modal?.type === 'new' && <NewOperator roles={roles} onClose={() => setModal(null)} onDone={() => { reload(); }} />}
      {modal?.type === 'edit' && <EditOperator u={modal.u} roles={roles} onClose={() => setModal(null)} onDone={() => { reload(); setModal(null); toast('Operator updated'); }} />}
      {modal?.type === 'mfa' && <ResetMfa u={modal.u} onClose={() => setModal(null)} onDone={() => { reload(); setModal(null); toast('MFA reset — they must enrol again'); }} />}
    </div>
  );
}

function NewOperator({ roles, onClose, onDone }) {
  const [f, setF] = useState({ name: '', email: '', role: '', reason: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [created, setCreated] = useState(null);
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v }));
  const submit = async () => {
    setBusy(true); setError('');
    try { const { data } = await api.post('/platform/operators', f); setCreated(data); onDone(); } catch (e) { setError(errMsg(e)); }
    setBusy(false);
  };
  if (created) {
    return (
      <Modal title="Operator created" onClose={onClose} footer={<button className="btn" onClick={onClose}>Done</button>}>
        <div className="info-box">Share this temporary password securely. It is shown <b>once</b> and must be changed at first sign-in.</div>
        <p className="mt"><b>{created.data.email}</b></p>
        <code style={{ fontSize: 15, userSelect: 'all' }}>{created.tempPassword}</code>
      </Modal>
    );
  }
  return (
    <Modal title="Add platform operator" onClose={onClose}
      footer={<><button className="btn secondary" onClick={onClose}>Cancel</button><button className="btn" disabled={busy || !f.name || !f.email || !f.role || f.reason.trim().length < 5} onClick={submit}>Create</button></>}>
      <TextField label="Name" value={f.name} onChange={set('name')} />
      <TextField label="Email" value={f.email} onChange={set('email')} />
      <SelectField label="Role" value={f.role} onChange={set('role')} options={roles.map((r) => ({ value: r.key, label: r.label }))} />
      <TextAreaField label="Reason *" value={f.reason} onChange={set('reason')} />
      {error && <div className="error-box mt">{error}</div>}
    </Modal>
  );
}

function EditOperator({ u, roles, onClose, onDone }) {
  const [role, setRole] = useState(u.role);
  const [status, setStatus] = useState(u.status);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const submit = async () => {
    try { await api.patch(`/platform/operators/${u.id}`, { role, status, reason }); onDone(); } catch (e) { setError(errMsg(e)); }
  };
  return (
    <Modal title={`Edit ${u.name}`} onClose={onClose}
      footer={<><button className="btn secondary" onClick={onClose}>Cancel</button><button className="btn" disabled={reason.trim().length < 5} onClick={submit}>Save</button></>}>
      <SelectField label="Role" value={role} onChange={setRole} options={roles.map((r) => ({ value: r.key, label: r.label }))} />
      <SelectField label="Status" value={status} onChange={setStatus} options={[{ value: 'active', label: 'Active' }, { value: 'disabled', label: 'Disabled (sessions revoked)' }]} />
      <TextAreaField label="Reason *" value={reason} onChange={setReason} />
      {error && <div className="error-box mt">{error}</div>}
    </Modal>
  );
}

function ResetMfa({ u, onClose, onDone }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const submit = async () => {
    try { await api.post(`/platform/operators/${u.id}/reset-mfa`, { reason }); onDone(); } catch (e) { setError(errMsg(e)); }
  };
  return (
    <Modal title={`Reset MFA for ${u.name}`} onClose={onClose}
      footer={<><button className="btn secondary" onClick={onClose}>Cancel</button><button className="btn danger" disabled={reason.trim().length < 5} onClick={submit}>Reset</button></>}>
      <div className="info-box mb">Their authenticator is removed and every session is signed out.</div>
      <TextAreaField label="Reason *" value={reason} onChange={setReason} />
      {error && <div className="error-box mt">{error}</div>}
    </Modal>
  );
}
