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

  return (
    <Ctx.Provider value={{ me, loading, login, logout, can, refreshMe }}>
      {children}
    </Ctx.Provider>
  );
}
