import React, { useEffect, useState } from 'react';
import { api, errMsg, fmtDate } from '../../api';
import { CheckField, Empty, Modal, TextAreaField, TextField, useToast } from '../../components/ui';
import { PageHeader, PlatformSection, useLoader, usePlatform } from './shared';

export default function PlatformSecurity() {
  return (
    <PlatformSection perm="platform.security.view">
      <Security />
    </PlatformSection>
  );
}

function Security() {
  const { can } = usePlatform();
  const toast = useToast();
  const manage = can('platform.security.manage');
  const { data, loading, reload } = useLoader(async () => (await api.get('/platform/security')).data.data, []);
  const [mfa, setMfa] = useState(false);
  const [ips, setIps] = useState('');
  const [hours, setHours] = useState('0');
  const [asking, setAsking] = useState(false);
  const [revoking, setRevoking] = useState(null);

  useEffect(() => {
    if (!data) return;
    setMfa(!!data.policy.mfaRequired);
    setIps((data.policy.ipAllowlist || []).join('\n'));
    setHours(String(data.policy.sessionMaxHours || 0));
  }, [data]);

  if (loading || !data) return <div className="spinner" />;
  const pct = data.operators.total ? Math.round((data.operators.withMfa / data.operators.total) * 100) : 0;

  return (
    <div>
      <PageHeader title="Platform security"
        sub="Policy for ARTHVEX staff only. A company's own security settings are separate and cannot loosen these." />
      <div className="stat-grid mb">
        <div className="card stat"><div className="lbl">Operators with MFA</div><div className="val">{data.operators.withMfa}/{data.operators.total}</div><div className="sub">{pct}% enrolled</div></div>
        <div className="card stat"><div className="lbl">Active sessions</div><div className="val">{data.sessions.length}</div></div>
        <div className="card stat"><div className="lbl">Failed / suspicious (24h)</div><div className="val" style={{ color: data.failedLast24h ? '#b42318' : undefined }}>{data.failedLast24h}</div></div>
        <div className="card stat"><div className="lbl">Your address</div><div className="val" style={{ fontSize: 18 }}>{data.yourIp}</div></div>
      </div>

      <div className="card mb">
        <div className="card-h"><h3>Policy</h3></div>
        <div className="card-b">
          <CheckField label="Require MFA for every platform operator" checked={mfa} onChange={setMfa} />
          <p className="hint" style={{ margin: '2px 0 12px' }}>Operators without MFA are blocked from the console until they enrol.</p>
          <TextAreaField label="Network allowlist (one IPv4 address or CIDR per line)" rows={4} value={ips} onChange={setIps}
            hint="Empty means any address. A list that would lock you out is refused." />
          <TextField label="Maximum session age, hours (0 = default)" type="number" value={hours} onChange={setHours} />
          {manage ? <button className="btn" onClick={() => setAsking(true)}>Save policy…</button> : <p className="hint">Read-only for your role.</p>}
        </div>
      </div>

      <div className="grid c2">
        <div className="card">
          <div className="card-h"><h3>Active operator sessions</h3></div>
          <div className="table-wrap"><table className="tbl">
            <thead><tr><th>Operator</th><th>From</th><th>Started</th><th /></tr></thead>
            <tbody>
              {!data.sessions.length && <tr><td colSpan={4}><Empty text="No active sessions" /></td></tr>}
              {data.sessions.map((s) => (
                <tr key={s.id}>
                  <td>{s.name}<div style={{ fontSize: 11, color: 'var(--muted)' }}>{s.email}</div></td>
                  <td style={{ fontSize: 12 }}>{s.ip}</td><td style={{ fontSize: 12 }}>{fmtDate(s.created_at, true)}</td>
                  <td className="actions">{manage && <button className="btn ghost sm" onClick={() => setRevoking(s)}>Revoke</button>}</td>
                </tr>
              ))}
            </tbody></table></div>
        </div>
        <div className="card">
          <div className="card-h"><h3>Sign-in events</h3></div>
          <div className="table-wrap"><table className="tbl">
            <thead><tr><th>When</th><th>Who</th><th>Event</th><th>IP</th></tr></thead>
            <tbody>
              {!data.events.length && <tr><td colSpan={4}><Empty text="No events" /></td></tr>}
              {data.events.map((e) => (
                <tr key={e.id}>
                  <td style={{ fontSize: 12 }}>{fmtDate(e.created_at, true)}</td><td>{e.email}</td>
                  <td><span className={'badge ' + (e.event === 'login' || e.event === 'logout' ? 'green' : 'amber')}>{e.event.replace(/_/g, ' ')}</span></td>
                  <td style={{ fontSize: 12 }}>{e.ip}</td>
                </tr>
              ))}
            </tbody></table></div>
        </div>
      </div>

      {asking && <PolicyModal onClose={() => setAsking(false)} onSave={async (reason) => {
        await api.put('/platform/security/policy', {
          mfaRequired: mfa, ipAllowlist: ips.split(/\s+/).filter(Boolean), sessionMaxHours: Number(hours || 0), reason,
        });
        toast('Policy saved'); reload();
      }} />}
      {revoking && <PolicyModal title={`Revoke ${revoking.name}'s session`} danger onClose={() => setRevoking(null)} onSave={async (reason) => {
        await api.post(`/platform/security/sessions/${revoking.id}/revoke`, { reason }); toast('Session revoked'); reload();
      }} />}
    </div>
  );
}

function PolicyModal({ title = 'Save platform security policy', danger, onClose, onSave }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const go = async () => { try { await onSave(reason); onClose(); } catch (e) { setError(errMsg(e)); } };
  return (
    <Modal title={title} onClose={onClose}
      footer={<><button className="btn secondary" onClick={onClose}>Cancel</button><button className={'btn' + (danger ? ' danger' : '')} disabled={reason.trim().length < 5} onClick={go}>Confirm</button></>}>
      <TextAreaField label="Reason *" value={reason} onChange={setReason} hint="Recorded in the platform audit trail" />
      {error && <div className="error-box mt">{error}</div>}
    </Modal>
  );
}
