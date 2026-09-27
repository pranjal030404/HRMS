import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, errMsg, MONTHS } from '../api';
import { useAuth } from '../auth';
import { Spinner, useToast } from '../components/ui';

const CELL = { present: ['P', 'P'], absent: ['A', 'A'], half_day: ['H', 'H'], on_leave: ['L', 'L'], week_off: ['W', 'W'], holiday: ['G', 'G'], missed_punch: ['M', 'M'], not_marked: ['M', 'M'] };

export default function MonthlyRegister() {
  const { can } = useAuth();
  const toast = useToast();
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [data, setData] = useState(null);
  const [locked, setLocked] = useState(false);
  const [busy, setBusy] = useState(true);

  const load = async () => {
    setBusy(true);
    try {
      const { data: d } = await api.get('/attendance/monthly', { params: { year, month } });
      setData(d.data);
      setLocked(d.locked);
    } catch (e) { toast(errMsg(e), true); }
    setBusy(false);
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [year, month]);

  const toggleLock = async () => {
    try {
      if (locked) await api.delete('/attendance/lock', { params: { year, month } });
      else await api.post('/attendance/lock', { year, month });
      toast(locked ? 'Month unlocked' : 'Month locked — punches & regularizations frozen');
      load();
    } catch (e) { toast(errMsg(e), true); }
  };

  return (
    <div>
      <div className="card mb">
        <div className="card-h">
          <h3>Monthly attendance grid — {MONTHS[month - 1]} {year}</h3>
          <div className="row">
            <select className="btn sm secondary" value={month} onChange={(e) => setMonth(Number(e.target.value))}>
              {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
            </select>
            <select className="btn sm secondary" value={year} onChange={(e) => setYear(Number(e.target.value))}>
              {[now.getFullYear(), now.getFullYear() - 1, now.getFullYear() - 2].map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
            {can('attendance.lock') && (
              <button className={locked ? 'btn sm danger' : 'btn sm success'} onClick={toggleLock} disabled={busy}>
                {locked ? '🔒 Locked — click to unlock' : '🔓 Lock month'}
              </button>
            )}
            {!can('attendance.lock') && locked && <span className="badge purple">Locked for payroll</span>}
          </div>
        </div>
        <div className="table-wrap">
          {!data || busy ? <Spinner /> : (
            <table className="tbl" style={{ fontSize: 12 }}>
              <thead>
                <tr>
                  <th style={{ position: 'sticky', left: 0, background: '#fafbfc' }}>Employee</th>
                  {data.days.map((d) => <th key={d} style={{ padding: '8px 2px', textAlign: 'center' }}>{Number(d.slice(-2))}</th>)}
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row) => (
                  <tr key={row.employee.id}>
                    <td style={{ position: 'sticky', left: 0, background: '#fff', whiteSpace: 'nowrap' }}>
                      <b>{row.employee.first_name} {row.employee.last_name}</b>
                      <span style={{ color: 'var(--muted)', marginLeft: 6 }}>{row.employee.employee_code}</span>
                    </td>
                    {row.cells.map((c, i) => (
                      <td key={i} style={{ padding: '2px' }}>
                        {c ? <span className={'att-cell ' + (CELL[c.status]?.[1] || 'M')}>{CELL[c.status]?.[0]}</span> : <span style={{ color: '#ddd' }}>·</span>}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="card-b" style={{ borderTop: '1px solid var(--border)', fontSize: 12.5, color: 'var(--muted)' }}>
          P present · A absent · H half-day · L leave · W week-off · G holiday · M missing/late
        </div>
      </div>
      <Link to="/attendance" className="btn secondary sm">← Daily register</Link>
    </div>
  );
}
