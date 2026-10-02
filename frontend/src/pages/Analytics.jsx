import React, { useEffect, useState } from 'react';
import { api, errMsg, money, fmtDate } from '../api';
import { Spinner, useToast, Tabs, StatCard, Empty, BarList } from '../components/ui';

function Card({ title, children }) {
  return <div className="card"><div className="card-h"><h3>{title}</h3></div><div style={{ padding: '0 14px 14px' }}>{children}</div></div>;
}

export default function Analytics() {
  const toast = useToast();
  const [tab, setTab] = useState('executive');
  const [data, setData] = useState({});

  const load = async (which) => {
    try {
      const { data: d } = await api.get(`/analytics/${which}`);
      setData((prev) => ({ ...prev, [which]: d.data }));
    } catch (e) { toast(errMsg(e), true); setData((prev) => ({ ...prev, [which]: { error: true } })); }
  };

  useEffect(() => { if (data[tab] === undefined) load(tab); }, [tab]); // eslint-disable-line

  const has = (k) => data[k] !== undefined;

  return (
    <>
      <Tabs active={tab} onChange={setTab} tabs={[
        { key: 'executive', label: 'Executive' }, { key: 'hr', label: 'HR' }, { key: 'recruitment', label: 'Recruitment' },
        { key: 'attendance', label: 'Attendance' }, { key: 'payroll', label: 'Payroll' }, { key: 'performance', label: 'Performance' },
        { key: 'compensation', label: 'Compensation' }, { key: 'compliance', label: 'Compliance' },
      ]} />

      {!has(tab) && <Spinner />}
      {has(tab) && data[tab]?.error && <div className="card mt" style={{ padding: 20 }}>Failed to load this dashboard.</div>}

      {tab === 'executive' && data.executive && !data.executive.error && (
        <>
          <div className="stat-grid mt">
            <StatCard label="Headcount" value={data.executive.headcount} sub="active + probation" />
            <StatCard label="Annual workforce cost" value={money(data.executive.workforceCost)} />
            <StatCard label="Turnover (12m)" value={`${data.executive.turnoverRate}%`} sub={`${data.executive.exited12m} exits · ${data.executive.joined12m} joined`} />
            <StatCard label="Open roles" value={data.executive.openReq} />
            <StatCard label="Present today" value={data.executive.presentToday} />
            <StatCard label="Net payroll paid (all runs)" value={money(data.executive.payrollCost)} />
          </div>
        </>
      )}

      {tab === 'hr' && data.hr && !data.hr.error && (
        <>
          <div className="stat-grid mt">
            <StatCard label="Absenteeism (30d)" value={`${data.hr.absentRate ?? 0}%`} />
            <StatCard label="On leave today" value={data.hr.onLeaveToday} />
            <StatCard label="Pending leave approvals" value={data.hr.pendingLeaves} />
            <StatCard label="Avg tenure" value={`${data.hr.avgTenureMonths ?? 0} months`} />
            <StatCard label="Recognitions (30d)" value={data.hr.recognitions30d} />
          </div>
          <div className="grid2 mt">
            <Card title="Joins by month (12m)">
              <BarList valueFormat={(v) => v} data={(data.hr.headcountByMonth || []).map((x) => ({ label: x.ym, value: x.joined }))} />
            </Card>
          </div>
        </>
      )}

      {tab === 'recruitment' && data.recruitment && !data.recruitment.error && (
        <>
          <div className="stat-grid mt">
            <StatCard label="Open roles" value={data.recruitment.openRoles} />
            <StatCard label="Offers accepted" value={data.recruitment.hired90d} />
            <StatCard label="Offers awaiting response" value={data.recruitment.offersPending} />
            <StatCard label="Avg time-to-hire" value={`${data.recruitment.avgTTH ?? 0} days`} />
          </div>
          <div className="grid2 mt">
            <Card title="Pipeline by stage">
              <BarList data={(data.recruitment.byStage || []).map((x) => ({ label: x.stage, value: x.n }))} />
            </Card>
            <Card title="Candidates by source">
              <BarList data={(data.recruitment.bySource || []).map((x) => ({ label: x.source, value: x.n }))} color="#6941c6" />
            </Card>
          </div>
        </>
      )}

      {tab === 'attendance' && data.attendance && !data.attendance.error && (
        <>
          <div className="stat-grid mt">
            <StatCard label="Pending regularizations" value={data.attendance.pendingReg} />
          </div>
          <Card title="Daily attendance (last 30 days)">
            {data.attendance.trend?.length ? (
              <div className="table-wrap"><table className="tbl">
                <thead><tr><th>Date</th><th>Present</th><th>Absent</th><th>Half day</th><th>Avg late (min)</th><th>OT (hrs)</th></tr></thead>
                <tbody>{data.attendance.trend.slice(-30).map((t) => (
                  <tr key={t.adate}><td>{fmtDate(t.adate)}</td><td>{t.present}</td><td>{t.absent}</td><td>{t.half_day}</td><td>{t.avg_late || 0}</td><td>{t.ot_hours || 0}</td></tr>
                ))}</tbody>
              </table></div>
            ) : <Empty text="No attendance data" />}
          </Card>
        </>
      )}

      {tab === 'payroll' && data.payroll && !data.payroll.error && (
        <>
          <div className="stat-grid mt">
            <StatCard label="PF (all runs)" value={money(data.payroll.statutoryTotals.pf)} />
            <StatCard label="ESI" value={money(data.payroll.statutoryTotals.esi)} />
            <StatCard label="Professional Tax" value={money(data.payroll.statutoryTotals.pt)} />
            <StatCard label="TDS" value={money(data.payroll.statutoryTotals.tds)} />
          </div>
          <Card title="Payroll by month">
            {data.payroll.byMonth?.length ? (
              <div className="table-wrap"><table className="tbl">
                <thead><tr><th>Period</th><th>Headcount</th><th>Gross</th><th>Deductions</th><th>Net</th><th>Employer cost</th></tr></thead>
                <tbody>{data.payroll.byMonth.map((m) => (
                  <tr key={m.period}>
                    <td>{m.period}</td><td>{m.headcount}</td>
                    <td>{money(m.gross)}</td><td>{money(m.deductions)}</td><td><b>{money(m.net)}</b></td><td>{money(m.employer_cost)}</td>
                  </tr>
                ))}</tbody>
              </table></div>
            ) : <Empty text="No payroll runs processed yet — calculate a run to populate this dashboard" />}
          </Card>
        </>
      )}

      {tab === 'performance' && data.performance && !data.performance.error && (
        <>
          <div className="stat-grid mt">
            <StatCard label="Active goals" value={data.performance.activeGoals} />
            <StatCard label="Avg goal progress" value={`${data.performance.avgProgress ?? 0}%`} />
            <StatCard label="Final ratings given" value={data.performance.finalRated} />
          </div>
          <div className="grid2 mt">
            <Card title="Reviews by status">
              <BarList data={(data.performance.reviewsByStatus || []).map((x) => ({ label: x.status, value: x.n }))} color="#0e9384" />
            </Card>
            <Card title="Rating distribution">
              <BarList data={(data.performance.ratingDist || []).map((x) => ({ label: `${x.rating}★`, value: x.n }))} color="#f79009" />
            </Card>
          </div>
        </>
      )}

      {tab === 'compensation' && data.compensation && !data.compensation.error && (
        <>
          <div className="stat-grid mt">
            <StatCard label="Salary revisions (12m)" value={data.compensation.revisions12m} />
            <StatCard label="Bonus budget (active plans)" value={money(data.compensation.bonusBudget)} />
          </div>
          <Card title="Average CTC by grade (₹ lakh / yr)">
            <BarList valueFormat={(v) => `${v} LPA`} data={(data.compensation.byGrade || []).map((x) => ({ label: `${x.grade} (${x.employees})`, value: x.avg_lpa }))} color="#067647" />
          </Card>
        </>
      )}

      {tab === 'compliance' && data.compliance && !data.compliance.error && (
        <>
          <div className="stat-grid mt">
            <StatCard label="Documents expiring (60d)" value={data.compliance.expiringDocs} accent={data.compliance.expiringDocs ? 'var(--red, #b42318)' : undefined} />
            <StatCard label="Certifications expiring (90d)" value={data.compliance.expiringCerts} accent={data.compliance.expiringCerts ? '#f79009' : undefined} />
            <StatCard label="Open HR cases" value={data.compliance.openCases} />
            <StatCard label="Unverified documents" value={data.compliance.unverifiedDocs} />
          </div>
          <Card title="Recent audit events">
            {data.compliance.recentAudit?.length ? data.compliance.recentAudit.map((a, i) => (
              <div key={i} className="spread" style={{ padding: '6px 0', borderBottom: '1px solid var(--border)', fontSize: 13 }}>
                <span><b>{a.action}</b> on {a.entity_type || '—'} — {a.actor_name || 'system'}</span>
                <span style={{ color: 'var(--muted)' }}>{fmtDate(a.created_at, true)}</span>
              </div>
            )) : <Empty text="No audit events" />}
          </Card>
        </>
      )}
    </>
  );
}
