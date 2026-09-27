import React, { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, errMsg, money2, money, MONTHS } from '../api';
import { useAuth } from '../auth';
import { Spinner, StatusBadge, useToast, downloadFile, Empty } from '../components/ui';

export default function PayrollRunDetail() {
  const { id } = useParams();
  const { me, can } = useAuth();
  const toast = useToast();
  const [run, setRun] = useState(null);
  const [items, setItems] = useState([]);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(null);

  const load = async () => {
    try {
      const { data } = await api.get(`/payroll/runs/${id}`);
      setRun(data.data);
      setItems(data.items);
    } catch (e) { toast(errMsg(e), true); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [id]);

  const doAction = async (action) => {
    if (action === 'approve' && !confirm('Approve payroll & publish payslips to all employees?')) return;
    setBusy(true);
    try {
      await api.post(`/payroll/runs/${id}/${action}`);
      toast(`Payroll ${action === 'calculate' ? 'recalculated' : action + 'ed'} successfully`);
      load();
    } catch (e) { toast(errMsg(e), true); }
    setBusy(false);
  };

  if (!run) return <Spinner />;

  const errors = run.exceptions?.filter((x) => x.severity === 'error') || [];
  const warnings = run.exceptions?.filter((x) => x.severity === 'warning') || [];

  return (
    <div>
      <div className="spread mb">
        <div className="row">
          <Link to="/payroll" className="btn ghost sm">← Runs</Link>
          <h2 style={{ fontSize: 17 }}>Payroll — {MONTHS[run.period_month - 1]} {run.period_year} <StatusBadge value={run.status} /></h2>
        </div>
        <div className="row">
          {can('payroll.calculate') && ['draft', 'calculated'].includes(run.status) && (
            <button className="btn" disabled={busy} onClick={() => doAction('calculate')}>{run.status === 'calculated' ? '↻ Recalculate' : '▶ Calculate payroll'}</button>
          )}
          {can('payroll.submit') && run.status === 'calculated' && (
            <button className="btn" disabled={busy || errors.length > 0} onClick={() => doAction('submit')}>Submit for approval</button>
          )}
          {can('payroll.approve') && run.status === 'submitted' && (
            <button className="btn success" disabled={busy} onClick={() => doAction('approve')}>✓ Approve & publish payslips</button>
          )}
          {can('payroll.lock') && run.status === 'approved' && (
            <button className="btn" style={{ background: 'var(--purple)' }} disabled={busy} onClick={() => doAction('lock')}>🔒 Lock payroll</button>
          )}
          {can('payroll.pay') && run.status === 'locked' && (
            <button className="btn success" disabled={busy} onClick={() => doAction('pay')}>Mark as paid</button>
          )}
          {can('payroll.calculate') && ['draft', 'calculated', 'submitted'].includes(run.status) && (
            <button className="btn danger" disabled={busy} onClick={() => doAction('cancel')}>Cancel run</button>
          )}
          {can('payroll.view_sensitive') && ['locked', 'paid'].includes(run.status) && (
            <button className="btn secondary" onClick={() => downloadFile(`/api/payroll/runs/${id}/bank-file`, `bank-file-${run.period_year}${String(run.period_month).padStart(2, '0')}.csv`)}>
              ⬇ Bank payment file
            </button>
          )}
        </div>
      </div>

      {run.submitted_by === me?.id && run.status === 'submitted' && (
        <div className="info-box mb">Maker-checker: you submitted this run — a different authorized approver must approve it.</div>
      )}

      <div className="grid c4 mb">
        <div className="card stat"><div className="lbl">Headcount</div><div className="val">{run.totals?.headcount ?? '—'}</div></div>
        <div className="card stat"><div className="lbl">Gross</div><div className="val">{run.totals ? money(run.totals.gross) : '—'}</div></div>
        <div className="card stat"><div className="lbl">Deductions</div><div className="val">{run.totals ? money(run.totals.totalDeductions) : '—'}</div></div>
        <div className="card stat"><div className="lbl">Net pay</div><div className="val" style={{ color: 'var(--green)' }}>{run.totals ? money(run.totals.net) : '—'}</div></div>
      </div>

      {(errors.length > 0 || warnings.length > 0) && (
        <div className="card mb">
          <div className="card-h"><h3>Validation exceptions</h3></div>
          <div className="card-b">
            {[...errors, ...warnings].map((x, i) => (
              <div key={i} className="spread" style={{ padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
                <span style={{ fontSize: 13 }}><b>{x.name}</b> ({x.employeeCode}) — {x.message}</span>
                <span className={'badge ' + (x.severity === 'error' ? 'red' : 'amber')}>{x.severity}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-h"><h3>Employee payslips ({items.length})</h3><span style={{ fontSize: 12, color: 'var(--muted)' }}>Click a row to see component-wise breakdown</span></div>
        <div className="table-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Code</th><th>Employee</th><th className="num">Payable</th><th className="num">LOP</th>
                <th className="num">Gross</th><th className="num">Deductions</th><th className="num">Net pay</th><th></th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => (
                <React.Fragment key={it.id}>
                  <tr onClick={() => setExpanded(expanded === it.id ? null : it.id)} style={{ cursor: 'pointer' }}>
                    <td>{it.employee_code}</td>
                    <td><b>{it.first_name} {it.last_name}</b><div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{it.department_name}</div></td>
                    <td className="num">{it.payable_days}</td>
                    <td className="num" style={it.lop_days > 0 ? { color: 'var(--red)' } : undefined}>{it.lop_days}</td>
                    <td className="num">{money2(it.gross)}</td>
                    <td className="num">{money2(it.total_deductions)}</td>
                    <td className="num"><b>{money2(it.net_pay)}</b></td>
                    <td className="actions">{expanded === it.id ? '▲' : '▼'}</td>
                  </tr>
                  {expanded === it.id && (
                    <tr>
                      <td colSpan={8} style={{ background: '#fafbfc' }}>
                        <div className="grid c3">
                          <div>
                            <b style={{ fontSize: 12.5 }}>Earnings</b>
                            {it.earnings.map((e) => <div className="spread" key={e.code}><span style={{ fontSize: 12.5 }}>{e.name}</span><span style={{ fontSize: 12.5 }}>{money2(e.amount)}</span></div>)}
                          </div>
                          <div>
                            <b style={{ fontSize: 12.5 }}>Deductions</b>
                            {it.deductions.length ? it.deductions.map((e) => <div className="spread" key={e.code}><span style={{ fontSize: 12.5 }}>{e.name}</span><span style={{ fontSize: 12.5 }}>{money2(e.amount)}</span></div>) : <Empty text="None" />}
                          </div>
                          <div>
                            <b style={{ fontSize: 12.5 }}>Employer contributions</b>
                            {it.employer_contrib.length ? it.employer_contrib.map((e) => <div className="spread" key={e.code}><span style={{ fontSize: 12.5 }}>{e.name}</span><span style={{ fontSize: 12.5 }}>{money2(e.amount)}</span></div>) : <Empty text="None" />}
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
