const dayjs = require('dayjs');
const { pool } = require('../config/db');
const { round2, inr } = require('../utils/helpers');

/**
 * India statutory return builders, derived entirely from stored payroll snapshots.
 * Nothing is recomputed: a return must always reconcile with the payslips that were paid,
 * so every figure is read back from payroll_items rather than re-running the engine.
 */

const COMMITTED = "('approved','locked','paid')";

const parse = (v, fallback) => {
  if (v === null || v === undefined) return fallback;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return fallback; }
};

/** Per-employee rows for a set of committed payroll items in a period. */
async function committedItems(tenantId, { year, month, from, to }) {
  const params = [tenantId];
  let period = '';
  if (year && month) { period = 'AND pr.period_year = ? AND pr.period_month = ?'; params.push(year, month); }
  else if (from && to) {
    period = 'AND DATE(CONCAT(pr.period_year, "-", LPAD(pr.period_month, 2, "0"), "-01")) BETWEEN ? AND ?';
    params.push(from, to);
  }
  const [rows] = await pool.query(
    `SELECT pi.*, e.employee_code, e.first_name, e.last_name, e.pan_plain, e.pan_enc,
            e.uan, e.esic_no, e.ifsc, e.bank_name, e.bank_account_enc,
            e.tax_regime, e.department_id, d.name AS department,
            l.state AS location_state,
            pr.period_year, pr.period_month, pr.status AS run_status, pr.pay_date, pr.id AS run_id
     FROM payroll_items pi
     JOIN payroll_runs pr ON pr.id = pi.run_id
     JOIN employees e ON e.id = pi.employee_id
     LEFT JOIN departments d ON d.id = e.department_id
     LEFT JOIN locations l ON l.id = e.location_id
     WHERE pi.tenant_id = ? AND pr.status IN ${COMMITTED} ${period}
     ORDER BY e.employee_code, pr.period_year, pr.period_month`,
    params
  );
  return rows;
}

const stat = (row) => {
  const snap = parse(row.inputs_snapshot, {});
  return {
    ...(snap.statutoryValues || {}),
    pfWage: snap.statutoryBreakdown?.pf?.pfWage ?? 0,
    projectedAnnualTaxable: Number(snap.statutoryBreakdown?.tds?.projectedAnnualTaxable || 0),
    projectedAnnualTax: Number(snap.statutoryBreakdown?.tds?.projectedAnnualTax || 0),
    versions: {
      pf: snap.statutoryBreakdown?.pf?.ruleVersion || null,
      esi: snap.statutoryBreakdown?.esi?.ruleVersion || null,
      pt: snap.statutoryBreakdown?.pt?.ruleVersion || null,
      tds: snap.statutoryBreakdown?.tds?.ruleVersion || null,
      lwf: snap.statutoryBreakdown?.lwf?.ruleVersion || null,
    },
  };
};

const name = (r) => `${r.first_name} ${r.last_name}`.trim();
const money = (v) => round2(Number(v) || 0);

/** PF ECR (Electronic Challan cum Return) — monthly. */
async function pfEcr(tenantId, period) {
  const rows = await committedItems(tenantId, period);
  const items = rows.map((r) => {
    const s = stat(r);
    const gross = money(r.gross);
    return {
      uan: r.uan || '',
      employeeCode: r.employee_code,
      name: name(r),
      ifsc: r.ifsc || '',
      grossWages: gross,
      pfWages: money(s.pfWage),
      epsContribution: money(s.pfEps),
      epfContribution: money(s.pfEmployee),
      edliContribution: 0,
      refundOfAdvances: 0,
      month: `${r.period_year}-${String(r.period_month).padStart(2, '0')}`,
      ruleVersion: s.versions.pf,
    };
  });
  const sum = (k) => round2(items.reduce((acc, i) => acc + i[k], 0));
  return {
    kind: 'pf-ecr',
    title: 'Provident Fund — ECR / Challan cum Return',
    period: periodLabel(period),
    items,
    totals: {
      employees: items.length,
      grossWages: sum('grossWages'),
      pfWages: sum('pfWages'),
      epsContribution: sum('epsContribution'),
      epfContribution: sum('epfContribution'),
      edliContribution: sum('edliContribution'),
      // Employer PF remittance = EPS + EDLI (the employee's 12% share is withheld from salary)
      employerLiability: round2(sum('epsContribution') + sum('edliContribution')),
      employeeWithheld: sum('epfContribution'),
      totalRemittance: round2(sum('epsContribution') + sum('edliContribution') + sum('epfContribution')),
    },
  };
}

