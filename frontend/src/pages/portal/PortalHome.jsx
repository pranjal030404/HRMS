import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, errMsg, fmtDate, fmtTime, money2 } from '../../api';
import { useAuth } from '../../auth';
import { Spinner, useToast, StatCard, Empty } from '../../components/ui';

export default function PortalHome() {
  const { me } = useAuth();
  const toast = useToast();
  const [today, setToday] = useState(null);
  const [balances, setBalances] = useState(null);
  const [payslips, setPayslips] = useState([]);
  const [announcements, setAnnouncements] = useState([]);
  const [tasks, setTasks] = useState([]);

  useEffect(() => {
    api.get('/attendance/today').then(({ data }) => setToday(data.data)).catch(() => {});
    api.get('/leave/balances').then(({ data }) => setBalances(data.data)).catch(() => {});
    api.get('/payroll/payslips?mine=1').then(({ data }) => setPayslips(data.data.slice(0, 3))).catch(() => {});
    api.get('/dashboard/announcements').then(({ data }) => setAnnouncements(data.data)).catch(() => {});
    api.get('/lifecycle/onboarding').then(({ data }) => {
      const mine = data.data.find((g) => g.employeeId === me?.employee_id);
      setTasks(mine ? mine.tasks.filter((t) => t.status !== 'completed') : []);
    }).catch(() => {});
  }, [me]);

  const punch = async () => {
    try {
      await api.post('/attendance/punch', {});
      toast('Punch recorded ✅');
      const { data } = await api.get('/attendance/today');
      setToday(data.data);
    } catch (e) { toast(errMsg(e), true); }
  };

  if (!today) return <Spinner />;
  const isOpenPunch = today.firstIn && (!today.lastOut || today.firstIn === today.lastOut);

  return (
    <div>
      <div className="card mb" style={{ background: 'linear-gradient(120deg, var(--primary), #3b6fe0)', color: '#fff', border: 'none' }}>
        <div style={{ padding: 22 }} className="spread wrap">
          <div>
            <h2 style={{ fontSize: 18 }}>Hi {me?.name?.split(' ')[0]} — {new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })}</h2>
            <p style={{ opacity: .85, fontSize: 13.5, marginTop: 4 }}>
              {today.status === 'not_marked' ? 'You have not punched in yet today.' :
                isOpenPunch ? `You punched in at ${fmtTime(today.firstIn)} — punch out when you leave.` :
                  today.firstIn ? `Worked ${Math.floor(today.workedMinutes / 60)}h ${today.workedMinutes % 60}m today.` : 'No attendance today.'}
              {today.lateMinutes > 0 ? ` · Late by ${today.lateMinutes}m` : ''}
            </p>
          </div>
          <button className="btn" style={{ background: '#fff', color: 'var(--primary)' }} onClick={punch}>
            {isOpenPunch ? '⏹ Punch out' : '▶ Punch in'}
          </button>
        </div>
      </div>

      <div className="grid c4 mb">
        <StatCard label="Attendance status" value={today.status.replace(/_/g, ' ')} sub={today.shiftName || ''} />
        <StatCard label="Leave balance" value={balances ? balances.reduce((s, b) => s + Math.max(0, b.available), 0) : '—'} sub="Total available days" />
        <StatCard label="Latest payslip" value={payslips[0] ? money2(payslips[0].net_pay) : '—'} sub={payslips[0] ? `${MONTH_NAME(payslips[0].period_month)} ${payslips[0].period_year}` : 'No payslips yet'} />
        <StatCard label="Pending tasks" value={tasks.length} sub="Onboarding / docs" />
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
              ['/portal/attendance', '⏱ My attendance', 'Calendar & regularization'],
              ['/portal/leave', '🌴 Apply leave', 'Balances & history'],
              ['/portal/payslips', '💰 Payslips', 'Download PDFs'],
              ['/portal/expenses', '🧾 Expenses', 'Submit claims'],
              ['/portal/documents', '📄 Documents', 'Policies & letters'],
              ['/tickets', '🎫 Helpdesk', 'Raise a request'],
            ].map(([to, t, s]) => (
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
    </div>
  );
}

function MONTH_NAME(m) { return ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1]; }
