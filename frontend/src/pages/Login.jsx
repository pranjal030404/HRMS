import React, { useEffect, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import axios from 'axios';
import { useAuth } from '../auth';
import { getToken } from '../api';

const FEATURES = [
  ['⏱️', 'Attendance & shifts', 'Clock in/out, regularization, biometric imports'],
  ['🌴', 'Leave management', 'Policies, accruals, approvals, team calendar'],
  ['💸', 'Payroll engine', 'Versioned statutory rules — PF, ESI, PT, TDS'],
  ['🧾', 'GST billing', 'Invoices with CGST/SGST/IGST and payments'],
];

export default function Login() {
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
    // auto-redirect only when a session token is already stored
    if (getToken()) refreshMe();
    // eslint-disable-next-line
  }, []);

  useEffect(() => { if (me) nav('/'); }, [me, nav]);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setErr('');
    try {
      const data = await login(email.trim().toLowerCase(), password);
      if (data?.mfaRequired) { setMfaChallenge(data.challenge); }
      else nav('/');
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
      nav('/');
    } catch (ex) {
      setErr(ex?.response?.data?.message || 'Verification failed');
    }
    setBusy(false);
  };

  if (brand.primaryColor) document.documentElement.style.setProperty('--primary', brand.primaryColor);

  return (
    <div className="auth-wrap">
      <div className="auth-hero">
        <div>
          <div className="row" style={{ gap: 10 }}>
            <div className="logo" style={{ width: 40, height: 40, borderRadius: 11, background: 'var(--primary)', display: 'grid', placeItems: 'center', fontWeight: 800, fontSize: 20 }}>{(brand.companyName || 'A')[0]}</div>
            <b style={{ fontSize: 17 }}>{brand.companyName}</b>
          </div>
          <h1 style={{ marginTop: 46 }}>One place for your <em>people, payroll</em> and paperwork.</h1>
          <div>
            {FEATURES.map(([ic, t, s]) => (
              <div className="feat" key={t}>
                <div className="ic">{ic}</div>
                <div><b>{t}</b><p>{s}</p></div>
              </div>
            ))}
          </div>
        </div>
        <p style={{ color: '#667085', fontSize: 12.5 }}>© {new Date().getFullYear()} {brand.companyName} · Multi-tenant HRMS</p>
      </div>
      <div className="auth-form">
        <form className="auth-card" onSubmit={mfaChallenge ? submitMfa : submit}>
          <div className="brandline">
            <div className="logo">{(brand.companyName || 'A')[0]}</div>
            <div>
              <b style={{ fontSize: 17 }}>{mfaChallenge ? 'Two-factor verification' : 'Sign in'}</b>
              <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>{mfaChallenge ? 'Enter the 6-digit code from your authenticator app' : (brand.loginTagline || 'Employee & admin portal')}</div>
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
              <button className="btn" style={{ width: '100%', justifyContent: 'center', marginTop: 6 }} disabled={busy}>
                {busy ? 'Verifying…' : 'Verify & sign in'}
              </button>
              <button type="button" className="btn ghost" style={{ width: '100%', justifyContent: 'center', marginTop: 8 }} onClick={() => { setMfaChallenge(null); setErr(''); }}>
                Back to sign in
              </button>
            </>
          ) : (
            <>
              <div className="field">
                <label>Work email</label>
                <input type="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" />
              </div>
              <div className="field">
                <label>Password</label>
                <input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
              </div>
              <button className="btn" style={{ width: '100%', justifyContent: 'center', marginTop: 6 }} disabled={busy}>
                {busy ? 'Signing in…' : 'Sign in'}
              </button>
            </>
          )}
          {/* Seeded demo logins exist only in a development build; a production bundle never ships them. */}
          {import.meta.env.DEV && (
            <p style={{ fontSize: 12, color: 'var(--muted)', textAlign: 'center', marginTop: 18 }}>
              Demo: hr@arthvex.com · employee@arthvex.com<br />Password: Password@123
            </p>
          )}
          <p style={{ fontSize: 12, color: 'var(--muted)', textAlign: 'center', marginTop: 10 }}>
            <Link to="/admin" style={{ color: 'var(--primary)' }}>Administrator? Sign in to the console →</Link>
          </p>
        </form>
      </div>
    </div>
  );
}
