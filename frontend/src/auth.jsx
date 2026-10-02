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
      // white-label branding → CSS variables
      const b = data.data.branding || {};
      if (b.primaryColor) document.documentElement.style.setProperty('--primary', b.primaryColor);
      if (b.primaryColor) document.documentElement.style.setProperty('--primary-dark', b.primaryColor);
      document.title = (b.companyName || 'Arthvex') + ' HRMS';
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

  const can = (perm) => {
    if (!me) return false;
    if (me.role === 'platform_super_admin') return true;
    if (!perm) return true;
    if (me.permissions.includes(perm)) return true;
    const [base, scope] = perm.split(':');
    if (scope) return me.permissions.includes(base);
    return me.permissions.some((p) => p === base || p.startsWith(base + ':'));
  };

  // Switching a module off in the Administration Center detaches its routes on the
  // server (`app.use('/api/travel', requireModuleEnabled('travel'), …)`), so the UI
  // has to gate on it as well — a permission alone would still show the menu entry
  // and every visit would come back 403. `accessibleModules` is resolved by the
  // same resolver the API uses, so the two can never disagree.
  const moduleOn = (key) => {
    if (!me) return false;
    if (me.role === 'platform_super_admin') return true;
    if (!key) return true;
    const list = me.accessibleModules;
    if (!Array.isArray(list)) return true; // no answer to check against — let the API decide
    return list.includes(key);
  };

  return (
    <Ctx.Provider value={{ me, loading, login, completeMfaLogin, logout, can, moduleOn, refreshMe }}>
      {children}
    </Ctx.Provider>
  );
}
