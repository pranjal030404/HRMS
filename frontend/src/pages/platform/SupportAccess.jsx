import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, errMsg, fmtDate } from '../../api';
import { useAuth } from '../../auth';
import { Empty, Overlay, Modal, Spinner, TextAreaField, useToast } from '../../components/ui';
import {
  PageHeader, Pager, PlatformSection, SessionBadge, useLoader, usePlatform,
} from './shared';
import GrantSupport from './GrantSupport';

export default function PlatformSupportAccess() {
  return (
    <PlatformSection perm="platform.support.view">
      <SupportAccess />
    </PlatformSection>
  );
}

const ACCESS_LABEL = {
  read_only: 'Read only',
  tenant_administration: 'Tenant administration',
  configuration: 'Configuration',
};

function SupportAccess() {
  const { can } = usePlatform();
  const [status, setStatus] = useState('active');
  const [page, setPage] = useState(1);
  const [granting, setGranting] = useState(false);
  const [grantTenant, setGrantTenant] = useState('');
  const [revoking, setRevoking] = useState(null);
  const [inspecting, setInspecting] = useState(null);
  const [mine, setMine] = useState(null);
  const toast = useToast();

  const { data, meta, loading, reload } = useLoader(async () => {
    const { data } = await api.get('/platform/support-access', {
      params: { status: status || undefined, page, limit: 25 },
    });
    return data;
  }, [status, page]);

  const loadMine = useCallback(async () => {
    try {
      const { data } = await api.get('/platform/support-access/mine');
      setMine(data.data);
    } catch (_) { setMine(null); }
  }, []);

  useEffect(() => { loadMine(); }, [loadMine]);

  // A session that expires while the tab is open changes what the operator can
  // see, so the banner is refreshed on a timer rather than only on navigation.
  useEffect(() => {
    const t = setInterval(loadMine, 30000);
    return () => clearInterval(t);
  }, [loadMine]);

  const rows = data || [];

  return (
    <div>
      <PageHeader
        title="Support access"
        sub="The only way ARTHVEX staff reach a customer's data. Every session is reason-bearing, time-boxed and read-audited; there is no standing grant to cross into a tenant."
        actions={
          <>
            <button className="btn secondary sm" onClick={() => { reload(); loadMine(); }}>Refresh</button>
            {can('platform.support.grant') && (
              <button className="btn sm" onClick={() => setGranting(true)}>+ Take support access</button>
            )}
          </>
        }
      />

      {mine && <div className="banner warn mb"><b>You hold an active session</b> into <strong>{mine.tenant_name}</strong> ({ACCESS_LABEL[mine.access_type] || mine.access_type}), expiring {fmtDate(mine.expires_at, true)}. Reason: “{mine.reason}”.</div>}

      <div className="card mb">
        <div className="card-b" style={{ paddingBottom: 0 }}>
          <div className="row wrap">
            {[['', 'All'], ['active', 'Active'], ['expired', 'Expired'], ['revoked', 'Revoked']].map(([v, label]) => (
              <button key={v || 'all'} className={'btn sm ' + (status === v ? '' : 'secondary')}
                onClick={() => { setStatus(v); setPage(1); }}>{label}</button>
            ))}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="table-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Company</th><th>Access</th><th>Reason</th><th>Ticket</th>
                <th>Granted by</th><th>Opened</th><th>Expires</th><th></th>
              </tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={8} style={{ textAlign: 'center', color: 'var(--muted)', padding: 28 }}>Loading…</td></tr>}
              {!loading && !rows.length && (
                <tr><td colSpan={8}><Empty icon="🔐" text="No support sessions with that state" /></td></tr>
              )}
              {!loading && rows.map((s) => {
                const expired = s.status === 'active' && new Date(s.expires_at) < new Date();
                return (
                  <tr key={s.id}>
                    <td>
                      <Link to={`/platform/companies/${s.tenant_id}`}><strong>{s.tenant_name}</strong></Link>
                      <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{s.tenant_slug} · session #{s.id}</div>
                    </td>
                    <td>
                      <span className={'badge ' + (s.access_type === 'read_only' ? 'blue' : s.access_type === 'configuration' ? 'amber' : 'red')}>
                        {ACCESS_LABEL[s.access_type] || s.access_type}
                      </span>
                      {!!s.requires_approval && <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 3 }}>needs approval</div>}
                    </td>
                    <td style={{ fontSize: 12.5, maxWidth: 300 }}>{s.reason}</td>
                    <td style={{ fontSize: 12 }}>{s.ticket_ref || '—'}</td>
                    <td style={{ fontSize: 12.5 }}>{s.granted_by_name || `#${s.granted_by}`}</td>
                    <td style={{ fontSize: 12 }}>{fmtDate(s.created_at, true)}</td>
                    <td style={{ fontSize: 12 }}>{fmtDate(s.expires_at, true)}</td>
                    <td className="actions">
                      <SessionBadge status={expired ? 'expired' : s.status} />
                      <button className="btn ghost sm" onClick={() => setInspecting(s)}>Log</button>
                      {s.status === 'active' && can('platform.support.revoke') && (
                        <button className="btn ghost sm" onClick={() => setRevoking(s)}>Revoke</button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <Pager meta={meta} onPage={setPage} />
      </div>

      {granting && !grantTenant && (
        <GrantTenantPicker
          onClose={() => setGranting(false)}
          onPick={(id) => setGrantTenant(id)}
        />
      )}

      {granting && grantTenant && (
        <GrantSupport
          tenantId={Number(grantTenant)}
          onClose={() => { setGranting(false); setGrantTenant(''); }}
          onGranted={() => { reload(); loadMine(); toast('Access taken — it expires on its own'); }}
        />
      )}

      {revoking && (
        <RevokeModal
          session={revoking}
          onClose={() => setRevoking(null)}
          onDone={() => { setRevoking(null); reload(); loadMine(); toast('Session revoked'); }}
        />
      )}

      {inspecting && <SessionLog session={inspecting} onClose={() => setInspecting(null)} />}
    </div>
  );
}

/** Picking the company is a separate step: the id must be exact, not typed. */
function GrantTenantPicker({ onPick, onClose }) {
  const [q, setQ] = useState('');
  const { data, loading } = useLoader(async () => {
    const { data } = await api.get('/platform/tenants', { params: { q: q || undefined, limit: 25 } });
    return data.data;
  }, [q]);

  return (
    <Overlay>
      <div className="modal">
        <div className="modal-h">
          <h3>Which company?</h3>
          <button className="x-btn" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="modal-b">
          <div className="searchbox mb">
            <input placeholder="Search companies…" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
          </div>
          {loading && <Spinner />}
          <div style={{ maxHeight: 320, overflowY: 'auto' }}>
            {(data || []).map((t) => (
              <button key={t.id} className="pane-item" style={{ width: '100%', textAlign: 'left', marginBottom: 6 }}
                onClick={() => onPick(t.id)}>
                <div className="pane-item-text">
                  <div className="pane-item-title">{t.name}</div>
                  <div className="pane-item-sub">{t.slug} · {t.plan} · {t.status.replace(/_/g, ' ')}</div>
                </div>
              </button>
            ))}
            {!loading && !(data || []).length && <Empty text="No company matches" />}
          </div>
        </div>
        <div className="modal-f"><button className="btn secondary" onClick={onClose}>Cancel</button></div>
      </div>
    </Overlay>
  );
}

function RevokeModal({ session, onClose, onDone }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    setBusy(true); setError('');
    try {
      await api.post(`/platform/support-access/${session.id}/revoke`, { reason });
      onDone();
    } catch (e) { setError(errMsg(e)); }
    setBusy(false);
  };

  return (
    <Modal title="Revoke this support session" onClose={onClose}
      footer={<><button className="btn secondary" onClick={onClose}>Close</button><button className="btn danger" onClick={submit} disabled={busy}>Revoke now</button></>}>
      <p style={{ fontSize: 13.5 }}>
        Access into <strong>{session.tenant_name}</strong> ends immediately rather than at
        {' '}{fmtDate(session.expires_at, true)}. Everything already done under it stays in the log.
      </p>
      <TextAreaField label="Reason" value={reason} onChange={setReason} hint="Optional, but it is what the customer sees." />
      {error && <div className="error-box mt">{error}</div>}
    </Modal>
  );
}

function SessionLog({ session, onClose }) {
  const [rows, setRows] = useState(null);
  const { me } = useAuth();

  useEffect(() => {
    api.get(`/platform/support-access/${session.id}/logs`)
      .then(({ data }) => setRows(data.data))
      .catch(() => setRows([]));
  }, [session.id]);

  return (
    <Modal title={`Everything done under session #${session.id}`} onClose={onClose} wide
      footer={<button className="btn" onClick={onClose}>Close</button>}>
      <p style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 0 }}>
        Reads count. An operator browsing a customer’s configuration is exactly what a later audit
        has to be able to reconstruct, so it is written here rather than inferred from the fact that
        it was permitted.
      </p>
      {!rows && <Spinner />}
      {rows && (
        <div className="table-wrap" style={{ maxHeight: 420, overflowY: 'auto' }}>
          <table className="tbl">
            <thead><tr><th>Action</th><th>Request</th><th>By</th><th>When</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td style={{ fontSize: 12.5 }}>{r.action}</td>
                  <td style={{ fontSize: 11.5, color: 'var(--muted)' }}>{r.method} {r.path}</td>
                  <td style={{ fontSize: 12 }}>{r.actor_user_id === me?.id ? 'you' : `#${r.actor_user_id}`}</td>
                  <td style={{ fontSize: 12 }}>{fmtDate(r.created_at, true)}</td>
                </tr>
              ))}
              {!rows.length && <tr><td colSpan={4} style={{ textAlign: 'center', color: 'var(--muted)', padding: 24 }}>Nothing was done under this session</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}
