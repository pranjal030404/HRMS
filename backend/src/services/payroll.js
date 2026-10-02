const dayjs = require('dayjs');
const { pool, withTransaction } = require('../config/db');
const { HttpError, round2, monthRange } = require('../utils/helpers');
const { evalFormula } = require('../utils/exprEval');
const { computeStatutory } = require('./statutory');
const { lopForMonth } = require('./attendance');
const { logAudit } = require('./audit');
const { notifyEvent } = require('./notify');
const { generatePayslipPdf } = require('./pdf');

const CALC_STATUSES = ['draft', 'calculated'];

/** Resolve employee salary items effective for a given month-end. */
async function getEffectiveSalary(tenantId, employeeId, onDate) {
  const [rows] = await pool.query(
    `SELECT * FROM employee_salaries
     WHERE tenant_id = ? AND employee_id = ? AND effective_from <= ?
       AND (effective_to IS NULL OR effective_to >= ?)
     ORDER BY effective_from DESC LIMIT 1`,
    [tenantId, employeeId, onDate, onDate]
  );
  return rows[0] || null;
}

async function loanEmisForMonth(tenantId, month, year) {
  const [rows] = await pool.query(
    `SELECT li.*, l.employee_id, l.id AS loan_id, l.emi_amount FROM loan_installments li
     JOIN loans l ON l.id = li.loan_id
     WHERE li.tenant_id = ? AND li.due_month = ? AND li.due_year = ? AND li.status = 'pending'
       AND l.status = 'active'`,
    [tenantId, month, year]
  );
  return rows;
}

