import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import axios from 'axios';
import { useAuth } from '../auth';
import { getToken } from '../api';

/**
 * The administration entrance at /admin.
 *
 * It is the same authentication as /login — one identity store, one token, one
 * session — presented as its own door so an administrator and an employee are never
 * competing for the same screen. Which screens the account then reaches is decided by
 * the server from its role, never by this page: signing in here with a non-admin
 * account simply lands you in an app that shows you what your role allows.
 */
const CAPABILITIES = [
  ['🏢', 'Every company', 'Provision, inspect and switch off any tenant on the platform'],
  ['🔑', 'Every permission', 'Bypasses role, scope and per-company module gates'],
  ['🧩', 'Every module', 'Reaches Travel, Workforce, AI and Integrations even when off'],
];

export default function AdminLogin() {
  const { login, completeMfaLogin, me, refreshMe } = useAuth();
  const nav = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mfaCode, setMfaCode] = useState('');
  const [mfaChallenge, setMfaChallenge] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [brand, setBrand] = useState({ companyName: 'Arthvex HRMS' });

  useEffect(() => {
    axios.get('/api/auth/branding').then(({ data }) => setBrand(data.data)).catch(() => {});
    if (getToken()) refreshMe();
    // eslint-disable-next-line
  }, []);

  useEffect(() => { if (me) nav('/', { replace: true }); }, [me, nav]);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setErr('');
    try {
      const data = await login(email.trim().toLowerCase(), password);
      if (data?.mfaRequired) setMfaChallenge(data.challenge);
      else nav('/', { replace: true });
    } catch (ex) {
      setErr(ex?.response?.data?.message || 'Login failed');
    }
    setBusy(false);
  };

  const submitMfa = async (e) => {
    e.preventDefault();
    setBusy(true); setErr('');
    try {
      await completeMfaLogin(mfaChallenge, mfaCode);
      nav('/', { replace: true });
    } catch (ex) {
      setErr(ex?.response?.data?.message || 'Verification failed');
    }
    setBusy(false);
  };

  const name = brand.companyName || 'Arthvex';
  if (brand.primaryColor) document.documentElement.style.setProperty('--primary', brand.primaryColor);

  return (
    <div className="auth-wrap">
      <div className="auth-hero" style={{ background: 'linear-gradient(140deg, #101828 0%, #1d2939 60%, #344054 100%)', color: '#fff' }}>
        <div>
          <div className="row" style={{ gap: 10 }}>
            <div className="logo" style={{ width: 40, height: 40, borderRadius: 11, background: '#fff', color: '#101828', display: 'grid', placeItems: 'center', fontWeight: 800, fontSize: 20 }}>{name[0]}</div>
            <b style={{ fontSize: 17 }}>{name}</b>
            <span className="badge" style={{ background: 'rgba(255,255,255,.14)', color: '#fff', marginLeft: 4 }}>Console</span>
          </div>
          <h1 style={{ marginTop: 46, color: '#fff' }}>Control every <em>company and module</em> from one door.</h1>
          <div>
            {CAPABILITIES.map(([ic, t, s]) => (
              <div className="feat" key={t} style={{ color: '#fff' }}>
                <div className="ic">{ic}</div>
                <div><b style={{ color: '#fff' }}>{t}</b><p style={{ color: 'rgba(255,255,255,.72)' }}>{s}</p></div>
              </div>
            ))}
          </div>
        </div>
        <p style={{ color: 'rgba(255,255,255,.6)', fontSize: 12.5 }}>Every sign-in here is written to the audit trail with its request id.</p>
      </div>
      <div className="auth-form">
        <form className="auth-card" onSubmit={mfaChallenge ? submitMfa : submit}>
          <div className="brandline">
            <div className="logo" style={{ background: '#101828', color: '#fff' }}>{name[0]}</div>
            <div>
              <b style={{ fontSize: 17 }}>{mfaChallenge ? 'Two-factor verification' : 'Administrator sign in'}</b>
              <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>
                {mfaChallenge ? 'Enter the 6-digit code from your authenticator app' : 'Platform super admin · unrestricted reach'}
              </div>
            </div>
          </div>
          {err && <div className="error-box">{err}</div>}
          {mfaChallenge ? (
            <>
              <div className="field">
                <label>Verification code</label>
                <input inputMode="numeric" pattern="[0-9]*" maxLength={6} required autoFocus value={mfaCode}
                  onChange={(e) => setMfaCode(e.target.value.replace(/\D/g, ''))} placeholder="000000" />
              </div>
              <button className="btn" style={{ width: '100%', justifyContent: 'center', marginTop: 6, background: '#101828' }} disabled={busy}>
                {busy ? 'Verifying…' : 'Verify & sign in'}
              </button>
              <button type="button" className="btn ghost" style={{ width: '100%', justifyContent: 'center', marginTop: 8 }} onClick={() => { setMfaChallenge(null); setErr(''); }}>
                Back to sign in
              </button>
            </>
          ) : (
            <>
              <div className="field">
                <label>Administrator email</label>
                <input type="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} placeholder="admin@company.com" />
              </div>
              <div className="field">
                <label>Password</label>
                <input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
              </div>
              <button className="btn" style={{ width: '100%', justifyContent: 'center', marginTop: 6, background: '#101828' }} disabled={busy}>
                {busy ? 'Signing in…' : 'Enter the console'}
              </button>
            </>
          )}
          <p style={{ fontSize: 12, color: 'var(--muted)', textAlign: 'center', marginTop: 18 }}>
            Demo: <b>admin@arthvex.com</b> · <b>Admin@12345</b><br />
            <Link to="/login" style={{ color: 'var(--primary)' }}>← Employee sign in</Link>
          </p>
        </form>
      </div>
    </div>
  );
}