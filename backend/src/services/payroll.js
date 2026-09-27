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

  const [expRows] = await pool.query(
    `SELECT ec.id, ec.employee_id, ec.amount, ec.title FROM expense_claims ec
     WHERE ec.tenant_id = ? AND ec.status = 'approved' AND ec.reimbursed_run_id IS NULL
       AND YEAR(ec.expense_date) = ? AND MONTH(ec.expense_date) = ?`,
    [tenantId, run.period_year, run.period_month]
  );
  const expByEmp = {};
  for (const e of expRows) (expByEmp[e.employee_id] ||= []).push(e);

  const exceptions = [];
  const items = [];

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

    const deductions = [...statutoryEmp, ...otherDeductions, ...loanDeductions];
    const totalDeductions = round2(deductions.reduce((s, d) => s + d.amount, 0));
    const employerContrib = statutoryEr;
    const employerCost = round2(gross + employerContrib.reduce((s, d) => s + d.amount, 0));
    const netPay = round2(gross - totalDeductions + totalReimb);

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
      gross,
      totalDeductions,
      netPay,
      employerCost,
      inputsSnapshot: {
        otMinutes, monthStart, monthEnd, statutoryBreakdown: statutory.breakdown,
        salaryId: salary.id, salaryItems: itemsArr.map((i) => ({ code: i.code, amount: i.amount, formula: i.formula, calcType: i.calcType })),
        declarations,
      },
      statutory,
    });
  }

  await withTransaction(async (conn) => {
    await conn.query('DELETE FROM payroll_items WHERE run_id = ?', [runId]);
    for (const it of items) {
      await conn.query(
        `INSERT INTO payroll_items (tenant_id, run_id, employee_id, month_days, payable_days, lop_days,
          earnings, deductions, employer_contrib, gross, total_deductions, net_pay, employer_cost, inputs_snapshot)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [tenantId, runId, it.employeeId, it.monthDays, it.payableDays, it.lopDays,
          JSON.stringify(it.earnings), JSON.stringify(it.deductions), JSON.stringify(it.employerContrib),
          it.gross, it.totalDeductions, it.netPay, it.employerCost, JSON.stringify(it.inputsSnapshot)]
      );
    }
    const totals = {
      headcount: items.length,
      gross: round2(items.reduce((s, i) => s + i.gross, 0)),
      net: round2(items.reduce((s, i) => s + i.netPay, 0)),
      totalDeductions: round2(items.reduce((s, i) => s + i.totalDeductions, 0)),
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
      // mark loan EMIs deducted and expense claims reimbursed
      for (const item of empRows) {
        const deductions = Array.isArray(item.deductions) ? item.deductions : JSON.parse(item.deductions || '[]');
        for (const d of deductions) {
          if (d.loanInstallmentId) {
            await pool.query('UPDATE loan_installments SET status = "deducted", payroll_run_id = ?, paid_at = NOW() WHERE id = ?', [runId, d.loanInstallmentId]);
            await pool.query('UPDATE loans SET outstanding = GREATEST(0, outstanding - ?) WHERE id = ? AND id = (SELECT loan_id FROM loan_installments WHERE id = ?)', [d.amount, d.loanInstallmentId, d.loanInstallmentId]);
          }
          if (d.expenseClaimId) {
            await pool.query('UPDATE expense_claims SET status = "reimbursed", reimbursed_run_id = ? WHERE id = ?', [runId, d.expenseClaimId]);
          }
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

module.exports = { calculateRun, transitionRun, bankFile, getEffectiveSalary };
