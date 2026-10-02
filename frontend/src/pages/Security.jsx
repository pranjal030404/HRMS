import React, { useEffect, useState } from 'react';
import { api, errMsg, fmtDate } from '../api';
import { useAuth } from '../auth';
import { useToast, Modal, Tabs, StatusBadge, Empty, Spinner } from '../components/ui';
import DataTable from '../components/DataTable';

export default function Security() {
  const { me, logout } = useAuth();
  const toast = useToast();
  const [tab, setTab] = useState('mfa');
  const [mfaStatus, setMfaStatus] = useState(null);
  const [sessions, setSessions] = useState(null);
  const [history, setHistory] = useState(null);
  const [setup, setSetup] = useState(null); // {secret, url}
  const [code, setCode] = useState('');
  const [disablePwd, setDisablePwd] = useState('');
  const [disableOpen, setDisableOpen] = useState(false);

  const load = async () => {
    try {
      const [s, ses, h] = (await Promise.all([
        api.get('/auth/mfa/status'), api.get('/auth/sessions'), api.get('/auth/my/login-history'),
      ])).map((x) => x.data.data);
      setMfaStatus(s); setSessions(ses); setHistory(h);
    } catch (e) { toast(errMsg(e), true); }
  };
  useEffect(() => { load(); }, []); // eslint-disable-line

  const startSetup = async () => {
    try {
      const { data } = await api.post('/auth/mfa/setup');
      setSetup(data.data);
    } catch (e) { toast(errMsg(e), true); }
  };

  const confirmEnable = async () => {
    try {
      await api.post('/auth/mfa/enable', { code });
      toast('MFA enabled — you will be asked for a code at next login');
      setSetup(null); setCode(''); load();
    } catch (e) { toast(errMsg(e), true); }
  };

  const disable = async () => {
    try {
      await api.post('/auth/mfa/disable', { password: disablePwd });
      toast('MFA disabled');
      setDisableOpen(false); setDisablePwd(''); load();
    } catch (e) { toast(errMsg(e), true); }
  };

  const revokeSession = async (id) => {
    try { await api.delete(`/auth/sessions/${id}`); toast('Session revoked'); load(); } catch (e) { toast(errMsg(e), true); }
  };

  const revokeOthers = async () => {
    try { await api.post('/auth/sessions/revoke-others'); toast('All other sessions revoked'); load(); } catch (e) { toast(errMsg(e), true); }
  };

  if (!sessions) return <Spinner />;

  return (
    <>
      <div className="mt"><Tabs active={tab} onChange={setTab} tabs={[
        { key: 'mfa', label: 'Two-Factor Auth' }, { key: 'sessions', label: 'Devices & Sessions' }, { key: 'history', label: 'Login History' },
      ]} /></div>

      {tab === 'mfa' && (
        <div className="card mt" style={{ maxWidth: 560 }}>
          <div className="card-h spread">
            <h3>Authenticator app (TOTP)</h3>
            {mfaStatus?.enabled ? <span className="badge green">Enabled</span> : <span className="badge gray">Disabled</span>}
          </div>
          <div style={{ padding: 14 }}>
            {mfaStatus?.enabled ? (
              <>
                <p style={{ fontSize: 13.5 }}>Your account requires a 6-digit authenticator code at login. Privileged accounts are strongly encouraged to keep this on (spec §12).</p>
                <button className="btn danger" onClick={() => setDisableOpen(true)}>Disable MFA</button>
              </>
            ) : setup ? (
              <>
                <p style={{ fontSize: 13.5 }}>1. Add this secret to Google Authenticator / 1Password / Authy:</p>
                <div className="card" style={{ fontFamily: 'monospace', fontSize: 16, letterSpacing: 2, textAlign: 'center', margin: '10px 0' }}>{setup.secret}</div>
                <p style={{ fontSize: 12.5, color: 'var(--muted)', wordBreak: 'break-all' }}>Or scan the otpauth URL: {setup.url}</p>
                <p style={{ fontSize: 13.5 }}>2. Enter the current 6-digit code to confirm:</p>
                <div className="row" style={{ gap: 8 }}>
                  <input inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} placeholder="000000" style={{ width: 120 }} />
                  <button className="btn" onClick={confirmEnable}>Verify & enable</button>
                  <button className="btn ghost" onClick={() => setSetup(null)}>Cancel</button>
                </div>
              </>
            ) : (
              <>
                <p style={{ fontSize: 13.5 }}>Add a time-based one-time password (TOTP) second factor to your login. Recommended for HR, payroll and admin users.</p>
                <button className="btn" onClick={startSetup}>Set up authenticator</button>
              </>
            )}
          </div>
        </div>
      )}

      {tab === 'sessions' && (
        <div className="card mt">
          <div className="card-h spread">
            <h3>Active devices & sessions</h3>
            <button className="btn sm danger ghost" onClick={revokeOthers}>Revoke other sessions</button>
          </div>
          <DataTable
            columns={[
              { key: 'device', label: 'Device', render: (r) => <>{(r.user_agent || 'Unknown device').slice(0, 60)}{r.current && <span className="badge green" style={{ marginLeft: 8 }}>This device</span>}</> },
              { key: 'ip', label: 'IP', render: (r) => r.ip || '—' },
              { key: 'created_at', label: 'Signed in', render: (r) => fmtDate(r.created_at, true) },
              { key: 'expires_at', label: 'Expires', render: (r) => fmtDate(r.expires_at, true) },
              { key: 'revoked_at', label: 'Status', render: (r) => r.revoked_at ? <span className="badge red">Revoked</span> : <span className="badge green">Active</span> },
            ]}
            rows={sessions}
            emptyText="No sessions"
            actions={(r) => !r.current && !r.revoked_at ? (
              <button className="btn ghost sm danger" onClick={() => revokeSession(r.id)}>Revoke</button>
            ) : null}
          />
        </div>
      )}

      {tab === 'history' && (
        <div className="card mt">
          <div className="card-h"><h3>My login history</h3></div>
          <DataTable
            columns={[
              { key: 'event', label: 'Event', render: (r) => <StatusBadge value={r.event} labels={{ login: ['green', 'Login'], login_failed: ['red', 'Failed'], logout: ['gray', 'Logout'], mfa_failed: ['red', 'MFA Failed'], suspicious: ['red', 'Suspicious'] }} /> },
              { key: 'ip', label: 'IP', render: (r) => r.ip || '—' },
              { key: 'user_agent', label: 'User agent', render: (r) => (r.user_agent || '—').slice(0, 50) },
              { key: 'details', label: 'Details', render: (r) => r.details || '—' },
              { key: 'created_at', label: 'When', render: (r) => fmtDate(r.created_at, true) },
            ]}
            rows={history}
            emptyText="No login history yet"
          />
        </div>
      )}

      {disableOpen && (
        <Modal title="Disable MFA" onClose={() => setDisableOpen(false)} footer={
          <>
            <button className="btn secondary" onClick={() => setDisableOpen(false)}>Cancel</button>
            <button className="btn danger" onClick={disable}>Disable</button>
          </>
        }>
          <p>Confirm your password to disable two-factor authentication.</p>
          <input type="password" value={disablePwd} onChange={(e) => setDisablePwd(e.target.value)} placeholder="Current password" />
        </Modal>
      )}
    </>
  );
}
