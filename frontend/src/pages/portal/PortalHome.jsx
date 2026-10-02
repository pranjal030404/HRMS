import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, errMsg, fmtDate, fmtTime, money2 } from '../../api';
import { useAuth } from '../../auth';
import { Spinner, useToast, StatCard, Empty } from '../../components/ui';

export default function PortalHome() {
  const { me, moduleOn } = useAuth();
  const toast = useToast();
  const [today, setToday] = useState(null);
  const [balances, setBalances] = useState(null);
  const [payslips, setPayslips] = useState([]);
  const [announcements, setAnnouncements] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [mySurveys, setMySurveys] = useState([]);
  const [recognitions, setRecognitions] = useState([]);

  // Each card below reads from a module-gated API, so a company that has switched one
  // of them off must not have its portal fire requests the server will refuse.
  useEffect(() => {
    if (moduleOn('attendance')) api.get('/attendance/today').then(({ data }) => setToday(data.data)).catch(() => {});
    if (moduleOn('leave')) api.get('/leave/balances').then(({ data }) => setBalances(data.data)).catch(() => {});
    if (moduleOn('payroll')) api.get('/payroll/payslips?mine=1').then(({ data }) => setPayslips(data.data.slice(0, 3))).catch(() => {});
    api.get('/dashboard/announcements').then(({ data }) => setAnnouncements(data.data)).catch(() => {});
    if (moduleOn('lifecycle')) {
      api.get('/lifecycle/onboarding').then(({ data }) => {
        const mine = data.data.find((g) => g.employeeId === me?.employee_id);
        setTasks(mine ? mine.tasks.filter((t) => t.status !== 'completed') : []);
      }).catch(() => {});
    }
    if (moduleOn('engagement')) {
      api.get('/engagement/my/surveys').then(({ data }) => setMySurveys(data.data.filter((s) => !s.answered))).catch(() => {});
      api.get('/engagement/recognitions').then(({ data }) => setRecognitions(data.data.slice(0, 3))).catch(() => {});
    }
  }, [me, moduleOn]);

  const punch = async () => {
    try {
      await api.post('/attendance/punch', {});
      toast('Punch recorded ✅');
      const { data } = await api.get('/attendance/today');
      setToday(data.data);
    } catch (e) { toast(errMsg(e), true); }
  };

  const attendanceOn = moduleOn('attendance');
  // Only a module that is on should hold the page hostage while it loads — with
  // attendance switched off there is no "today" to wait for.
  if (!today && attendanceOn) return <Spinner />;
  const isOpenPunch = today?.firstIn && (!today?.lastOut || today.firstIn === today.lastOut);

  return (
    <div>
      <div className="card mb" style={{ background: 'linear-gradient(120deg, var(--primary), #3b6fe0)', color: '#fff', border: 'none' }}>
        <div style={{ padding: 22 }} className="spread wrap">
          <div>
            <h2 style={{ fontSize: 18 }}>Hi {me?.name?.split(' ')[0]} — {new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })}</h2>
            <p style={{ opacity: .85, fontSize: 13.5, marginTop: 4 }}>
              {!attendanceOn ? 'Your workspace at a glance.' :
                today.status === 'not_marked' ? 'You have not punched in yet today.' :
                isOpenPunch ? `You punched in at ${fmtTime(today.firstIn)} — punch out when you leave.` :
                  today.firstIn ? `Worked ${Math.floor(today.workedMinutes / 60)}h ${today.workedMinutes % 60}m today.` : 'No attendance today.'}
              {today?.lateMinutes > 0 ? ` · Late by ${today.lateMinutes}m` : ''}
            </p>
          </div>
          {attendanceOn && (
            <button className="btn" style={{ background: '#fff', color: 'var(--primary)' }} onClick={punch}>
              {isOpenPunch ? '⏹ Punch out' : '▶ Punch in'}
            </button>
          )}
        </div>
      </div>

      <div className="grid c4 mb">
        <StatCard label="Attendance status" value={today ? today.status.replace(/_/g, ' ') : '—'} sub={today?.shiftName || (attendanceOn ? '' : 'Module disabled')} />
        <StatCard label="Leave balance" value={moduleOn('leave') && balances ? balances.reduce((s, b) => s + Math.max(0, b.available), 0) : '—'} sub="Total available days" />
        <StatCard label="Latest payslip" value={payslips[0] ? money2(payslips[0].net_pay) : '—'} sub={payslips[0] ? `${MONTH_NAME(payslips[0].period_month)} ${payslips[0].period_year}` : moduleOn('payroll') ? 'No payslips yet' : 'Module disabled'} />
        <StatCard label="Pending tasks" value={moduleOn('lifecycle') ? tasks.length : '—'} sub="Onboarding / docs" />
      </div>

      <div className="grid c2">
        <div className="card">
          <div className="card-h"><h3>Announcements</h3></div>
          <div className="card-b">
            {announcements.length === 0 && <Empty icon="📣" text="No announcements" />}
            {announcements.map((a) => (
              <div key={a.id} style={{ padding: '9px 0', borderBottom: '1px solid var(--border)' }}>
                <b style={{ fontSize: 13.5 }}>{a.pinned ? '📌 ' : ''}{a.title}</b>
                <p style={{ fontSize: 13, color: 'var(--muted)' }}>{a.body}</p>
              </div>
            ))}
          </div>
        </div>
        <div className="card">
          <div className="card-h"><h3>Quick links</h3></div>
          <div className="card-b" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            {[
              ['/portal/attendance', '⏱ My attendance', 'Calendar & regularization', 'attendance'],
              ['/portal/leave', '🌴 Apply leave', 'Balances & history', 'leave'],
              ['/portal/payslips', '💰 Payslips', 'Download PDFs', null],
              ['/portal/expenses', '🧾 Expenses', 'Submit claims', 'expenses'],
              ['/portal/travel', '✈️ My travel', 'Requests & advances', 'travel'],
              ['/timesheets', '📋 Timesheets', 'Log weekly hours', 'timesheets'],
              ['/portal/documents', '📄 Documents', 'Policies & letters', 'documents'],
              ['/engagement', '🎉 Recognition', 'Surveys & kudos', 'engagement'],
              ['/tickets', '🎫 Helpdesk', 'Raise a request', 'helpdesk'],
            ].filter(([, , , mod]) => !mod || moduleOn(mod)).map(([to, t, s]) => (
              <Link key={to} to={to} className="card" style={{ padding: 14, textDecoration: 'none' }}>
                <b style={{ fontSize: 13.5, color: 'var(--text)' }}>{t}</b>
                <div style={{ fontSize: 12, color: 'var(--muted)' }}>{s}</div>
              </Link>
            ))}
          </div>
          {tasks.length > 0 && (
            <div className="card-b" style={{ borderTop: '1px solid var(--border)' }}>
              <h4 style={{ fontSize: 13, marginBottom: 6 }}>Your pending onboarding tasks</h4>
              {tasks.map((t) => <p key={t.id} style={{ fontSize: 13 }}>⬜ {t.title}</p>)}
            </div>
          )}
        </div>
      </div>

      {(mySurveys.length > 0 || recognitions.length > 0) && (
        <div className="grid c2 mt">
          {mySurveys.length > 0 && (
            <div className="card" style={{ borderLeft: '3px solid var(--primary)' }}>
              <div className="card-h"><h3>📣 Pulse survey waiting for you</h3></div>
              <div className="card-b">
                {mySurveys.map((s) => (
                  <div key={s.id} className="spread" style={{ padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
                    <div>
                      <b style={{ fontSize: 13.5 }}>{s.title}</b>
                      <div style={{ fontSize: 12, color: 'var(--muted)' }}>{s.anonymity === 'anonymous' ? '🔒 Anonymous' : 'Named'} · closes {fmtDate(s.end_date)}</div>
                    </div>
                    <Link to="/engagement" className="btn sm">Respond</Link>
                  </div>
                ))}
              </div>
            </div>
          )}
          {recognitions.length > 0 && (
            <div className="card">
              <div className="card-h spread"><h3>🎉 Recent recognition</h3><Link to="/engagement" style={{ fontSize: 12.5 }}>View all</Link></div>
              <div className="card-b">
                {recognitions.map((r) => (
                  <div key={r.id} style={{ padding: '8px 0', borderBottom: '1px solid var(--border)', fontSize: 13 }}>
                    <span className="badge amber">{r.rtype}</span> <b>{r.to_name}</b>
                    <div style={{ color: 'var(--muted)', fontSize: 12.5 }}>"{r.message}" — {r.from_name}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function MONTH_NAME(m) { return ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1]; }
