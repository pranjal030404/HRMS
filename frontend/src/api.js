import axios from 'axios';

export const api = axios.create({ baseURL: '/api', withCredentials: true });

let onUnauthorized = null;
export function setUnauthorizedHandler(fn) { onUnauthorized = fn; }

// ---- Access-token handling (kept in localStorage + default header) ----
const TOKEN_KEY = 'hrms_access_token';
export function setToken(token) {
  if (token) {
    localStorage.setItem(TOKEN_KEY, token);
    api.defaults.headers.common.Authorization = `Bearer ${token}`;
  } else {
    localStorage.removeItem(TOKEN_KEY);
    delete api.defaults.headers.common.Authorization;
  }
}
const saved = localStorage.getItem(TOKEN_KEY);
if (saved) api.defaults.headers.common.Authorization = `Bearer ${saved}`;
export function getToken() { return localStorage.getItem(TOKEN_KEY); }

export function errMsg(e) {
  return e?.response?.data?.message || e?.message || 'Something went wrong';
}

api.interceptors.response.use(
  (res) => res,
  async (err) => {
    const { response, config } = err;
    if (response?.status === 401 && !config._retried && !config.url.includes('/auth/')) {
      config._retried = true;
      try {
        // refresh rotates the httpOnly cookie and returns a fresh access token
        const { data } = await axios.post('/api/auth/refresh', {}, { withCredentials: true });
        if (data.accessToken) {
          setToken(data.accessToken);
          // IMPORTANT: the retried config already carries the old expired header —
          // axios does not re-merge defaults for it, so set it explicitly.
          if (config.headers) config.headers.Authorization = `Bearer ${data.accessToken}`;
        }
        return api(config);
      } catch (_) {
        setToken(null);
        onUnauthorized?.();
      }
    }
    return Promise.reject(err);
  }
);

export const money = (n) =>
  '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });

export const money2 = (n) =>
  '₹' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const fmtDate = (d, withTime = false) => {
  if (!d) return '—';
  const dt = new Date(d);
  if (isNaN(dt)) return d;
  const date = dt.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  if (!withTime) return date;
  return date + ' ' + fmtTime(d);
};

export const fmtTime = (d) => {
  if (!d) return '—';
  const dt = new Date(d);
  if (isNaN(dt)) return '—';
  return dt.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
};

export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
