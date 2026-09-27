import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, money } from '../api';
import { useAuth } from '../auth';
import { BarList, Donut, Empty, Spinner, StatCard, StatusBadge } from '../components/ui';
import { MONTHS } from '../api';

export default function Dashboard() {
  const { me, can } = useAuth();
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    api.get('/dashboard').then(({ data }) => setD(data.data)).catch((e) => setErr(e?.response?.data?.message || 'Failed to load'));
  }, []);

  if (err) return <div className="error-box">{err}</div>;
  if (!d) return <Spinner />;

  const att = d.attendanceToday || {};
  const attData = [
    { label: 'Present', value: att.present || 0 },
    { label: 'On leave', value: att.onLeave || 0 },
    { label: 'Half day', value: att.halfDay || 0 },
    { label: 'Absent', value: att.absent || 0 },
  ].filter((x) => x.value > 0);

  const months = [...d.trend.joiners, ...d.trend.exits].map((x) => x.ym);
  const uniqueMonths = [...new Set(months)].sort();

  return (
    <div>
      <div className="spread mb">
        <div>
          <h2 style={{ fontSize: 19 }}>Welcome back, {me?.name?.split(' ')[0]} 👋</h2>
          <p style={{ color: 'var(--muted)', fontSize: 13 }}>
            {new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })} · {me?.tenantName}
          </p>
        </div>
        {me?.employee_id && <Link className="btn secondary" to="/portal">Open My Workspace →</Link>}
      </div>

      <div className="grid c4 mb">
        <StatCard label="Total employees" value={d.headcount.total} sub={`${d.headcount.active || 0} active · ${d.headcount.onNotice || 0} on notice`} />
        <StatCard label="New joiners this month" value={d.headcount.newJoiners || 0} sub={`${d.headcount.exits || 0} exits`} />
        <StatCard label="Pending approvals" value={(d.approvals.leaves || 0) + (d.approvals.regularizations || 0) + (d.approvals.expenses || 0)}
          sub={`${d.approvals.leaves || 0} leaves · ${d.approvals.expenses || 0} expenses`} />
        {can('billing.view')
          ? <StatCard label="Invoice outstanding" value={money(d.invoiceOutstanding)} accent="var(--red)" sub="Across sent & overdue invoices" />
          : <StatCard label="Open tickets" value={d.approvals.tickets || 0} sub="Helpdesk" />}
      </div>

      <div className="grid c2 mb">
        <div className="card">
          <div className="card-h"><h3>Attendance today</h3></div>
          <div className="card-b">
            {attData.length ? <Donut data={attData} /> : <Empty text="No attendance marked yet today" />}
          </div>
        </div>
        <div className="card">
          <div className="card-h"><h3>Headcount by department</h3></div>
          <div className="card-b">
            {d.byDept.length ? <BarList data={d.byDept.map((x) => ({ label: x.label, value: x.n }))} /> : <Empty text="No departments yet" />}
          </div>
        </div>
      </div>

      <div className="grid c2">
        <div className="card">
          <div className="card-h">
            <h3>Hiring trend (6 months)</h3>
            {d.lastPayroll && <StatusBadge value={d.lastPayroll.status} />}
          </div>
          <div className="card-b">
            {uniqueMonths.length ? (
              <BarList
                data={uniqueMonths.map((ym) => ({
                  label: MONTHS[parseInt(ym.split('-')[1], 10) - 1] + ' ' + ym.split('-')[0].slice(2),
                  value: (d.trend.joiners.find((x) => x.ym === ym)?.joiners || 0),
                }))}
                valueFormat={(v) => v + ' joined'}
              />
            ) : <Empty text="No hiring activity" />}
          </div>
        </div>
        <div className="card">
          <div className="card-h"><h3>Alerts</h3></div>
          <div className="card-b">
            {d.expiringDocs.length === 0 && <Empty icon="✅" text="No document expiries in the next 30 days" />}
            {d.expiringDocs.map((doc) => (
              <div className="spread" key={doc.id} style={{ padding: '7px 0', borderBottom: '1px solid var(--border)' }}>
                <div>
                  <b style={{ fontSize: 13 }}>{doc.name}</b>
                  <div style={{ fontSize: 12, color: 'var(--muted)' }}>{doc.first_name} {doc.last_name} ({doc.employee_code})</div>
                </div>
                <span className="badge amber">expires {new Date(doc.expires_on).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}</span>
              </div>
            ))}
            {d.birthdays.length > 0 && (
              <p style={{ marginTop: 12, fontSize: 13, color: 'var(--muted)' }}>
                🎂 Birthdays this month: {d.birthdays.map((b) => `${b.first_name} ${b.last_name}`).join(', ')}
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
