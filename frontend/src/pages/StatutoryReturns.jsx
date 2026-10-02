import React, { useEffect, useState } from 'react';
import { api, errMsg, money2, MONTHS } from '../api';
import { useAuth } from '../auth';
import DataTable from '../components/DataTable';
import { Spinner, useToast, SelectField, StatCard, Tabs, downloadFile, Empty, Field } from '../components/ui';

const CUR_YEAR = new Date().getFullYear();

const COLUMNS = {
  'pf-ecr': [
    { key: 'employeeCode', label: 'Code' },
    { key: 'name', label: 'Employee', render: (r) => <b>{r.name}</b> },
    { key: 'uan', label: 'UAN', render: (r) => r.uan || '—' },
    { key: 'grossWages', label: 'Gross wages', align: 'right', render: (r) => money2(r.grossWages) },
    { key: 'pfWages', label: 'PF wages', align: 'right', render: (r) => money2(r.pfWages) },
    { key: 'epsContribution', label: 'EPS', align: 'right', render: (r) => money2(r.epsContribution) },
    { key: 'edliContribution', label: 'EDLI', align: 'right', render: (r) => money2(r.edliContribution) },
    { key: 'epfContribution', label: 'EPF (employee)', align: 'right', render: (r) => money2(r.epfContribution) },
    { key: 'total', label: 'Total remittance', align: 'right', render: (r) => <b>{money2(r.epsContribution + r.edliContribution + r.epfContribution)}</b> },
    { key: 'ruleVersion', label: 'Rule', render: (r) => <span className="badge">{r.ruleVersion}</span> },
  ],
  esi: [
    { key: 'ipNumber', label: 'IP no.' },
    { key: 'employeeCode', label: 'Code' },
    { key: 'name', label: 'Employee', render: (r) => <b>{r.name}</b> },
    { key: 'esicNumber', label: 'ESIC no.', render: (r) => r.esicNumber || '—' },
    { key: 'days', label: 'Days', align: 'right' },
    { key: 'grossWages', label: 'Gross wages', align: 'right', render: (r) => money2(r.grossWages) },
    { key: 'esiEmployee', label: 'Employee', align: 'right', render: (r) => money2(r.esiEmployee) },
    { key: 'esiEmployer', label: 'Employer', align: 'right', render: (r) => money2(r.esiEmployer) },
    { key: 'total', label: 'Total', align: 'right', render: (r) => <b>{money2(r.esiEmployee + r.esiEmployer)}</b> },
  ],
  pt: [
    { key: 'state', label: 'State', render: (r) => <b>{r.state}</b> },
    { key: 'employees', label: 'Employees', align: 'right' },
    { key: 'taxableGross', label: 'Taxable gross', align: 'right', render: (r) => money2(r.taxableGross) },
    { key: 'ptCollected', label: 'PT collected', align: 'right', render: (r) => <b>{money2(r.ptCollected)}</b> },
  ],
  tds: [
    { key: 'employeeCode', label: 'Code' },
    { key: 'name', label: 'Employee', render: (r) => <b>{r.name}</b> },
    { key: 'pan', label: 'PAN', render: (r) => (r.pan ? r.pan : <span className="badge amber">missing</span>) },
    { key: 'regime', label: 'Regime', render: (r) => r.regime || '—' },
    { key: 'gross', label: 'Gross', align: 'right', render: (r) => money2(r.gross) },
    { key: 'tdsDeposited', label: 'TDS deposited', align: 'right', render: (r) => <b>{money2(r.tdsDeposited)}</b> },
    { key: 'projectedAnnualTax', label: 'Projected annual tax', align: 'right', render: (r) => money2(r.projectedAnnualTax) },
  ],
};

const TOTAL_CARDS = {
  'pf-ecr': (t) => [
    { label: 'Employees', value: t.employees },
    { label: 'PF wages', value: money2(t.pfWages) },
    { label: 'EPS (employer)', value: money2(t.epsContribution) },
    { label: 'Total remittance', value: money2(t.totalRemittance) },
  ],
  esi: (t) => [
    { label: 'Employees', value: t.employees },
    { label: 'Gross wages', value: money2(t.grossWages) },
    { label: 'Employee', value: money2(t.esiEmployee) },
    { label: 'Employer', value: money2(t.esiEmployer) },
    { label: 'Total remittance', value: money2(t.totalRemittance) },
  ],
  pt: (t) => [
    { label: 'States', value: t.states },
    { label: 'Employees', value: t.employees },
    { label: 'Taxable gross', value: money2(t.taxableGross) },
    { label: 'PT collected', value: money2(t.ptCollected) },
  ],
  tds: (t) => [
    { label: 'Employees', value: t.employees },
    { label: 'Gross', value: money2(t.gross) },
    { label: 'TDS deposited', value: money2(t.tdsDeposited) },
    { label: 'Shortfall', value: money2(t.shortfall), accent: t.shortfall > 0 ? 'var(--danger)' : undefined },
    { label: 'Missing PAN', value: t.withoutPan, accent: t.withoutPan > 0 ? 'var(--warn)' : undefined },
  ],
};