/** ESI contribution return — quarterly by default (Apr–Jun, Jul–Sep, Oct–Dec, Jan–Mar). */
async function esiReturn(tenantId, period) {
  const rows = await committedItems(tenantId, period);
  const items = rows.map((r) => {
    const s = stat(r);
    return {
      ipNumber: r.esic_no || r.employee_code,
      employeeCode: r.employee_code,
      name: name(r),
      grossWages: money(r.gross),
      contributionDays: Number(r.payable_days) || 0,
      esiEmployee: money(s.esiEmployee),
      esiEmployer: money(s.esiEmployer),
      month: `${r.period_year}-${String(r.period_month).padStart(2, '0')}`,
      ruleVersion: s.versions.esi,
    };
  }).filter((i) => i.esiEmployee > 0 || i.esiEmployer > 0);

  const sum = (k) => round2(items.reduce((acc, i) => acc + i[k], 0));
  return {
    kind: 'esi',
    title: 'ESI — Employee & Employer Contribution Return',
    period: periodLabel(period),
    items,
    totals: {
      employees: items.length,
      grossWages: sum('grossWages'),
      esiEmployee: sum('esiEmployee'),
      esiEmployer: sum('esiEmployer'),
      totalRemittance: round2(sum('esiEmployee') + sum('esiEmployer')),
    },
  };
}

/** Professional Tax — state-wise slab summary. */
async function ptReturn(tenantId, period) {
  const rows = await committedItems(tenantId, period);
  const byState = new Map();
  for (const r of rows) {
    const s = stat(r);
    const pt = money(s.pt);
    if (pt <= 0) continue;
    const state = r.location_state || 'IN';
    if (!byState.has(state)) byState.set(state, { state, employees: new Set(), taxableGross: 0, ptCollected: 0 });
    const g = byState.get(state);
    g.employees.add(r.employee_id);
    g.taxableGross += money(r.gross);
    g.ptCollected += pt;
  }
  const summary = [...byState.values()].map((g) => ({
    state: g.state,
    employees: g.employees.size,
    taxableGross: round2(g.taxableGross),
    ptCollected: round2(g.ptCollected),
  })).sort((a, b) => a.state.localeCompare(b.state));

  return {
    kind: 'pt',
    title: 'Professional Tax — State-wise Collection Summary',
    period: periodLabel(period),
    byState: summary,
    totals: {
      states: summary.length,
      employees: summary.reduce((a, s) => a + s.employees, 0),
      taxableGross: round2(summary.reduce((a, s) => a + s.taxableGross, 0)),
      ptCollected: round2(summary.reduce((a, s) => a + s.ptCollected, 0)),
    },
  };
}

/** TDS deposited (26Q view) plus an annual 16A-style reconciliation per employee. */
async function tdsReturn(tenantId, period) {
  const rows = await committedItems(tenantId, period);

  const deposits = rows.map((r) => {
    const s = stat(r);
    const tds = money(s.tds);
    return {
      pan: r.pan_plain || '',
      employeeCode: r.employee_code,
      name: name(r),
      department: r.department,
      regime: r.tax_regime || 'new',
      gross: money(r.gross),
      tdsDeposited: tds,
      projectedAnnualTaxable: money(s.projectedAnnualTaxable),
      projectedAnnualTax: money(s.projectedAnnualTax),
      month: `${r.period_year}-${String(r.period_month).padStart(2, '0')}`,
    };
  }).filter((d) => d.tdsDeposited > 0);

  // Annual roll-up: gross paid vs TDS deducted vs projected annual liability.
  const byEmp = new Map();
  for (const d of deposits) {
    if (!byEmp.has(d.employeeCode)) {
      byEmp.set(d.employeeCode, { pan: d.pan, employeeCode: d.employeeCode, name: d.name, department: d.department, regime: d.regime, months: 0, gross: 0, tds: 0, projectedAnnualTax: 0 });
    }
    const a = byEmp.get(d.employeeCode);
    a.months += 1;
    a.gross += d.gross;
    a.tds += d.tdsDeposited;
    a.projectedAnnualTax = Math.max(a.projectedAnnualTax, d.projectedAnnualTax);
  }
  const annual = [...byEmp.values()].map((a) => {
    // Compare like with like: the annual projection pro-rated to the months actually paid,
    // otherwise a run in month 1 always looks like a massive shortfall.
    const expectedSoFar = money((a.projectedAnnualTax || 0) * (a.months / 12));
    const shortfall = round2(Math.max(0, expectedSoFar - a.tds));
    return {
      ...a,
      gross: round2(a.gross),
      tds: round2(a.tds),
      tdsToDate: round2(a.tds),
      projectedAnnualTax: money(a.projectedAnnualTax),
      expectedSoFar,
      shortfall,
      variance: round2(a.tds - expectedSoFar),
      onTrack: shortfall === 0,
    };
  }).sort((x, y) => y.shortfall - x.shortfall || y.tds - x.tds);

  const sum = (k) => round2(deposits.reduce((acc, d) => acc + d[k], 0));
  return {
    kind: 'tds',
    title: 'TDS on Salary — Deposits & Annual Reconciliation',
    period: periodLabel(period),
    deposits,
    annual,
    totals: {
      employees: deposits.length,
      gross: sum('gross'),
      tdsDeposited: sum('tdsDeposited'),
      withoutPan: deposits.filter((d) => !d.pan).length,
      shortfall: round2(annual.reduce((a, x) => a + x.shortfall, 0)),
      overDeducted: round2(annual.reduce((a, x) => a + Math.max(0, x.variance), 0)),
      offTrack: annual.filter((x) => !x.onTrack).length,
    },
  };
}

