import React, { useEffect, useState } from 'react';
import { api, errMsg, fmtDate, fmtTime } from '../../api';
import { Spinner, useToast, Modal, TextField, StatCard } from '../../components/ui';

const CELL = { present: ['P', 'P'], absent: ['A', 'A'], half_day: ['H', 'H'], on_leave: ['L', 'L'], week_off: ['W', 'W'], holiday: ['G', 'G'], missed_punch: ['M', 'M'], not_marked: ['·', 'M'] };

export default function MyAttendance() {
  const toast = useToast();
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [rows, setRows] = useState(null);
  const [regModal, setRegModal] = useState(false);
  const [form, setForm] = useState({});

  const load = async () => {
    try {
      const { data } = await api.get('/attendance/my', { params: { year, month } });
      setRows(data.data);
    } catch (e) { toast(errMsg(e), true); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [year, month]);

  const submitReg = async () => {
    try {
      await api.post('/attendance/regularizations', form);
      toast('Regularization request sent to your manager');
      setRegModal(false);
    } catch (e) { toast(errMsg(e), true); }
  };

  if (!rows) return <Spinner />;
  const present = rows.filter((r) => r.status === 'present').length;
  const late = rows.filter((r) => r.lateMinutes > 0).length;
  const overtime = Math.round(rows.reduce((s, r) => s + r.overtimeMinutes, 0) / 60);

  return (
    <div>
      <div className="grid c4 mb">
        <StatCard label="Present days" value={present} accent="var(--green)" />
        <StatCard label="Late arrivals" value={late} accent={late ? 'var(--amber)' : undefined} />
        <StatCard label="Overtime" value={`${overtime}h`} />
        <StatCard label="Holidays / week-offs" value={rows.filter((r) => ['holiday', 'week_off'].includes(r.status)).length} />
      </div>

      <div className="card mb">
        <div className="card-h">
          <h3>{new Date(year, month - 1).toLocaleString('en-IN', { month: 'long', year: 'numeric' })}</h3>
          <div className="row">
            <select className="btn sm secondary" value={month} onChange={(e) => setMonth(Number(e.target.value))}>
              {Array.from({ length: 12 }, (_, i) => <option key={i} value={i + 1}>{new Date(2000, i).toLocaleString('en-IN', { month: 'long' })}</option>)}
            </select>
            <select className="btn sm secondary" value={year} onChange={(e) => setYear(Number(e.target.value))}>
              {[now.getFullYear(), now.getFullYear() - 1].map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
            <button className="btn sm" onClick={() => { setForm({}); setRegModal(true); }}>Request correction</button>
          </div>
        </div>
        <div className="table-wrap">
          <table className="tbl">
            <thead><tr><th>Date</th><th>Day</th><th>Status</th><th>In</th><th>Out</th><th>Worked</th><th>Late</th></tr></thead>
            <tbody>
              {rows.map((r) => {
                const d = new Date(r.date);
                return (
                  <tr key={r.date}>
                    <td>{fmtDate(r.date)}</td>
                    <td>{d.toLocaleDateString('en-IN', { weekday: 'short' })}</td>
                    <td>
                      <span className={'st-' + r.status}>{r.status.replace(/_/g, ' ')}</span>
                      {r.holidayName ? ` · ${r.holidayName}` : ''}
                      {r.isRegularized ? <span className="badge purple" style={{ marginLeft: 6 }}>regularized</span> : null}
                    </td>
                    <td>{r.firstIn ? fmtTime(r.firstIn) : '—'}</td>
                    <td>{r.lastOut && r.lastOut !== r.firstIn ? fmtTime(r.lastOut) : '—'}</td>
                    <td>{r.workedMinutes ? `${Math.floor(r.workedMinutes / 60)}h ${r.workedMinutes % 60}m` : '—'}</td>
                    <td style={{ color: r.lateMinutes > 0 ? 'var(--amber)' : undefined }}>{r.lateMinutes || '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {regModal && (
        <Modal title="Attendance correction request" onClose={() => setRegModal(false)} footer={
          <><button className="btn secondary" onClick={() => setRegModal(false)}>Cancel</button><button className="btn" onClick={submitReg}>Submit</button></>
        }>
          <TextField label="Date *" type="date" value={form.adate} max={new Date().toISOString().slice(0, 10)}
            onChange={(v) => setForm((f) => ({ ...f, adate: v }))} />
          <div className="form-grid">
            <TextField label="Actual punch in" type="datetime-local" value={form.requestedIn} onChange={(v) => setForm((f) => ({ ...f, requestedIn: v }))} />
            <TextField label="Actual punch out" type="datetime-local" value={form.requestedOut} onChange={(v) => setForm((f) => ({ ...f, requestedOut: v }))} />
          </div>
          <TextField label="Reason *" value={form.reason} onChange={(v) => setForm((f) => ({ ...f, reason: v }))} hint="e.g. Missed punch — was in client meeting" />
        </Modal>
      )}
    </div>
  );
}