/** Core calculation pipeline: draft → calculated. Deterministic for the same versioned inputs. */
async function calculateRun(tenantId, runId, actor) {
  const [runs] = await pool.query('SELECT * FROM payroll_runs WHERE id = ? AND tenant_id = ?', [runId, tenantId]);
  const run = runs[0];
  if (!run) throw new HttpError(404, 'Payroll run not found');
  if (!CALC_STATUSES.includes(run.status)) {
    throw new HttpError(400, `Run is ${run.status}; recalculation only allowed in draft/calculated state`);
  }

  const { end: monthEnd, daysInMonth } = monthRange(run.period_year, run.period_month);
  const monthStart = `${run.period_year}-${String(run.period_month).padStart(2, '0')}-01`;
  const monthDays = run.month_days || daysInMonth;

  const [employees] = await pool.query(
    `SELECT e.*, d.name AS dept_name, des.name AS desig_name, l.name AS loc_name, l.state AS loc_state
     FROM employees e
     LEFT JOIN departments d ON d.id = e.department_id
     LEFT JOIN designations des ON des.id = e.designation_id
     LEFT JOIN locations l ON l.id = e.location_id
     WHERE e.tenant_id = ? AND e.deleted_at IS NULL
       AND e.status IN ('active','on_probation','on_notice')
       AND e.joined_on IS NOT NULL AND e.joined_on <= ?
       AND (e.exit_date IS NULL OR e.exit_date >= ?)`,
    [tenantId, monthEnd, monthStart]
  );

  const loans = await loanEmisForMonth(tenantId, run.period_month, run.period_year);
  const loansByEmp = {};
  for (const li of loans) (loansByEmp[li.employee_id] ||= []).push(li);

  // Approved claims that have not been paid out by any run yet. Deliberately NOT scoped to the
  // run's period: a claim is frequently approved after the month it was spent in, and tying the
  // lookup to expense_date would strand it forever.
  const [expRows] = await pool.query(
    `SELECT ec.id, ec.employee_id, ec.amount, ec.title FROM expense_claims ec
     WHERE ec.tenant_id = ? AND ec.status = 'approved' AND ec.reimbursed_run_id IS NULL
     ORDER BY ec.id`,
    [tenantId]
  );
  const expByEmp = {};
  for (const e of expRows) (expByEmp[e.employee_id] ||= []).push(e);

  // Approved adjustments that have not been consumed by a run yet. These are how locked or
  // paid periods are corrected (arrears, back-pay, corrections) and how bonus awards and
  // F&F settlements reach the payslip, without ever mutating a closed run.
  const [adjRows] = await pool.query(
    `SELECT id, employee_id, atype, direction, component, description, amount,
            for_period_year, for_period_month, original_run_id
     FROM payroll_adjustments
     WHERE tenant_id = ? AND status = 'approved' AND applied_run_id IS NULL
     ORDER BY id`,
    [tenantId]
  );
  const adjByEmp = {};
  for (const a of adjRows) (adjByEmp[a.employee_id] ||= []).push(a);

  const exceptions = [];
  const items = [];
  const consumedAdjustmentIds = new Set();

  for (const emp of employees) {
    const salary = await getEffectiveSalary(tenantId, emp.id, monthEnd);
    if (!salary) {
      exceptions.push({ employeeId: emp.id, employeeCode: emp.employee_code, name: `${emp.first_name} ${emp.last_name}`, code: 'NO_SALARY', severity: 'error', message: 'No effective salary structure for this period' });
      continue;
    }
    const itemsArr = Array.isArray(salary.items) ? salary.items : JSON.parse(salary.items || '[]');

    const lopDays = await lopForMonth(tenantId, emp.id, run.period_year, run.period_month);
    const payableDays = Math.max(0, monthDays - lopDays);

    // overtime minutes in month
    const [otRows] = await pool.query(
      `SELECT COALESCE(SUM(overtime_minutes),0) AS m FROM attendance_records
       WHERE tenant_id = ? AND employee_id = ? AND adate BETWEEN ? AND ?`,
      [tenantId, emp.id, monthStart, monthEnd]
    );
    const otMinutes = Number(otRows[0].m || 0);

    const vars = {
      MONTH_DAYS: monthDays,
      PAYABLE_DAYS: payableDays,
      LOP_DAYS: lopDays,
      OT_MINUTES: otMinutes,
      OT_HOURS: round2(otMinutes / 60),
      CTC_MONTHLY: round2(Number(salary.ctc_annual || 0) / 12),
    };

    // Pass 1: fixed & attendance-based components
    const amounts = {}; // code -> {amount, item}
    const ctypeOf = (it) => it.ctype || it.type;
    for (const it of itemsArr) {
      if (it.calcType === 'formula') continue;
      let amt = Number(it.amount || 0);
      if (it.prorated !== false && it.calcType === 'attendance_based') amt = round2((amt * payableDays) / monthDays);
      else if (it.prorated !== false && it.calcType === 'fixed' && it.prorated) amt = round2((amt * payableDays) / monthDays);
      amounts[it.code] = { amount: amt, item: { ...it, ctype: ctypeOf(it) } };
    }
    // Pass 2: formulas (defer unknown vars)
    const pending = itemsArr.filter((it) => it.calcType === 'formula');
    let guard = 0;
    while (pending.length && guard++ < 20) {
      const still = [];
      for (const it of pending) {
        const localVars = { ...vars };
        for (const [code, a] of Object.entries(amounts)) localVars[code.toUpperCase()] = a.amount;
        try {
          const val = round2(evalFormula(it.formula, localVars));
          amounts[it.code] = { amount: val, item: it };
        } catch (e) {
          if (e.message.includes('Unknown variable')) still.push(it);
          else { exceptions.push({ employeeId: emp.id, employeeCode: emp.employee_code, name: `${emp.first_name} ${emp.last_name}`, code: 'FORMULA_ERROR', severity: 'error', message: `${it.code}: ${e.message}` }); amounts[it.code] = { amount: 0, item: it }; }
        }
      }
      if (still.length === pending.length) {
        exceptions.push({ employeeId: emp.id, employeeCode: emp.employee_code, name: `${emp.first_name} ${emp.last_name}`, code: 'FORMULA_CYCLE', severity: 'error', message: 'Unresolvable formula references' });
        for (const it of still) amounts[it.code] = { amount: 0, item: it };
        break;
      }
      pending.splice(0, pending.length, ...still);
    }

    const earnings = [];
    let gross = 0;
    let basic = 0;
    for (const [code, a] of Object.entries(amounts)) {
      if (a.item.ctype !== 'earning') continue;
      earnings.push({ code, name: a.item.name, amount: a.amount, taxable: !!a.item.taxable });
      if (a.item.part_of_gross !== false) gross += a.amount;
      if (code.toUpperCase() === 'BASIC' || code.toUpperCase() === 'BASIC_DA') basic += a.amount;
    }
    gross = round2(gross);

    const taxableGross = earnings.filter((e) => e.taxable).reduce((s, e) => s + e.amount, 0);

    // tax declarations for old regime
    let declarations = 0;
    if (emp.tax_regime === 'old') {
      const fyStartYear = run.period_month >= 4 ? run.period_year : run.period_year - 1;
      const fy = `${fyStartYear}-${String((fyStartYear + 1) % 100).padStart(2, '0')}`;
      const [td] = await pool.query(
        'SELECT sections FROM tax_declarations WHERE tenant_id = ? AND employee_id = ? AND financial_year = ? AND status = "approved"',
        [tenantId, emp.id, fy]
      );
      if (td[0]) {
        const sec = typeof td[0].sections === 'string' ? JSON.parse(td[0].sections) : td[0].sections;
        declarations = Object.values(sec || {}).reduce((s, v) => s + (Number(v) || 0), 0);
      }
    }

    const statutory = await computeStatutory({
      tenantId,
      onDate: monthEnd,
      jurisdiction: emp.loc_state || 'IN',
      gross: taxableGross > 0 ? gross : 0,
      basic,
      taxRegime: emp.tax_regime || 'new',
      annualDeclarations: declarations,
      pfWage: basic,
    });

    const statutoryEmp = [
      { code: 'PF', name: 'Provident Fund (Employee)', amount: statutory.pfEmployee },
      { code: 'ESI', name: 'ESI (Employee)', amount: statutory.esiEmployee },
      { code: 'PT', name: 'Professional Tax', amount: statutory.pt },
      { code: 'TDS', name: 'TDS on Salary', amount: statutory.tds },
      { code: 'LWF', name: 'Labour Welfare Fund', amount: statutory.lwfEmployee },
    ].filter((x) => x.amount > 0);

    const statutoryEr = [
      { code: 'PF_ER', name: 'Provident Fund (Employer)', amount: statutory.pfEmployer },
      { code: 'ESI_ER', name: 'ESI (Employer)', amount: statutory.esiEmployer },
      { code: 'LWF_ER', name: 'Labour Welfare Fund (Employer)', amount: statutory.lwfEmployer },
    ].filter((x) => x.amount > 0);

    // other configured deductions (fixed components)
    const otherDeductions = [];
    for (const [code, a] of Object.entries(amounts)) {
      if (a.item.ctype === 'deduction') otherDeductions.push({ code, name: a.item.name, amount: a.amount });
    }

    // loan EMIs
    const loanDeductions = [];
    for (const li of loansByEmp[emp.id] || []) {
      loanDeductions.push({ code: `LOAN_${li.loan_id}_${li.installment_no}`, name: `Loan EMI #${li.installment_no}`, amount: round2(li.amount), loanInstallmentId: li.id });
    }

    // approved reimbursements not yet paid
    const reimbursements = (expByEmp[emp.id] || []).map((e) => ({ code: `EXP_${e.id}`, name: `Reimbursement: ${e.title}`, amount: round2(e.amount), expenseClaimId: e.id }));
    const totalReimb = round2(reimbursements.reduce((s, r) => s + r.amount, 0));

    // Approved adjustments (arrears / back-pay / corrections / bonus / F&F).
    // Applied after statutory so the versioned rules stay deterministic for the base salary
    // components; PF/ESI corrections arising from arrears are handled out-of-band.
    const adjEarnings = [];
    const adjDeductions = [];
    for (const a of adjByEmp[emp.id] || []) {
      const line = {
        code: a.component,
        name: a.description || a.component,
        amount: round2(a.amount),
        direction: a.direction,
        adjustmentId: a.id,
        atype: a.atype,
        forPeriod: a.for_period_month ? `${a.for_period_month}/${a.for_period_year}` : null,
      };
      if (a.direction === 'deduction') adjDeductions.push(line);
      else adjEarnings.push(line);
      consumedAdjustmentIds.add(a.id);
    }
    const totalAdjEarn = round2(adjEarnings.reduce((s, a) => s + a.amount, 0));
    const totalAdjDed = round2(adjDeductions.reduce((s, a) => s + a.amount, 0));
    const adjustmentsTotal = round2(totalAdjEarn - totalAdjDed);
    const adjustments = [...adjEarnings, ...adjDeductions];

    const deductions = [...statutoryEmp, ...otherDeductions, ...loanDeductions];
    const totalDeductions = round2(deductions.reduce((s, d) => s + d.amount, 0));
    const employerContrib = statutoryEr;
    const employerCost = round2(gross + employerContrib.reduce((s, d) => s + d.amount, 0));
    const netPay = round2(gross - totalDeductions + totalReimb + adjustmentsTotal);

    if (netPay < 0) exceptions.push({ employeeId: emp.id, employeeCode: emp.employee_code, name: `${emp.first_name} ${emp.last_name}`, code: 'NEGATIVE_NET', severity: 'error', message: `Net pay is negative (${netPay})` });
    if (lopDays > monthDays) exceptions.push({ employeeId: emp.id, employeeCode: emp.employee_code, name: `${emp.first_name} ${emp.last_name}`, code: 'LOP_EXCEEDS', severity: 'error', message: 'Loss of pay exceeds month days' });
    if (!emp.bank_account_enc && !emp.bank_name) exceptions.push({ employeeId: emp.id, employeeCode: emp.employee_code, name: `${emp.first_name} ${emp.last_name}`, code: 'NO_BANK', severity: 'warning', message: 'Bank details missing' });
    if (!emp.pan_plain && !emp.pan_enc) exceptions.push({ employeeId: emp.id, employeeCode: emp.employee_code, name: `${emp.first_name} ${emp.last_name}`, code: 'NO_PAN', severity: 'warning', message: 'PAN missing — TDS at higher rate may apply' });

    items.push({
      employeeId: emp.id,
      monthDays,
      payableDays,
      lopDays,
      earnings,
      deductions,
      employerContrib,
      reimbursements,
      adjustments,
      totalReimb,
      adjustmentsTotal,
      gross,
      totalDeductions,
      netPay,
      employerCost,
      inputsSnapshot: {
        otMinutes, monthStart, monthEnd, statutoryBreakdown: statutory.breakdown,
        // Full statutory values (incl. EPS, which is not a payslip line) so statutory
        // returns can be rebuilt from the stored snapshot without re-running the engine.
        statutoryValues: {
          pfEmployee: statutory.pfEmployee, pfEmployer: statutory.pfEmployer, pfEps: statutory.pfEps,
          esiEmployee: statutory.esiEmployee, esiEmployer: statutory.esiEmployer,
          pt: statutory.pt, tds: statutory.tds,
          lwfEmployee: statutory.lwfEmployee, lwfEmployer: statutory.lwfEmployer,
        },
        salaryId: salary.id, salaryItems: itemsArr.map((i) => ({ code: i.code, amount: i.amount, formula: i.formula, calcType: i.calcType })),
        declarations,
        adjustmentIds: adjustments.map((a) => a.adjustmentId),
        reimbursementClaimIds: reimbursements.map((r) => r.expenseClaimId),
      },
      statutory,
    });
  }

  // Any approved adjustment for an employee who was not in this run's population can never be
  // applied automatically — surface it instead of silently stranding the money.
  for (const a of adjRows) {
    if (consumedAdjustmentIds.has(a.id)) continue;
    const [e] = await pool.query('SELECT employee_code, first_name, last_name, status FROM employees WHERE id = ?', [a.employee_id]);
    exceptions.push({
      employeeId: a.employee_id,
      employeeCode: e[0]?.employee_code || null,
      name: e[0] ? `${e[0].first_name} ${e[0].last_name}` : 'Unknown employee',
      code: 'ADJUSTMENT_UNAPPLIED',
      severity: 'warning',
      message: `Adjustment #${a.id} (${a.atype} ₹${a.amount}) not applied — employee is ${e[0]?.status || 'not in scope'} for this period`,
    });
  }

  await withTransaction(async (conn) => {
    await conn.query('DELETE FROM payroll_items WHERE run_id = ?', [runId]);
    for (const it of items) {
      await conn.query(
        `INSERT INTO payroll_items (tenant_id, run_id, employee_id, month_days, payable_days, lop_days,
          earnings, deductions, reimbursements, adjustments, employer_contrib,
          gross, total_deductions, reimbursements_total, adjustments_total, net_pay, employer_cost, inputs_snapshot)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [tenantId, runId, it.employeeId, it.monthDays, it.payableDays, it.lopDays,
          JSON.stringify(it.earnings), JSON.stringify(it.deductions),
          JSON.stringify(it.reimbursements), JSON.stringify(it.adjustments), JSON.stringify(it.employerContrib),
          it.gross, it.totalDeductions, it.totalReimb, it.adjustmentsTotal, it.netPay, it.employerCost, JSON.stringify(it.inputsSnapshot)]
      );
    }
    const totals = {
      headcount: items.length,
      gross: round2(items.reduce((s, i) => s + i.gross, 0)),
      net: round2(items.reduce((s, i) => s + i.netPay, 0)),
      totalDeductions: round2(items.reduce((s, i) => s + i.totalDeductions, 0)),
      reimbursements: round2(items.reduce((s, i) => s + i.totalReimb, 0)),
      adjustments: round2(items.reduce((s, i) => s + i.adjustmentsTotal, 0)),
      employerCost: round2(items.reduce((s, i) => s + i.employerCost, 0)),
    };
    await conn.query(
      'UPDATE payroll_runs SET status = ?, totals = ?, exceptions = ?, calculated_by = ?, calculated_at = NOW() WHERE id = ?',
      ['calculated', JSON.stringify(totals), JSON.stringify(exceptions), actor?.id || null, runId]
    );
  });

  await logAudit({ tenantId, actor, action: 'payroll.calculate', entityType: 'payroll_run', entityId: runId, after: { period: `${run.period_month}/${run.period_year}`, employees: items.length }, req: null });
  return { itemsCalculated: items.length, exceptions };
}

/** Maker-checker transition endpoints share this guard. */
async function transitionRun(tenantId, runId, action, actor) {
  const [runs] = await pool.query('SELECT * FROM payroll_runs WHERE id = ? AND tenant_id = ?', [runId, tenantId]);
  const run = runs[0];
  if (!run) throw new HttpError(404, 'Payroll run not found');

  const [empRows] = await pool.query(
    `SELECT pi.*, e.first_name, e.last_name, e.employee_code, e.email FROM payroll_items pi
     JOIN employees e ON e.id = pi.employee_id WHERE pi.run_id = ?`,
    [runId]
  );

  switch (action) {
    case 'submit': {
      if (run.status !== 'calculated') throw new HttpError(400, `Cannot submit from status '${run.status}'`);
      const errors = (Array.isArray(run.exceptions) ? run.exceptions : JSON.parse(run.exceptions || '[]')).filter((x) => x.severity === 'error');
      if (errors.length) throw new HttpError(400, 'Resolve error-level exceptions before submitting', errors);
      await pool.query('UPDATE payroll_runs SET status = ?, submitted_by = ?, submitted_at = NOW() WHERE id = ?', ['submitted', actor.id, runId]);
      break;
    }
    case 'approve': {
      if (run.status !== 'submitted') throw new HttpError(400, 'Only submitted runs can be approved');
      if (run.submitted_by === actor.id) throw new HttpError(403, 'Maker-checker: the submitting user cannot approve the same run');
      await pool.query('UPDATE payroll_runs SET status = ?, approved_by = ?, approved_at = NOW() WHERE id = ?', ['approved', actor.id, runId]);
      // generate + publish payslips
      const period = `${dayjs().month(run.period_month - 1).format('MMMM')} ${run.period_year}`;
      for (const item of empRows) {
        const [ps] = await pool.query(
          'INSERT IGNORE INTO payslips (tenant_id, run_id, payroll_item_id, employee_id, pdf_path, published_at) VALUES (?,?,?,?,?,NOW())',
          [tenantId, runId, item.id, item.employee_id, null]
        );
        if (ps.affectedRows) {
          const [slipRow] = await pool.query('SELECT id FROM payslips WHERE payroll_item_id = ?', [item.id]);
          try {
            const pdfPath = await generatePayslipPdf({ tenantId, item, run, payslipId: slipRow[0]?.id });
            await pool.query('UPDATE payslips SET pdf_path = ? WHERE id = ?', [pdfPath, slipRow[0]?.id]);
          } catch (e) {
            console.error('[payslip pdf]', e.message);
          }
        }
      }
      // Settle loan EMIs, reimburse approved expense claims, and consume approved adjustments.
      for (const item of empRows) {
        const deductions = Array.isArray(item.deductions) ? item.deductions : JSON.parse(item.deductions || '[]');
        for (const d of deductions) {
          if (d.loanInstallmentId) {
            await pool.query('UPDATE loan_installments SET status = "deducted", payroll_run_id = ?, paid_at = NOW() WHERE id = ?', [runId, d.loanInstallmentId]);
            await pool.query('UPDATE loans SET outstanding = GREATEST(0, outstanding - ?) WHERE id = ? AND id = (SELECT loan_id FROM loan_installments WHERE id = ?)', [d.amount, d.loanInstallmentId, d.loanInstallmentId]);
          }
        }
        // Reimbursements live in their own column; they are added to net pay but are not
        // deductions, so they must be settled separately or the claim would be paid twice.
        const reimbursements = Array.isArray(item.reimbursements) ? item.reimbursements : JSON.parse(item.reimbursements || '[]');
        for (const r of reimbursements) {
          if (!r.expenseClaimId) continue;
          await pool.query(
            `UPDATE expense_claims SET status = 'reimbursed', reimbursed_run_id = ?
             WHERE id = ? AND tenant_id = ? AND status = 'approved' AND reimbursed_run_id IS NULL`,
            [runId, r.expenseClaimId, tenantId]
          );
        }
        // Adjustments are settled exactly once.
        const adjustments = Array.isArray(item.adjustments) ? item.adjustments : JSON.parse(item.adjustments || '[]');
        for (const a of adjustments) {
          if (!a.adjustmentId) continue;
          await pool.query(
            `UPDATE payroll_adjustments SET status = 'applied', applied_run_id = ?, applied_at = NOW()
             WHERE id = ? AND tenant_id = ? AND status = 'approved' AND applied_run_id IS NULL`,
            [runId, a.adjustmentId, tenantId]
          );
        }
      }
      // notify employees
      const recipients = empRows.map((e) => ({ userId: null, employeeId: e.employee_id, email: e.email }));
      const [userRows] = await pool.query('SELECT id, employee_id FROM users WHERE tenant_id = ? AND employee_id IS NOT NULL', [tenantId]);
      const userByEmp = Object.fromEntries(userRows.map((u) => [u.employee_id, u.id]));
      const notifRecipients = recipients.filter((r) => userByEmp[r.employeeId]).map((r) => ({ userId: userByEmp[r.employeeId], email: r.email }));
      if (notifRecipients.length) {
        const sample = empRows[0];
        await notifyEvent({ tenantId, eventKey: 'payslip.published', vars: { period, netPay: sample?.net_pay }, recipients: notifRecipients, link: '/portal/payslips' });
      }
      break;
    }
    case 'lock': {
      if (run.status !== 'approved') throw new HttpError(400, 'Only approved runs can be locked');
      await pool.query('UPDATE payroll_runs SET status = ?, locked_by = ?, locked_at = NOW() WHERE id = ?', ['locked', actor.id, runId]);
      break;
    }
    case 'pay': {
      if (run.status !== 'locked') throw new HttpError(400, 'Only locked runs can be marked paid');
      await pool.query('UPDATE payroll_runs SET status = ?, paid_at = NOW() WHERE id = ?', ['paid', runId]);
      break;
    }
    case 'cancel': {
      if (!['draft', 'calculated', 'submitted'].includes(run.status)) throw new HttpError(400, 'Only pre-approval runs can be cancelled');
      await pool.query('UPDATE payroll_runs SET status = ? WHERE id = ?', ['cancelled', runId]);
      break;
    }
    default:
      throw new HttpError(400, 'Unknown action');
  }

  await logAudit({ tenantId, actor, action: `payroll.${action}`, entityType: 'payroll_run', entityId: runId, before: { status: run.status }, after: { action } });
  return { ok: true, status: action === 'cancel' ? 'cancelled' : action };
}

/** Bank payment file (CSV) for a locked/approved run. */
async function bankFile(tenantId, runId) {
  const [rows] = await pool.query(
    `SELECT e.employee_code, e.first_name, e.last_name, e.ifsc, pi.net_pay
     FROM payroll_items pi JOIN employees e ON e.id = pi.employee_id
     WHERE pi.run_id = ? AND pi.tenant_id = ? ORDER BY e.employee_code`,
    [runId, tenantId]
  );
  return rows.map((r) => ({
    employeeCode: r.employee_code,
    name: `${r.first_name} ${r.last_name}`,
    ifsc: r.ifsc || '',
    account: '', // decrypted server-side on export route when sensitive perms held
    amount: r.net_pay,
  }));
}

/**
 * Create a payroll adjustment. Used by the integrations (bonus awards, F&F settlements) and by
 * the manual arrears/back-pay screen. `sourceType` + `sourceId` make the insert idempotent, so
 * re-approving a bonus award will not double-book it.
 */
async function createAdjustment(tenantId, actor, {
  employeeId, atype = 'other', direction = 'earning', component, description,
  amount, forPeriodYear = null, forPeriodMonth = null, originalRunId = null,
  sourceType = 'manual', sourceId = null, reason = null, submit = true, autoApprove = false,
}) {
  const amt = round2(amount);
  if (!employeeId) throw new HttpError(400, 'employeeId required');
  if (!component) throw new HttpError(400, 'component required');
  if (!(amt > 0)) throw new HttpError(400, 'amount must be greater than 0');
  if (!['earning', 'deduction'].includes(direction)) throw new HttpError(400, 'direction must be earning or deduction');
  // autoApprove is for trusted system integrations (bonus approval, F&F) where the approving
  // workflow already happened upstream — it is never reachable from the manual adjustments API.
  if (autoApprove && (!sourceType || sourceType === 'manual')) {
    throw new HttpError(400, 'autoApprove requires a named sourceType (bonus, fnf, ...)');
  }

  const [emp] = await pool.query('SELECT id FROM employees WHERE id = ? AND tenant_id = ?', [employeeId, tenantId]);
  if (!emp[0]) throw new HttpError(404, 'Employee not found');

  const status = autoApprove ? 'approved' : submit ? 'submitted' : 'draft';

  // Idempotency: a named source (bonus/F&F) must never double-book, so resolve the existing
  // row explicitly instead of relying on driver-specific ON DUPLICATE KEY affectedRows.
  if (sourceType !== 'manual' && sourceId) {
    const [existing] = await pool.query(
      'SELECT id, status, applied_run_id FROM payroll_adjustments WHERE tenant_id = ? AND source_type = ? AND source_id = ?',
      [tenantId, sourceType, sourceId]
    );
    if (existing[0]) {
      return { id: existing[0].id, status: existing[0].status, appliedRunId: existing[0].applied_run_id, reused: true };
    }
  }

  const [ins] = await pool.query(
    `INSERT INTO payroll_adjustments
       (tenant_id, employee_id, atype, direction, component, description, amount,
        for_period_year, for_period_month, original_run_id, source_type, source_id, status, reason, requested_by, requested_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NOW())`,
    [tenantId, employeeId, atype, direction, String(component).slice(0, 60), description || null, amt,
      forPeriodYear, forPeriodMonth, originalRunId, sourceType, sourceId,
      status, reason || null, actor?.id || null]
  );
  if (autoApprove) {
    await pool.query('UPDATE payroll_adjustments SET actioned_by = ?, actioned_at = NOW() WHERE id = ?', [actor?.id || null, ins.insertId]);
  }

  if (submit || autoApprove) {
    await logAudit({
      tenantId, actor, action: `payroll.adjustment_${autoApprove ? 'auto_approve' : 'request'}`,
      entityType: 'payroll_adjustment', entityId: ins.insertId,
      after: { employeeId, atype, direction, amount: amt, component, sourceType, sourceId, status }, req: null,
    });
  }
  return { id: ins.insertId, status, appliedRunId: null, reused: false };
}

module.exports = { calculateRun, transitionRun, bankFile, getEffectiveSalary, createAdjustment };
