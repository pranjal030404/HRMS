import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { getToken } from '../api';

// ---------- Toast ----------
const ToastCtx = createContext(null);
export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const push = useCallback((msg, isErr = false) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, msg, isErr }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3800);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      {toasts.map((t) => (
        <div key={t.id} className={'toast' + (t.isErr ? ' err' : '')}>{t.msg}</div>
      ))}
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

// ---------- Modal ----------
export function Modal({ title, onClose, children, footer, wide }) {
  useEffect(() => {
    const h = (e) => e.key === 'Escape' && onClose?.();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className={'modal' + (wide ? ' wide' : '')}>
        <div className="modal-h">
          <h3>{title}</h3>
          <button className="x-btn" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="modal-b">{children}</div>
        {footer && <div className="modal-f">{footer}</div>}
      </div>
    </div>
  );
}

export function Confirm({ title = 'Are you sure?', message, onYes, onClose, danger }) {
  return (
    <Modal title={title} onClose={onClose} footer={
      <>
        <button className="btn secondary" onClick={onClose}>Cancel</button>
        <button className={'btn' + (danger ? ' danger' : '')} onClick={() => { onYes(); onClose(); }}>Confirm</button>
      </>
    }>
      <p>{message}</p>
    </Modal>
  );
}

// ---------- Form fields ----------
export function Field({ label, hint, children }) {
  return (
    <div className="field">
      {label && <label>{label}</label>}
      {children}
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}

export function TextField({ label, value, onChange, type = 'text', hint, required, placeholder, min, max }) {
  return (
    <Field label={label} hint={hint}>
      <input type={type} value={value ?? ''} placeholder={placeholder} required={required} min={min} max={max}
        onChange={(e) => onChange(e.target.value)} />
    </Field>
  );
}

export function SelectField({ label, value, onChange, options, hint, placeholder = '— Select —' }) {
  return (
    <Field label={label} hint={hint}>
      <select value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
        <option value="">{placeholder}</option>
        {options.map((o) => (
          <option key={String(o.value)} value={o.value}>{o.label}</option>
        ))}
      </select>
    </Field>
  );
}

export function CheckField({ label, checked, onChange }) {
  return (
    <label className="check" style={{ marginBottom: 12 }}>
      <input type="checkbox" checked={!!checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

// ---------- Status helpers ----------
const STATUS_LABELS = {
  active: ['green', 'Active'], on_probation: ['amber', 'On Probation'], on_notice: ['amber', 'On Notice'],
  onboarding: ['blue', 'Onboarding'], exited: ['gray', 'Exited'], resigned: ['amber', 'Resigned'], terminated: ['red', 'Terminated'],
  pending: ['amber', 'Pending'], approved: ['green', 'Approved'], rejected: ['red', 'Rejected'], cancelled: ['gray', 'Cancelled'], withdrawn: ['gray', 'Withdrawn'],
  submitted: ['blue', 'Submitted'], draft: ['gray', 'Draft'], calculated: ['blue', 'Calculated'], locked: ['purple', 'Locked'], paid: ['green', 'Paid'],
  present: ['green', 'Present'], absent: ['red', 'Absent'], half_day: ['amber', 'Half Day'], on_leave: ['blue', 'On Leave'],
  holiday: ['gray', 'Holiday'], week_off: ['gray', 'Week Off'], missed_punch: ['purple', 'Missed Punch'], not_marked: ['gray', 'Not Marked'],
  sent: ['blue', 'Sent'], part_paid: ['amber', 'Part Paid'], overdue: ['red', 'Overdue'], reimbursed: ['green', 'Reimbursed'],
  open: ['blue', 'Open'], in_progress: ['amber', 'In Progress'], resolved: ['green', 'Resolved'], closed: ['gray', 'Closed'], reopened: ['red', 'Reopened'],
  assigned: ['blue', 'Assigned'], available: ['green', 'Available'], repair: ['amber', 'Repair'], retired: ['gray', 'Retired'],
  // v2
  investigating: ['purple', 'Investigating'], credited: ['green', 'Credited'], completed: ['green', 'Completed'],
  reviewing: ['amber', 'Reviewing'], implemented: ['green', 'Implemented'], issued: ['blue', 'Issued'],
  settled: ['green', 'Settled'], not_required: ['gray', 'No Settlement'], advanced: ['blue', 'Advanced'],
  ready_now: ['green', 'Ready now'], ready_1_2_years: ['amber', 'Ready in 1-2 yrs'], ready_3_5_years: ['amber', 'Ready in 3-5 yrs'], not_ready: ['red', 'Not ready'],
  critical: ['red', 'Critical'], high: ['red', 'High'], medium: ['amber', 'Medium'], low: ['green', 'Low'],
  beginner: ['gray', 'Beginner'], intermediate: ['blue', 'Intermediate'], advanced_: ['green', 'Advanced'], expert: ['purple', 'Expert'],
  running: ['blue', 'Running'], failed: ['red', 'Failed'], skipped: ['gray', 'Skipped'],
  success: ['green', 'Success'], dead: ['red', 'Dead'], connected: ['green', 'Connected'], disabled: ['gray', 'Disabled'], error: ['red', 'Error'],
  applied: ['green', 'Applied'], promoted: ['purple', 'Promoted'], rewarded: ['purple', 'Rewarded'], referred: ['blue', 'Referred'],
  answered: ['green', 'Answered'], pending_approval: ['amber', 'Pending Approval'], blocked: ['red', 'Blocked'],
  anonymous: ['gray', 'Anonymous'], named: ['blue', 'Named'], suspension: ['red', 'Suspension'], pip: ['amber', 'PIP'],
};
export function StatusBadge({ value, labels }) {
  const map = { ...STATUS_LABELS, ...(labels || {}) };
  const [color, label] = map[value] || ['gray', value ? String(value).replace(/_/g, ' ') : '—'];
  return <span className={'badge ' + color}>{label}</span>;
}

// ---------- Empty / loading ----------
export const Spinner = () => <div className="spinner" />;
export const Empty = ({ icon = '🗂️', text = 'Nothing here yet' }) => (
  <div className="empty"><div className="big">{icon}</div>{text}</div>
);

// ---------- Tabs ----------
export function Tabs({ tabs, active, onChange }) {
  return (
    <div className="tabs">
      {tabs.map((t) => (
        <button key={t.key} className={'tab' + (active === t.key ? ' active' : '')} onClick={() => onChange(t.key)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function StatCard({ label, value, sub, accent }) {
  return (
    <div className="card stat">
      <div className="lbl">{label}</div>
      <div className="val" style={accent ? { color: accent } : undefined}>{value}</div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  );
}

// ---------- Simple charts ----------
export function BarList({ data, color = 'var(--primary)', valueFormat = (v) => v }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  if (!data.length) return <Empty text="No data" />;
  return data.map((d) => (
    <div className="bar-row" key={d.label}>
      <div className="bar-lbl" title={d.label}>{d.label}</div>
      <div className="bar-track"><div className="bar-fill" style={{ width: `${(d.value / max) * 100}%`, background: color }} /></div>
      <div className="bar-val">{valueFormat(d.value)}</div>
    </div>
  ));
}

export function Donut({ data, size = 150 }) {
  const total = data.reduce((s, d) => s + d.value, 0);
  const colors = ['#1d4ed8', '#067647', '#f79009', '#6941c6', '#b42318', '#98a2b3', '#0e9384'];
  if (!total) return <Empty text="No data" />;
  let acc = 0;
  const R = size / 2 - 12;
  const C = 2 * Math.PI * R;
  return (
    <div className="row" style={{ gap: 22 }}>
      <svg width={size} height={size} style={{ flex: 'none' }}>
        <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
          {data.map((d, i) => {
            const frac = d.value / total;
            const el = (
              <circle key={i} cx={size / 2} cy={size / 2} r={R} fill="none" stroke={colors[i % colors.length]}
                strokeWidth={18} strokeDasharray={`${frac * C} ${C}`} strokeDashoffset={-acc * C} />
            );
            acc += frac;
            return el;
          })}
        </g>
        <text x="50%" y="52%" textAnchor="middle" fontSize="20" fontWeight="700" fill="#101828">{total}</text>
      </svg>
      <div className="donut-legend">
        {data.map((d, i) => (
          <div key={i}><span className="sw" style={{ background: colors[i % colors.length] }} />{d.label} — {d.value}</div>
        ))}
      </div>
    </div>
  );
}

// ---------- File download helper ----------
export async function downloadFile(url, filename) {
  // The API authenticates via the Authorization header only — cookies alone are not
  // accepted — so the bearer token has to ride along or every export 401s.
  const token = getToken();
  const res = await fetch(url, {
    credentials: 'include',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename || 'download';
  a.click();
  URL.revokeObjectURL(a.href);
}
