import React, { useCallback, useEffect, useState } from 'react';
import { api, fmtDate } from '../api';
import { useAuth } from '../auth';

const ACCESS_LABEL = {
  read_only: 'Read only',
  tenant_administration: 'Tenant administration',
  configuration: 'Configuration',
};

const SEVERITY = {
  read_only: 'info',
  tenant_administration: 'danger',
  configuration: 'warn',
};

/**
 * A standing reminder that an operator is inside someone else's company.
 *
 * The server already refuses the request once the session expires; this makes
 * the window visible before that happens, because the failure mode of support
 * access is not "someone breaks in" but "someone forgets they are still in".
 */
export default function SupportAccessBanner() {
  const { isPlatform } = useAuth();
  const [session, setSession] = useState(null);

  const load = useCallback(async () => {
    if (!isPlatform) return;
    try {
      const { data } = await api.get('/platform/support-access/mine');
      setSession(data.data);
    } catch (_) {
      // `platform.support.view` is not held by every platform role; the banner
      // is a courtesy, not a gate, so a 403 simply means it stays hidden.
      setSession(null);
    }
  }, [isPlatform]);

  useEffect(() => {
    load();
    if (!isPlatform) return undefined;
    const t = setInterval(load, 20000);
    return () => clearInterval(t);
  }, [load, isPlatform]);

  if (!session) return null;

  const minutesLeft = Math.max(0, Math.round((new Date(session.expires_at) - Date.now()) / 60000));
  const severity = SEVERITY[session.access_type] || 'info';

  return (
    <div className={'banner ' + severity}>
      <span className="pulse" />
      <b>Support session active</b> — you are reading{' '}
      <strong>{session.tenant_name}</strong> as {ACCESS_LABEL[session.access_type] || session.access_type}.
      Reason: “{session.reason}”.
      {' '}Expires {fmtDate(session.expires_at, true)}
      {minutesLeft > 0 ? ` (in ${minutesLeft} min)` : ' (expiring now)'}.
      {' '}Everything you do here is recorded against this session.
    </div>
  );
}
