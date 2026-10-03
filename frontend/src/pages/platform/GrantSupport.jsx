import React, { useState } from 'react';
import { api, errMsg } from '../../api';
import { Overlay, SelectField, TextAreaField, TextField, useToast } from '../../components/ui';
import { usePlatform } from './shared';

const ACCESS_TYPE_HINT = {
  read_only: 'Inspect the customer’s configuration and usage. Cannot change anything.',
  tenant_administration: 'Act inside the customer’s own admin screens on their behalf. The most invasive type — ask for it rarely.',
  configuration: 'Change the customer’s configuration. Needs a reason a customer would recognise.',
};

const DURATIONS = [15, 30, 60, 120, 240, 480];

/**
 * Taking Support Access (spec §21).
 *
 * The form deliberately asks for a reason, a ticket reference and a duration
 * *before* it asks for access, because that is the order the audit trail reads
 * in. There is no "just this once" — every session expires on its own and every
 * request it authorises is written against it.
 */
export default function GrantSupport({ tenantId, tenantName, ticketRef, onClose, onGranted }) {
  const toast = useToast();
  const { accessTypes } = usePlatform();
  const [form, setForm] = useState({
    reason: '', ticketRef: ticketRef || '', accessType: 'read_only', durationMinutes: 30, scope: '', requiresApproval: false,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  const submit = async () => {
    if (String(form.reason).trim().length < 10) {
      setError('A reason of at least 10 characters is required — this is what the customer audit shows.');
      return;
    }
    setBusy(true); setError('');
    try {
      const { data } = await api.post('/platform/support-access', {
        tenantId,
        reason: form.reason,
        accessType: form.accessType,
        durationMinutes: Number(form.durationMinutes),
        ticketRef: form.ticketRef || null,
        scope: form.scope ? { note: form.scope } : null,
        requiresApproval: form.requiresApproval,
      });
      toast(`Support access granted until ${new Date(data.data.expires_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}`);
      onGranted?.(data.data);
      onClose();
    } catch (e) {
      setError(errMsg(e));
    }
    setBusy(false);
  };

  return (
    <Overlay>
      <div className="modal">
        <div className="modal-h">
          <h3>Take support access{tenantName ? ` — ${tenantName}` : ''}</h3>
          <button className="x-btn" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="modal-b">
          <div className="info-box">
            Access is time-limited, expires automatically, and every request you make under it is
            written to the customer’s audit trail with the session id. Reads count as actions here.
          </div>

          <TextAreaField
            label="Reason *"
            value={form.reason}
            onChange={(v) => set({ reason: v })}
            hint="At least 10 characters. The customer can see this."
          />
          <TextField label="Ticket reference" value={form.ticketRef} onChange={(v) => set({ ticketRef: v })} placeholder="SUP-1234" />

          <SelectField
            label="Access type"
            value={form.accessType}
            onChange={(v) => set({ accessType: v })}
            options={(accessTypes.length ? accessTypes : Object.keys(ACCESS_TYPE_HINT)).map((t) => ({
              value: t, label: t.replace(/_/g, ' '),
            }))}
            hint={ACCESS_TYPE_HINT[form.accessType]}
          />

          <div className="field">
            <label>Duration</label>
            <div className="row wrap">
              {DURATIONS.map((d) => (
                <button
                  key={d}
                  type="button"
                  className={'btn sm ' + (Number(form.durationMinutes) === d ? '' : 'secondary')}
                  onClick={() => set({ durationMinutes: d })}
                >
                  {d < 60 ? `${d} min` : `${d / 60} h`}
                </button>
              ))}
            </div>
            <span className="hint">The server caps this at 8 hours regardless of what is asked for.</span>
          </div>

          <TextField label="Scope note" value={form.scope} onChange={(v) => set({ scope: v })} hint="What specifically you are going to look at" />
          <label className="check">
            <input type="checkbox" checked={form.requiresApproval} onChange={(e) => set({ requiresApproval: e.target.checked })} />
            Requires a second operator to approve
          </label>

          {error && <div className="error-box mt">{error}</div>}
        </div>
        <div className="modal-f">
          <button className="btn secondary" onClick={onClose}>Cancel</button>
          <button className="btn" onClick={submit} disabled={busy}>{busy ? 'Granting…' : 'Grant access'}</button>
        </div>
      </div>
    </Overlay>
  );
}

/**
 * Shown instead of a screen when the server refuses a tenant read because no
 * session is open. It says exactly what happened and offers the one action that
 * fixes it, rather than leaving a bare "403".
 */
export function SupportAccessRequired({ error, tenantId, tenantName, onGranted, onClose }) {
  const [granting, setGranting] = useState(false);
  return (
    <div className="card gate">
      <div style={{ fontSize: 30, marginBottom: 8 }}>🔐</div>
      <h3>Support access required</h3>
      <p style={{ color: 'var(--muted)', fontSize: 13.5, maxWidth: 520, margin: '8px auto' }}>
        {typeof error === 'string' && error
          ? error
          : 'Reading a customer’s configuration requires a live, reasoned, expiring support session.'}
      </p>
      <p style={{ color: 'var(--muted)', fontSize: 12.5, maxWidth: 520, margin: '0 auto 16px' }}>
        This is deliberate: the control plane holds no standing grant into tenant data. A session is
        opened against a reason, expires on its own, and is recorded.
      </p>
      <button className="btn" onClick={() => setGranting(true)}>Take support access</button>

      {granting && (
        <GrantSupport
          tenantId={tenantId}
          tenantName={tenantName}
          onClose={() => { setGranting(false); onClose?.(); }}
          onGranted={onGranted}
        />
      )}
    </div>
  );
}
