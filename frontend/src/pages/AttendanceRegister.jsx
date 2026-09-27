import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, errMsg, fmtDate, fmtTime } from '../api';
import { useAuth } from '../auth';
import DataTable from '../components/DataTable';
import { Spinner, useToast, StatCard } from '../components/ui';

const CELL = { present: 'P', absent: 'A', half_day: 'H', on_leave: 'L', week_off: 'W', holiday: 'G', missed_punch: 'M', not_marked: 'M' };

export default function AttendanceRegister() {
  const { can } = useAuth();
  const toast = useToast();
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [rows, setRows] = useState(null);
  const [summary, setSummary] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setBusy(true);
    try {
      const [reg, sum] = await Promise.all([
        api.get('/attendance/register', { params: { date } }),
        api.get('/attendance/summary', { params: { date } }),
      ]);
      setRows(reg.data.data.map((r) => ({ ...r, employeeCode: r.employee.employee_code, name: `${r.employee.first_name} ${r.employee.last_name}` })));
      setSummary(sum.data.data);
    } catch (e) { toast(errMsg(e), true); }
    setBusy(false);
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [date]);

  if (!rows && !busy) return <Spinner />;

  return (
    <div>
      <div className="grid c4 mb">
        <StatCard label="Total active" value={summary?.total ?? '—'} />
        <StatCard label="Present" value={summary?.byStatus?.present || 0} accent="var(--green)" />
        <StatCard label="On leave / half" value={(summary?.byStatus?.on_leave || 0) + (summary?.byStatus?.half_day || 0)} accent="#175cd3" />
        <StatCard label="Absent / missing" value={(summary?.byStatus?.absent || 0) + (summary?.notMarked || 0)} accent="var(--red)" />
      </div>

      <div className="card mb">
        <div className="card-h">
          <h3>Daily register</h3>
          <div className="row">
            <Link to="/attendance/monthly" className="btn ghost sm">Monthly grid →</Link>
            <input type="date" className="btn sm secondary" value={date} max={new Date().toISOString().slice(0, 10)}
              onChange={(e) => setDate(e.target.value)} style={{ colorScheme: 'dark light' }} />
          </div>
        </div>
        <div className="table-wrap">
          <table className="tbl">
            <thead><tr><th>Code</th><th>Employee</th><th>Status</th><th>First in</th><th>Last out</th><th className="num">Worked</th><th className="num">Late</th><th></th></tr></thead>
            <tbody>
              {busy && <tr><td colSpan={8} style={{ textAlign: 'center', padding: 24, color: 'var(--muted)' }}>Loading…</td></tr>}
              {!busy && rows.map((r) => (
                <tr key={r.employee.id}>
                  <td>{r.employee.employee_code}</td>
                  <td><b>{r.employee.first_name} {r.employee.last_name}</b></td>
                  <td><span className={'st-' + r.status}>{r.status.replace(/_/g, ' ')}{r.holidayName ? ` (${r.holidayName})` : ''}</span></td>
                  <td>{r.firstIn ? fmtTime(r.firstIn) : '—'}</td>
                  <td>{r.lastOut && r.lastOut !== r.firstIn ? fmtTime(r.lastOut) : '—'}</td>
                  <td className="num">{r.workedMinutes ? `${Math.floor(r.workedMinutes / 60)}h ${r.workedMinutes % 60}m` : '—'}</td>
                  <td className="num" style={{ color: r.lateMinutes > 0 ? 'var(--amber)' : undefined }}>{r.lateMinutes || '—'}</td>
                  <td className="actions">
                    {r.isRegularized && <span className="badge purple">regularized</span>}
                    {r.leaveType && <span className="badge blue">{r.leaveType}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <p style={{ fontSize: 12.5, color: 'var(--muted)' }}>
        P present · A absent · H half day · L leave · W week off · G holiday · M missing/late punch. Statuses resolve live from shifts, holidays and approved leave.
        {can('attendance.import') && ' Biometric CSV can be imported from Settings → Attendance, or pushed to POST /api/attendance/device-punch.'}
      </p>
    </div>
  );
}

export function MonthlyGrid() { return null; }
export { CELL };