export default function StatutoryReturns() {
  const { can } = useAuth();
  const toast = useToast();
  const [catalog, setCatalog] = useState([]);
  const [kind, setKind] = useState('pf-ecr');
  const [out, setOut] = useState(null);
  const [year, setYear] = useState(CUR_YEAR);
  const [month, setMonth] = useState(1);
  const [fy, setFy] = useState(`${CUR_YEAR}-${String(CUR_YEAR + 1).slice(2)}`);
  const [quarter, setQuarter] = useState('Q1');
  const [showAnnual, setShowAnnual] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    api.get('/payroll/returns/catalog').then(({ data }) => setCatalog(data.data || [])).catch((e) => toast(errMsg(e), true));
  }, []); // eslint-disable-line

  const isQuarterly = kind === 'esi';

  const load = async () => {
    setLoading(true);
    try {
      const params = isQuarterly ? { fy, quarter } : { year, month };
      const { data } = await api.get(`/payroll/returns/${kind}`, { params });
      setOut(data.data);
    } catch (e) { toast(errMsg(e), true); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [kind, year, month, fy, quarter]);

  if (!can('payroll.view')) return <div className="card card-b">You do not have access to statutory returns.</div>;

  const rows = out ? (out.items || out.byState || out.deposits || []) : [];
  const csvParams = isQuarterly ? `fy=${fy}&quarter=${quarter}` : `year=${year}&month=${month}`;

  return (
    <>
      <div className="spread mb">
        <div>
          <h2 style={{ fontSize: 17 }}>Statutory Returns</h2>
          <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>
            {out ? `${out.title} · ${out.period} · built from locked payroll snapshots (no recalculation)` : 'India payroll statutory filings'}
          </div>
        </div>
        <button className="btn ghost sm" onClick={() => downloadFile(`/api/payroll/returns/${kind}?${csvParams}&format=csv`, `${kind}-${isQuarterly ? fy + '-' + quarter : `${year}-${String(month).padStart(2, '0')}`}.csv`).catch((e) => toast(e.message, true))}>
          ⬇ CSV
        </button>
      </div>

      <div className="card card-b mb">
        <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
          <SelectField value={kind} onChange={setKind} options={catalog.map((c) => ({ value: c.key, label: c.name }))} />
          {isQuarterly ? (
            <>
              <TextYear value={fy} onChange={setFy} />
              <SelectField value={quarter} onChange={setQuarter} options={['Q1', 'Q2', 'Q3', 'Q4', 'FY'].map((q) => ({ value: q, label: q === 'FY' ? 'Full year' : q }))} />
            </>
          ) : (
            <>
              <SelectField value={year} onChange={(v) => setYear(Number(v))} options={Array.from({ length: 6 }, (_, i) => CUR_YEAR - 4 + i).map((y) => ({ value: y, label: String(y) }))} />
              <SelectField value={month} onChange={(v) => setMonth(Number(v))} options={MONTHS.map((m, i) => ({ value: i + 1, label: m }))} />
            </>
          )}
          {kind === 'tds' && (
            <Tabs active={showAnnual ? 'annual' : 'deposits'} onChange={(t) => setShowAnnual(t === 'annual')} tabs={[{ key: 'deposits', label: 'Monthly deposits' }, { key: 'annual', label: 'Annual reconciliation' }]} />
          )}
        </div>
      </div>

      {out && (
        <div className="stat-grid mb">
          {(TOTAL_CARDS[kind] || (() => []))(out.totals || {}).map((c) => (
            <StatCard key={c.label} label={c.label} value={c.value} accent={c.accent} />
          ))}
        </div>
      )}

      <div className="card">
        <div className="card-h">
          <h3>{kind === 'tds' && showAnnual ? 'Annual reconciliation' : (out?.title || 'Return')}</h3>
          {kind === 'tds' && !showAnnual && <span style={{ fontSize: 12, color: 'var(--muted)' }}>Only employees with a TDS deposit this period</span>}
        </div>
        {loading ? <Spinner /> : showAnnual && kind === 'tds' ? (
          <DataTable
            columns={[
              { key: 'employeeCode', label: 'Code' },
              { key: 'name', label: 'Employee', render: (r) => <b>{r.name}</b> },
              { key: 'months', label: 'Months', align: 'right' },
              { key: 'gross', label: 'Gross', align: 'right', render: (r) => money2(r.gross) },
              { key: 'projectedAnnualTax', label: 'Projected tax', align: 'right', render: (r) => money2(r.projectedAnnualTax) },
              { key: 'deposited', label: 'Deposited', align: 'right', render: (r) => money2(r.deposited) },
              { key: 'shortfall', label: 'Shortfall', align: 'right', render: (r) => (r.shortfall > 0 ? <b style={{ color: 'var(--danger)' }}>{money2(r.shortfall)}</b> : '—') },
              { key: 'variance', label: 'Variance', align: 'right', render: (r) => money2(r.variance) },
              { key: 'onTrack', label: 'On track', render: (r) => (r.onTrack ? <span className="badge green">yes</span> : <span className="badge amber">no</span>) },
            ]}
            rows={out?.annual || []}
            emptyText="No TDS deposits in this period"
          />
        ) : rows.length === 0 ? (
          <Empty text={isQuarterly ? 'No committed payroll in this quarter' : 'No committed payroll in this month — returns are built from locked runs'} />
        ) : (
          <DataTable columns={COLUMNS[kind] || []} rows={rows} emptyText="Nothing to report" pageSize={15} />
        )}
      </div>
    </>
  );
}

function TextYear({ value, onChange }) {
  return (
    <Field label="Financial year">
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder="2026-27" style={{ width: 110 }} />
    </Field>
  );
}