/**
 * Bank reconciliation for a run: payroll net pay vs what the bank file says we paid.
 * Flags employees with no bank details or a zero/unpaid net.
 */
async function bankReconciliation(tenantId, runId) {
  const [runs] = await pool.query('SELECT * FROM payroll_runs WHERE id = ? AND tenant_id = ?', [runId, tenantId]);
  if (!runs[0]) return null;
  const run = runs[0];
  const [rows] = await pool.query(
    `SELECT pi.employee_id, pi.net_pay, e.employee_code, e.first_name, e.last_name,
            e.bank_name, e.bank_account_enc, e.ifsc, e.pan_plain, e.pan_enc
     FROM payroll_items pi JOIN employees e ON e.id = pi.employee_id
     WHERE pi.run_id = ? ORDER BY e.employee_code`,
    [runId]
  );
  const items = rows.map((r) => {
    const issues = [];
    if (!r.bank_account_enc) issues.push('missing_bank_account');
    if (!r.ifsc) issues.push('missing_ifsc');
    if (Number(r.net_pay) <= 0) issues.push('non_positive_net');
    if (!r.pan_plain && !r.pan_enc) issues.push('missing_pan');
    return {
      employeeCode: r.employee_code,
      name: `${r.first_name} ${r.last_name}`,
      netPay: money(r.net_pay),
      bankName: r.bank_name,
      ifsc: r.ifsc || '',
      hasAccount: !!r.bank_account_enc,
      hasPan: !!(r.pan_plain || r.pan_enc),
      status: issues.length ? 'exception' : 'ok',
      issues,
    };
  });
  const exceptions = items.filter((i) => i.status === 'exception');
  return {
    runId,
    period: `${run.period_month}/${run.period_year}`,
    status: run.status,
    items,
    exceptions,
    totals: {
      employees: items.length,
      netPay: round2(items.reduce((a, i) => a + i.netPay, 0)),
      readyToPay: items.length - exceptions.length,
      exceptions: exceptions.length,
    },
  };
}

function periodLabel(period) {
  const { year, month, from, to } = period || {};
  if (year && month) return `${year}-${String(month).padStart(2, '0')}`;
  if (from && to) return `${from} to ${to}`;
  return 'all committed periods';
}

/** Financial-year helper for quarterly returns (Apr–Mar). */
function fyRange(fy, quarter) {
  const startYear = parseInt(String(fy).slice(0, 4), 10);
  if (!startYear) throw new Error('fy must look like 2026-27');
  const quarters = {
    Q1: [`${startYear}-04-01`, `${startYear}-06-30`],
    Q2: [`${startYear}-07-01`, `${startYear}-09-30`],
    Q3: [`${startYear}-10-01`, `${startYear}-12-31`],
    Q4: [`${startYear + 1}-01-01`, `${startYear + 1}-03-31`],
    FY: [`${startYear}-04-01`, `${startYear + 1}-03-31`],
  };
  return quarters[String(quarter || 'FY').toUpperCase()] || quarters.FY;
}

const BUILDERS = { 'pf-ecr': pfEcr, esi: esiReturn, pt: ptReturn, tds: tdsReturn };

/** Build a statutory return by kind. */
async function buildReturn(tenantId, kind, period = {}) {
  const builder = BUILDERS[String(kind).toLowerCase()];
  if (!builder) throw new Error(`Unknown statutory return: ${kind}. Available: ${Object.keys(BUILDERS).join(', ')}`);
  return builder(tenantId, period);
}

module.exports = { buildReturn, pfEcr, esiReturn, ptReturn, tdsReturn, bankReconciliation, fyRange, inr, dayjs };