import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { api, setUnauthorizedHandler, setToken, getToken } from './api';

const Ctx = createContext(null);
export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }) {
  const [me, setMe] = useState(null);
  const [loading, setLoading] = useState(true);

  const refreshMe = useCallback(async () => {
    try {
      const { data } = await api.get('/auth/me');
      data.data.employee_id = data.data.employeeId; // normalize for convenience
      setMe(data.data);
      // White-label branding → CSS variables. A platform operator has no tenant
      // branding, so this is skipped rather than blanking the theme.
      const b = data.data.branding || {};
      if (b.primaryColor) {
        document.documentElement.style.setProperty('--primary', b.primaryColor);
        document.documentElement.style.setProperty('--primary-dark', b.primaryColor);
      }
      document.title = data.data.isPlatformAdmin
        ? 'ARTHVEX Platform'
        : `${b.companyName || 'Arthvex'} HRMS`;
      return data.data;
    } catch (_) {
      setMe(null);
      setToken(null);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // skip the /auth/me probe entirely for logged-out visitors (no 401 noise)
    if (!getToken()) { setLoading(false); return; }
    refreshMe();
  }, [refreshMe]);

  useEffect(() => {
    setUnauthorizedHandler(() => { setMe(null); });
  }, []);

  const login = async (email, password) => {
    const { data } = await api.post('/auth/login', { email, password });
    if (data.mfaRequired) return data; // caller completes via completeMfaLogin
    setToken(data.accessToken);
    await refreshMe();
    return data;
  };

  const completeMfaLogin = async (challenge, code) => {
    const { data } = await api.post('/auth/mfa/verify', { challenge, code });
    setToken(data.accessToken);
    await refreshMe();
    return data;
  };

  const logout = async () => {
    try { await api.post('/auth/logout'); } catch (_) {}
    setToken(null);
    setMe(null);
  };

  // A platform operator is judged by the permissions the server resolved for the
  // *specific* platform role they hold. Only the Platform Super Admin bypasses,
  // because it is the role that is allowed to administer the platform as a whole —
  // it still holds no tenant HRMS permission (that is what Support Access is for).
  const can = (perm) => {
    if (!me) return false;
    if (!perm) return true;
    if (me.isPlatformSuperAdmin) return true;
    if (!me.permissions.includes(perm)) {
      const [base, scope] = perm.split(':');
      if (scope && me.permissions.includes(base)) return true;
      return false;
    }
    return true;
  };

  // Switching a module off in the Administration Center detaches its routes on the
  // server (`app.use('/api/travel', requireModuleEnabled('travel'), …)`), so the UI
  // has to gate on it as well — a permission alone would still show the menu entry
  // and every visit would come back 403. `accessibleModules` is resolved by the
  // same resolver the API uses, so the two can never disagree.
  const moduleOn = (key) => {
    if (!me) return false;
    if (!key) return true;
    const list = me.accessibleModules;
    if (!Array.isArray(list)) return true; // no answer to check against — let the API decide
    return list.includes(key);
  };

  /**
   * What a feature is currently allowed to do for this company, read from the
   * server's own entitlement resolution. Returns one of:
   *   'on' | 'off' | 'excluded' | 'limit' | 'suspended'
   * The UI uses it to explain an unavailable feature (spec §35); the server
   * re-checks every one of these independently on the write path.
   */
  const entitlement = (key) => {
    const e = me?.entitlements?.[key];
    if (!e) return { state: 'unknown', value: null };
    if (e.kind === 'boolean') return { state: e.value ? 'on' : 'excluded', value: e.value };
    if (me.tenantReadOnly) return { state: 'suspended', value: e.value, current: e.current };
    if (e.value === 0) return { state: 'excluded', value: 0 };
    return { state: 'on', value: e.value, unit: e.unit, source: e.source };
  };

  const value = {
    me, loading, login, completeMfaLogin, logout, can, moduleOn, refreshMe, entitlement,
    isPlatform: !!me?.isPlatformAdmin,
    isPlatformSuperAdmin: !!me?.isPlatformSuperAdmin,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}