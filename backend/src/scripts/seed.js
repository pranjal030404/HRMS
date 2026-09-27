/**
 * Demo seed: 1 tenant ("Arthvex Technologies Pvt Ltd"), system roles, statutory rules,
 * salary components/structure, shifts, leave types, holidays, ~16 employees incl.
 * a manager hierarchy, attendance punches, leave requests, expenses, loans, goals,
 * requisitions, candidates, assets, tickets, announcements, customers + an invoice,
 * and a calculated payroll run for last month.
 *
 * Login (all with password "Password@123"):
 *   super@arthvex.com        (Platform Super Admin)
 *   owner@arthvex.com        (Company Owner)
 *   hr@arthvex.com           (HR Admin)
 *   payroll@arthvex.com      (Payroll Admin)
 *   finance@arthvex.com      (Finance/Admin)
 *   manager@arthvex.com      (Manager — also an employee)
 *   depthead@arthvex.com     (Department Head — heads the Sales department)
 *   recruiter@arthvex.com    (Recruiter)
 *   employee@arthvex.com     (Employee)
 *   auditor@arthvex.com      (Auditor)
 */
const bcrypt = require('bcryptjs');
const dayjs = require('dayjs');
const { pool } = require('../config/db');
const { encrypt } = require('../utils/crypto');
const { ROLE_DEFS, DEFAULT_ROLES } = require('../utils/permissions');

const PASSWORD = 'Password@123';
const YEAR = dayjs().year();

const FIRST = ['Aarav', 'Diya', 'Kabir', 'Ananya', 'Rohan', 'Ishita', 'Vivaan', 'Meera', 'Arjun', 'Saanvi', 'Aditya', 'Priya', 'Nikhil', 'Kavya'];
const LAST = ['Sharma', 'Iyer', 'Patel', 'Reddy', 'Nair', 'Gupta', 'Menon', 'Joshi', 'Kulkarni', 'Das', 'Verma', 'Rao', 'Mehta', 'Pillai'];

async function main() {
  console.log('[seed] starting…');
  const hash = await bcrypt.hash(PASSWORD, 10);

  await pool.query('SET FOREIGN_KEY_CHECKS = 0');
  const TABLES = ['tenants', 'roles', 'users', 'companies', 'locations', 'departments', 'designations', 'grades', 'cost_centers', 'shifts', 'holidays',
    'employees', 'employee_timeline', 'employee_salaries', 'attendance_records', 'attendance_regularizations', 'leave_types', 'leave_balances', 'leave_requests',
    'salary_components', 'salary_structures', 'salary_structure_items', 'payroll_runs', 'payroll_items', 'payslips', 'statutory_rules', 'tax_declarations',
    'expense_categories', 'expense_claims', 'loans', 'loan_installments', 'performance_cycles', 'goals', 'reviews', 'requisitions', 'candidates', 'interviews', 'offers',
    'assets', 'asset_assignments', 'tickets', 'ticket_comments', 'announcements', 'onboarding_tasks', 'separations', 'fnf_items', 'clearances',
    'customers', 'invoices', 'invoice_items', 'invoice_payments', 'notifications', 'settings', 'audit_logs', 'company_documents', 'letter_templates'];
  for (const t of TABLES) await pool.query(`DELETE FROM ${t}`);
  await pool.query('SET FOREIGN_KEY_CHECKS = 1');

  // ---------- Tenant ----------
  const [tenant] = await pool.query(
    `INSERT INTO tenants (name, slug, plan, branding, feature_flags) VALUES (?,?,?,?,?)`,
    ['Arthvex Technologies Pvt Ltd', 'arthvex', 'enterprise',
      JSON.stringify({ companyName: 'Arthvex Technologies', primaryColor: '#1d4ed8', loginTagline: 'People first. Always.', supportEmail: 'hr@arthvex.com' }),
      JSON.stringify({ recruitment: true, performance: true, billing: true, assets: true, helpdesk: true })]
  );
  const T = tenant.insertId;

  // ---------- Roles ----------
  for (const key of DEFAULT_ROLES) {
    await pool.query('INSERT INTO roles (tenant_id, name, label, permissions, is_system) VALUES (?,?,?,?,1)', [T, key, ROLE_DEFS[key].label, JSON.stringify(ROLE_DEFS[key].permissions)]);
  }

  // ---------- Platform super admin ----------
  await pool.query(`INSERT INTO users (tenant_id, email, password_hash, name, role, status) VALUES (NULL, 'super@arthvex.com', ?, 'Platform Admin', 'platform_super_admin', 'active')`, [hash]);

  // ---------- Company ----------
  await pool.query(
    `INSERT INTO companies (tenant_id, legal_name, trade_name, cin, pan, tan, gstin, address_line1, city, state, state_code, pincode, contact_email, contact_phone)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [T, 'Arthvex Technologies Private Limited', 'Arthvex', 'U72900KA2020PTC000000', 'AABCA1234F', 'BLEA00000A', '29ABCDE1234F1Z5',
      '4th Floor, Tech Park One, Outer Ring Road', 'Bengaluru', 'Karnataka', 'KA', '560103', 'hr@arthvex.com', '+91 80 4000 0000']
  );

  // ---------- Org ----------
  const [locBlr] = await pool.query(`INSERT INTO locations (tenant_id, name, code, city, state, address) VALUES (?,?,?,?,?,?)`, [T, 'Bengaluru HQ', 'BLR', 'Bengaluru', 'Karnataka', 'Tech Park One']);
  const [locPune] = await pool.query(`INSERT INTO locations (tenant_id, name, code, city, state, address) VALUES (?,?,?,?,?,?)`, [T, 'Pune Office', 'PNQ', 'Pune', 'Maharashtra', 'Baner Road']);
  const locIds = [locBlr.insertId, locPune.insertId];

  const deptNames = ['Engineering', 'Product', 'Human Resources', 'Finance', 'Sales', 'Operations'];
  const deptIds = {};
  for (const d of deptNames) {
    const [ins] = await pool.query(`INSERT INTO departments (tenant_id, name, code) VALUES (?,?,?)`, [T, d, d.slice(0, 3).toUpperCase()]);
    deptIds[d] = ins.insertId;
  }
  const gradeNames = [['L1', 1], ['L2', 2], ['L3', 3], ['L4', 4], ['L5', 5]];
  const gradeIds = {};
  for (const [g, lvl] of gradeNames) {
    const [ins] = await pool.query(`INSERT INTO grades (tenant_id, name, level) VALUES (?,?,?)`, [T, g, lvl]);
    gradeIds[g] = ins.insertId;
  }
  const desigNames = ['Software Engineer', 'Senior Software Engineer', 'Engineering Manager', 'Product Manager', 'HR Manager', 'HR Executive', 'Finance Manager', 'Accountant', 'Sales Executive', 'Operations Lead', 'QA Engineer', 'DevOps Engineer', 'Recruiter', 'Sales Head'];
  const desigIds = {};
  for (const d of desigNames) {
    const [ins] = await pool.query(`INSERT INTO designations (tenant_id, name, code) VALUES (?,?,?)`, [T, d, d.split(' ').map((w) => w[0]).join('').toUpperCase()]);
    desigIds[d] = ins.insertId;
  }
  const [cc] = await pool.query(`INSERT INTO cost_centers (tenant_id, name, code) VALUES (?,?,?)`, [T, 'Core Product', 'CC-CORE']);

  // ---------- Shifts & holidays ----------
  const [shiftGen] = await pool.query(
    `INSERT INTO shifts (tenant_id, name, code, start_time, end_time, grace_minutes, full_day_hours, half_day_hours, break_minutes, weekly_offs, overtime_enabled)
     VALUES (?,?,?,?,?,?,?,?,?,?,1)`,
    [T, 'General Shift', 'GEN', '09:30:00', '18:30:00', 10, 8, 4, 45, JSON.stringify(['Sun'])]
  );
  const [shiftEarly] = await pool.query(
    `INSERT INTO shifts (tenant_id, name, code, start_time, end_time, grace_minutes, full_day_hours, half_day_hours, break_minutes, weekly_offs)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [T, 'Early Shift', 'EARLY', '08:00:00', '17:00:00', 10, 8, 4, 45, JSON.stringify(['Sun'])]
  );

  const holidays = [
    ['2026-01-26', 'Republic Day'], ['2026-03-04', 'Holi'], ['2026-04-01', 'Annual Day'],
    ['2026-05-01', 'Labour Day'], ['2026-08-15', 'Independence Day'], ['2026-10-02', 'Gandhi Jayanti'],
    ['2026-11-08', 'Diwali'], ['2026-11-09', 'Diwali Break'], ['2026-12-25', 'Christmas'],
  ];
  for (const [d, n] of holidays) await pool.query(`INSERT INTO holidays (tenant_id, location_id, hdate, name) VALUES (?,?,?,?)`, [T, null, d, n]);

  // ---------- Salary components ----------
  const comps = [
    ['Basic', 'BASIC', 'earning', 'fixed', null, 1, 1, 1, 10],
    ['House Rent Allowance', 'HRA', 'earning', 'formula', 'BASIC * 0.40', 1, 1, 1, 20],
    ['Conveyance Allowance', 'CONV', 'earning', 'fixed', null, 1, 1, 1, 30],
    ['Special Allowance', 'SPECIAL', 'earning', 'formula', 'GROSS_BASE - BASIC - HRA - CONV', 1, 1, 1, 40],
    ['Overtime Pay', 'OT', 'earning', 'formula', 'OT_MINUTES * BASIC / (MONTH_DAYS * 8 * 60)', 1, 0, 0, 50],
    ['Provident Fund (Employee)', 'PF', 'deduction', 'statutory', null, 0, 0, 0, 100],
    ['ESI (Employee)', 'ESI', 'deduction', 'statutory', null, 0, 0, 0, 110],
    ['Professional Tax', 'PT', 'deduction', 'statutory', null, 0, 0, 0, 120],
    ['TDS on Salary', 'TDS', 'deduction', 'statutory', null, 0, 0, 0, 130],
    ['Provident Fund (Employer)', 'PF_ER', 'employer_contribution', 'statutory', null, 0, 0, 0, 200],
    ['ESI (Employer)', 'ESI_ER', 'employer_contribution', 'statutory', null, 0, 0, 0, 210],
  ];
  for (const [name, code, ctype, calc, formula, taxable, prorated, pog, order] of comps) {
    await pool.query(
      `INSERT INTO salary_components (tenant_id, name, code, ctype, calc_type, formula, taxable, prorated, part_of_gross, display_order)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [T, name, code, ctype, calc, formula, taxable, prorated, pog, order]
    );
  }

  // ---------- Salary structure ----------
  const [structure] = await pool.query(`INSERT INTO salary_structures (tenant_id, name, description) VALUES (?,?,?)`, [T, 'Standard Structure 2026', 'Basic + HRA + Conveyance + Special']);
  const compRows = (await pool.query(`SELECT id, code FROM salary_components WHERE tenant_id = ?`, [T]))[0];
  const compByCode = Object.fromEntries(compRows.map((c) => [c.code, c.id]));
  for (const [code, formula] of [['BASIC', null], ['HRA', 'BASIC * 0.40'], ['CONV', null], ['SPECIAL', 'GROSS_BASE - BASIC - HRA - CONV'], ['PF', null], ['PF_ER', null]]) {
    await pool.query(`INSERT INTO salary_structure_items (structure_id, component_id, amount, formula) VALUES (?,?,?,?)`, [structure.insertId, compByCode[code], null, formula]);
  }

  // ---------- Statutory rules (versioned, effective-dated) ----------
  const statutory = [
    ['PF', 'IN', '2026-04-01', 'PF-2026A', { employeeRate: 12, employerRate: 12, epsRate: 8.33, wageCeiling: 15000, capAtCeiling: true }],
    ['ESI', 'IN', '2026-04-01', 'ESI-2026A', { employeeRate: 0.75, employerRate: 3.25, grossCeiling: 21000 }],
    ['PT', 'KA', '2026-04-01', 'PT-KA-2026', { slabs: [{ upto: 24999, tax: 0 }, { above: true, tax: 200 }] }],
    ['PT', 'MH', '2026-04-01', 'PT-MH-2026', { slabs: [{ upto: 7500, tax: 0 }, { upto: 10000, tax: 175 }, { above: true, tax: 200 }] }],
    ['TDS', 'IN', '2026-04-01', 'TDS-NEW-2026', {
      slabs: [{ upto: 400000, rate: 0 }, { upto: 800000, rate: 5 }, { upto: 1200000, rate: 10 }, { upto: 1600000, rate: 15 }, { upto: 2000000, rate: 20 }, { upto: 2400000, rate: 25 }, { above: true, rate: 30 }],
      stdDeduction: 75000, rebateLimit: 1200000, rebateAmount: 60000, cess: 4,
      old: {
        slabs: [{ upto: 250000, rate: 0 }, { upto: 500000, rate: 5 }, { upto: 1000000, rate: 20 }, { above: true, rate: 30 }],
        stdDeduction: 50000, rebateLimit: 500000, rebateAmount: 12500, cess: 4,
      },
    }],
    ['LWF', 'KA', '2026-04-01', 'LWF-KA-2026', { employeeAmount: 12, employerAmount: 36 }],
  ];
  for (const [type, jur, eff, ver, params] of statutory) {
    await pool.query(
      `INSERT INTO statutory_rules (tenant_id, rule_type, jurisdiction, effective_from, version, params, notes, created_by)
       VALUES (?,?,?,?,?,?,?,1)`,
      [T, type, jur, eff, ver, JSON.stringify(params), `Seeded ${type} rules effective ${eff}`]
    );
  }

  // ---------- Leave types ----------
  const leaveTypes = [
    ['Casual Leave', 'CL', 'monthly', 1, 12, 6, 1, 1],
    ['Sick Leave', 'SL', 'monthly', 0.75, 9, 0, 0, 0],
    ['Earned Leave', 'EL', 'monthly', 1.5, 18, 15, 1, 0],
    ['Maternity Leave', 'ML', 'none', 0, 182, 0, 0, 0, 'female'],
    ['Paternity Leave', 'PL', 'none', 0, 15, 0, 0, 0, 'male'],
    ['Leave Without Pay', 'LWP', 'none', 0, 0, 0, 0, 0, 'all', 0],
  ];
  const leaveTypeIds = {};
  for (const [name, code, method, count, quota, cf, enc, neg, gender, paid] of leaveTypes) {
    const [ins] = await pool.query(
      `INSERT INTO leave_types (tenant_id, name, code, is_paid, accrual_method, accrual_count, annual_quota, max_carry_forward, encashable, negative_balance_allowed, applicable_gender, proof_required_after_days, min_notice_days)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [T, name, code, paid === 0 ? 0 : 1, method, count, quota, cf, enc, neg, gender || 'all', code === 'SL' ? 3 : 0, code === 'EL' ? 7 : 0]
    );
    leaveTypeIds[code] = ins.insertId;
  }

  // ---------- Employees ----------
  // [first, last, dept, desig, grade, locIdx, role, ctc, isManagerTarget]
  const people = [
    ['Priya', 'Sharma', 'Human Resources', 'HR Manager', 'L4', 0, 'hr_admin', 1440000],
    ['Rahul', 'Nair', 'Engineering', 'Engineering Manager', 'L4', 0, 'manager', 2400000],
    ['Aarav', 'Iyer', 'Engineering', 'Senior Software Engineer', 'L3', 0, 'employee', 1600000],
    ['Diya', 'Patel', 'Engineering', 'Software Engineer', 'L2', 0, 'employee', 1100000],
    ['Kabir', 'Reddy', 'Engineering', 'QA Engineer', 'L2', 1, 'employee', 900000],
    ['Ananya', 'Nair', 'Product', 'Product Manager', 'L3', 0, 'employee', 1800000],
    ['Rohan', 'Gupta', 'Engineering', 'DevOps Engineer', 'L2', 0, 'employee', 1200000],
    ['Ishita', 'Menon', 'Engineering', 'Software Engineer', 'L2', 1, 'employee', 1000000],
    ['Vivaan', 'Joshi', 'Finance', 'Finance Manager', 'L3', 0, 'finance_admin', 1500000],
    ['Meera', 'Kulkarni', 'Finance', 'Accountant', 'L2', 0, 'payroll_admin', 900000],
    ['Arjun', 'Das', 'Sales', 'Sales Executive', 'L2', 1, 'employee', 800000],
    ['Saanvi', 'Verma', 'Operations', 'Operations Lead', 'L3', 0, 'employee', 1300000],
    ['Aditya', 'Rao', 'Engineering', 'Software Engineer', 'L2', 0, 'employee', 950000],
    ['Kavya', 'Mehta', 'Human Resources', 'HR Executive', 'L1', 0, 'employee', 600000],
    ['Riya', 'Kapoor', 'Human Resources', 'Recruiter', 'L2', 0, 'recruiter', 840000],
    ['Kiran', 'Deshpande', 'Sales', 'Sales Head', 'L5', 0, 'department_head', 3200000],
  ];
  const empIds = [];
  let empNum = 100;
  for (let i = 0; i < people.length; i++) {
    const [first, last, dept, desig, grade, locIdx, role, ctc] = people[i];
    empNum += 1;
    const code = `EMP${empNum}`;
    const joined = dayjs().subtract(200 + i * 37, 'day').format('YYYY-MM-DD');
    const email = i === 0 ? 'hr@arthvex.com' : i === 1 ? 'manager@arthvex.com' : i === 3 ? 'employee@arthvex.com' : i === 8 ? 'finance@arthvex.com' : i === 9 ? 'payroll@arthvex.com' : i === 14 ? 'recruiter@arthvex.com' : i === 15 ? 'depthead@arthvex.com' : `${first.toLowerCase()}.${last.toLowerCase()}@arthvex.com`;
    const isManager = role === 'manager' || role === 'hr_admin';
    const status = i === 13 ? 'on_probation' : 'active';
    const grossMonthly = Math.round(ctc / 12);
    const basic = Math.round(grossMonthly * 0.5);
    const [ins] = await pool.query(
      `INSERT INTO employees (tenant_id, employee_code, first_name, last_name, email, phone, dob, gender, joined_on, probation_months, employment_type, status,
        department_id, designation_id, grade_id, location_id, cost_center_id, shift_id, work_mode, pan_plain, pan_enc, aadhaar_enc, bank_name, bank_account_enc, ifsc, tax_regime, uan)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [T, code, first, last, email, `9876543${String(10 + i)}`, `199${(i % 9) + 1}-0${(i % 8) + 1}-1${(i % 9)}`, i % 2 === 0 ? 'male' : 'female',
        joined, 6, 'full_time', status, deptIds[dept], desigIds[desig], gradeIds[grade], locIds[locIdx], cc.insertId,
        locIdx === 1 ? shiftEarly.insertId : shiftGen.insertId, i % 3 === 0 ? 'hybrid' : 'office',
        `ABCDE${1000 + i}F`, encrypt(`ABCDE${1000 + i}F`), encrypt(`123412341234`), 'HDFC Bank', encrypt(`50100${String(1000000 + i * 137)}`), 'HDFC0001234', i % 2 === 0 ? 'new' : 'new', `1010101010${String(10 + i)}`]
    );
    empIds.push({ id: ins.insertId, first, last, email, role, code, ctc, grossMonthly, basic, locIdx, dept, joined });

    await pool.query(
      `INSERT INTO users (tenant_id, employee_id, email, password_hash, name, role, status, must_change_password) VALUES (?,?,?,?,?,?, 'active', 0)
       ON DUPLICATE KEY UPDATE employee_id = VALUES(employee_id)`,
      [T, ins.insertId, email, hash, `${first} ${last}`, isManager && role === 'hr_admin' ? 'hr_admin' : role === 'manager' ? 'manager' : role]
    );
    await pool.query(
      `INSERT INTO employee_timeline (tenant_id, employee_id, event_type, title, event_date, created_by) VALUES (?,?,?,?,?,1)`,
      [T, ins.insertId, 'joined', `Joined as ${desig}`, joined]
    );
    await pool.query(
      `INSERT INTO employee_salaries (tenant_id, employee_id, structure_id, ctc_annual, gross_monthly, items, effective_from, created_by)
       VALUES (?,?,?,?,?,?,?,1)`,
      [T, ins.insertId, structure.insertId, ctc, grossMonthly, JSON.stringify([
        { code: 'BASIC', name: 'Basic', type: 'earning', calcType: 'fixed', amount: basic, taxable: true, prorated: true, partOfGross: true },
        { code: 'HRA', name: 'House Rent Allowance', type: 'earning', calcType: 'fixed', amount: Math.round(basic * 0.4), taxable: true, prorated: true, partOfGross: true },
        { code: 'CONV', name: 'Conveyance Allowance', type: 'earning', calcType: 'fixed', amount: 1600, taxable: true, prorated: true, partOfGross: true },
        { code: 'SPECIAL', name: 'Special Allowance', type: 'earning', calcType: 'fixed', amount: grossMonthly - basic - Math.round(basic * 0.4) - 1600, taxable: true, prorated: true, partOfGross: true },
      ]), joined]
    );
  }
  const hr = empIds[0];
  const mgr = empIds[1];
  const deptHead = empIds[15]; // Kiran Deshpande — Department Head (Sales)
  // reporting: engineering + product + QA → Rahul; Sales → Kiran (dept head); others → Priya
  for (let i = 2; i < empIds.length; i++) {
    const mid = [3, 4, 5, 6, 7, 12].includes(i) ? mgr.id : i === 10 ? deptHead.id : hr.id;
    await pool.query('UPDATE employees SET manager_id = ? WHERE id = ?', [mid, empIds[i].id]);
  }
  await pool.query('UPDATE departments SET head_employee_id = ? WHERE name = "Engineering"', [mgr.id]);
  await pool.query('UPDATE departments SET head_employee_id = ? WHERE name = "Human Resources"', [hr.id]);
  await pool.query('UPDATE departments SET head_employee_id = ? WHERE name = "Sales"', [deptHead.id]);

  // auditor + owner users (not employees)
  await pool.query(`INSERT INTO users (tenant_id, email, password_hash, name, role, status) VALUES (?, 'owner@arthvex.com', ?, 'Arthvex Owner', 'company_owner', 'active')`, [T, hash]);
  await pool.query(`INSERT INTO users (tenant_id, email, password_hash, name, role, status) VALUES (?, 'auditor@arthvex.com', ?, 'External Auditor', 'auditor', 'active')`, [T, hash]);

  // ---------- Attendance: seed last 30 days of punches (weekdays) ----------
  const salItems = (gross) => {
    const basic = Math.round(gross * 0.5);
    return [
      { code: 'BASIC', name: 'Basic', type: 'earning', calcType: 'fixed', amount: basic, taxable: true, prorated: true, partOfGross: true },
      { code: 'HRA', name: 'House Rent Allowance', type: 'earning', calcType: 'fixed', amount: Math.round(basic * 0.4), taxable: true, prorated: true, partOfGross: true },
      { code: 'CONV', name: 'Conveyance Allowance', type: 'earning', calcType: 'fixed', amount: 1600, taxable: true, prorated: true, partOfGross: true },
      { code: 'SPECIAL', name: 'Special Allowance', type: 'earning', calcType: 'fixed', amount: gross - basic - Math.round(basic * 0.4) - 1600, taxable: true, prorated: true, partOfGross: true },
    ];
  };
  let punchCount = 0;
  for (let d = 30; d >= 1; d--) {
    const date = dayjs().subtract(d, 'day');
    if (date.day() === 0) continue;
    const ds = date.format('YYYY-MM-DD');
    for (const e of empIds) {
      if (Math.random() < 0.06) continue; // some absents
      const inH = 9, inM = 25 + Math.floor(Math.random() * 20);
      const outH = 18, outM = 20 + Math.floor(Math.random() * 40);
      const late = inM > 40 ? inM - 40 : 0;
      await pool.query(
        `INSERT INTO attendance_records (tenant_id, employee_id, adate, shift_id, first_in, last_out, punches, worked_minutes, late_minutes, status, source)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [T, e.id, ds, e.locIdx === 1 ? shiftEarly.insertId : shiftGen.insertId,
          `${ds} ${String(inH).padStart(2, '0')}:${String(inM).padStart(2, '0')}:00`,
          `${ds} ${outH}:${String(outM).padStart(2, '0')}:00`,
          JSON.stringify([{ in: `${ds}T${String(inH).padStart(2, '0')}:${String(inM).padStart(2, '0')}:00`, out: `${ds}T${outH}:${String(outM).padStart(2, '0')}:00`, source: 'biometric' }]),
          (outH - inH) * 60 + (outM - inM) - 45, late, late > 15 ? 'present' : 'present', 'biometric']
      );
      punchCount++;
    }
  }
  console.log(`[seed] attendance punches: ${punchCount}`);

  // ---------- Leave requests ----------
  const lv = empIds[3];
  await pool.query(
    `INSERT INTO leave_requests (tenant_id, employee_id, leave_type_id, start_date, end_date, days, reason, day_breakdown, status, approver_id, actioned_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,NOW())`,
    [T, lv.id, leaveTypeIds.EL, dayjs().add(5, 'day').format('YYYY-MM-DD'), dayjs().add(7, 'day').format('YYYY-MM-DD'), 3, 'Family function',
      JSON.stringify([
        { date: dayjs().add(5, 'day').format('YYYY-MM-DD'), value: 1, kind: 'working' },
        { date: dayjs().add(6, 'day').format('YYYY-MM-DD'), value: 1, kind: 'working' },
        { date: dayjs().add(7, 'day').format('YYYY-MM-DD'), value: 1, kind: 'working' },
      ]), 'pending', null]
  );
  const lv2 = empIds[6];
  await pool.query(
    `INSERT INTO leave_requests (tenant_id, employee_id, leave_type_id, start_date, end_date, days, reason, day_breakdown, status, approver_id, actioned_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,NOW())`,
    [T, lv2.id, leaveTypeIds.CL, dayjs().subtract(10, 'day').format('YYYY-MM-DD'), dayjs().subtract(10, 'day').format('YYYY-MM-DD'), 1, 'Personal work',
      JSON.stringify([{ date: dayjs().subtract(10, 'day').format('YYYY-MM-DD'), value: 1, kind: 'working' }]), 'approved', mgr.id]
  );

  // opening balances + accruals snapshot for current year
  for (const e of empIds) {
    await pool.query(`INSERT INTO leave_balances (tenant_id, employee_id, leave_type_id, year, opening) VALUES (?,?,?,?,?)`, [T, e.id, leaveTypeIds.EL, YEAR, 6]);
    await pool.query(`INSERT INTO leave_balances (tenant_id, employee_id, leave_type_id, year, opening) VALUES (?,?,?,?,?)`, [T, e.id, leaveTypeIds.CL, YEAR, 3]);
    await pool.query(`INSERT INTO leave_balances (tenant_id, employee_id, leave_type_id, year, opening) VALUES (?,?,?,?,?)`, [T, e.id, leaveTypeIds.SL, YEAR, 3]);
  }

  // ---------- Expenses ----------
  const [cat1] = await pool.query(`INSERT INTO expense_categories (tenant_id, name, monthly_limit, receipt_required_above) VALUES (?,?,?,?)`, [T, 'Travel', 20000, 1000]);
  await pool.query(`INSERT INTO expense_categories (tenant_id, name, monthly_limit, receipt_required_above) VALUES (?,?,?,?)`, [T, 'Meals', 5000, 500]);
  await pool.query(`INSERT INTO expense_categories (tenant_id, name, monthly_limit, receipt_required_above) VALUES (?,?,?,?)`, [T, 'Internet & Phone', 2000, 1000]);
  await pool.query(`INSERT INTO expense_categories (tenant_id, name, monthly_limit, receipt_required_above) VALUES (?,?,?,?)`, [T, 'Office Supplies', 5000, 2000]);
  await pool.query(
    `INSERT INTO expense_claims (tenant_id, employee_id, category_id, title, expense_date, amount, description, status, submitted_at)
     VALUES (?,?,?,?,?,?,?, 'submitted', NOW()), (?,?,?,?,?,?,?, 'submitted', NOW()), (?,?,?,?,?,?,?, 'approved', NOW())`,
    [T, empIds[2].id, cat1.insertId, 'Client visit — Mumbai', dayjs().subtract(8, 'day').format('YYYY-MM-DD'), 8450, 'Flight + hotel', T, empIds[6].id, cat1.insertId, 'Team lunch', dayjs().subtract(4, 'day').format('YYYY-MM-DD'), 2350, 'Quarterly celebration', T, empIds[11].id, cat1.insertId, 'Courier charges', dayjs().subtract(15, 'day').format('YYYY-MM-DD'), 640, 'Documents to client']
  );

  // ---------- Loan ----------
  const [loan] = await pool.query(
    `INSERT INTO loans (tenant_id, employee_id, ltype, title, principal, interest_rate, tenure_months, emi_amount, start_month, start_year, outstanding, status, disbursed_on, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1)`,
    [T, empIds[4].id, 'loan', 'Personal loan', 100000, 0, 10, 10000, dayjs().month() + 1, YEAR, 100000, 'active', dayjs().subtract(5, 'day').format('YYYY-MM-DD')]
  );
  let lm = dayjs().month() + 1, ly = YEAR;
  for (let i = 1; i <= 10; i++) {
    await pool.query(`INSERT INTO loan_installments (loan_id, tenant_id, installment_no, due_month, due_year, amount) VALUES (?,?,?,?,?,?)`, [loan.insertId, T, i, lm, ly, 10000]);
    lm++; if (lm > 12) { lm = 1; ly++; }
  }

  // ---------- Performance ----------
  const [cycle] = await pool.query(
    `INSERT INTO performance_cycles (tenant_id, name, start_date, end_date, review_type, status) VALUES (?,?,?,?,?, 'active')`,
    [T, `Annual Review ${YEAR}`, `${YEAR}-01-01`, `${YEAR}-12-31`, 'annual']
  );
  for (const e of empIds.slice(2, 10)) {
    await pool.query(`INSERT INTO goals (tenant_id, employee_id, cycle_id, title, kpi, weightage, due_date, status, progress, created_by) VALUES (?,?,?,?,?,?,?, 'active', ?, 1)`,
      [T, e.id, cycle.insertId, `Q goals for ${e.first}`, 'On-time delivery', 40, dayjs().add(60, 'day').format('YYYY-MM-DD'), 30 + Math.floor(Math.random() * 60)]);
    await pool.query(`INSERT INTO reviews (tenant_id, cycle_id, employee_id, status) VALUES (?,?,?, 'not_started')`, [T, cycle.insertId, e.id]);
  }

  // ---------- Recruitment ----------
  const [req1] = await pool.query(
    `INSERT INTO requisitions (tenant_id, rcode, title, department_id, location_id, openings, employment_type, min_experience, budget_ctc, description, hiring_manager_id, status, published, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,1)`,
    [T, 'REQ-000101', 'Senior Backend Engineer', deptIds['Engineering'], locBlr.insertId, 2, 'full_time', 4, 2200000, 'Node.js + MySQL at scale', mgr.id, 'open']
  );
  const candStages = [['Nikhil Suresh', 'applied'], ['Ritika Bansal', 'screening'], ['Farhan Ali', 'interview'], ['Deepa Krishnan', 'offer']];
  for (const [nm, stage] of candStages) {
    await pool.query(
      `INSERT INTO candidates (tenant_id, requisition_id, name, email, source, experience_years, current_company, expected_ctc, stage)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [T, req1.insertId, nm, `${nm.split(' ')[0].toLowerCase()}@example.com`, 'linkedin', 3 + Math.random() * 4, 'SomeCompany', 1500000 + Math.round(Math.random() * 800000), stage]
    );
  }

  // ---------- Assets ----------
  const assets = [];
  for (let i = 1; i <= 8; i++) {
    const [ins] = await pool.query(
      `INSERT INTO assets (tenant_id, asset_code, name, category, serial_no, brand, model, purchase_date, purchase_value, status)
       VALUES (?,?,?,?,?,?,?,?,?, 'available')`,
      [T, `LT-${String(100 + i)}`, `MacBook Pro 14" #${i}`, 'laptop', `SN${9000 + i}`, 'Apple', 'MBP14-M3', `${YEAR - 1}-06-1${i}`, 199900]
    );
    assets.push(ins.insertId);
  }
  for (let i = 0; i < 5; i++) {
    await pool.query(
      `INSERT INTO asset_assignments (tenant_id, asset_id, employee_id, assigned_on, condition_on_issue, status) VALUES (?,?,?,?,'Good', 'assigned')`,
      [T, assets[i], empIds[i + 2].id, dayjs().subtract(90 - i * 10, 'day').format('YYYY-MM-DD')]
    );
    await pool.query('UPDATE assets SET status = "assigned" WHERE id = ?', [assets[i]]);
  }

  // ---------- Tickets ----------
  const [tk1] = await pool.query(
    `INSERT INTO tickets (tenant_id, ticket_no, employee_id, category, subject, description, priority, sla_hours, sla_due_at, status)
     VALUES (?,?,?,?,?,?,?,48,?, 'open')`,
    [T, 'TKT-00001', empIds[3].id, 'it', 'VPN not connecting from home', 'Unable to connect to office VPN since morning.', 'high', dayjs().add(2, 'day').format('YYYY-MM-DD HH:mm:ss')]
  );
  await pool.query(
    `INSERT INTO tickets (tenant_id, ticket_no, employee_id, category, subject, description, priority, sla_hours, sla_due_at, status)
     VALUES (?,?,?,?,?,?,?,48,?, 'in_progress')`,
    [T, 'TKT-00002', empIds[12].id, 'payroll', 'PF contribution mismatch in last payslip', 'PF deducted twice in last month payslip.', 'urgent', dayjs().add(1, 'day').format('YYYY-MM-DD HH:mm:ss')]
  );
  await pool.query(`INSERT INTO ticket_comments (ticket_id, author_id, comment) VALUES (?,?,?)`, [tk1.insertId, 2, 'Looking into it, restarting the VPN gateway.']);

  // ---------- Announcements & company docs ----------
  await pool.query(
    `INSERT INTO announcements (tenant_id, title, body, audience, pinned, created_by) VALUES
     (?,?,?,?,1,1), (?,?,?,?,0,1)`,
    [T, 'Quarterly All-Hands — Friday 4 PM', 'Join us in the main auditorium (or via Zoom) for the quarterly business review and roadmap.', 'all',
      T, 'Health insurance renewal', 'New group medical insurance cards will be distributed by next week. HR desk in the lobby for queries.', 'all']
  );
  await pool.query(
    `INSERT INTO company_documents (tenant_id, title, category, description, version, requires_ack, published_at, created_by) VALUES (?,?,?,?,?,?,NOW(),1)`,
    [T, 'Employee Handbook 2026', 'policy', 'Code of conduct, benefits, and workplace policies.', '3.0', 1]
  );
  await pool.query(
    `INSERT INTO letter_templates (tenant_id, name, ltype, subject, body) VALUES (?,?,?,?,?)`,
    [T, 'Employment Certificate', 'experience', 'Employment Certificate — {{employeeName}}',
      'This is to certify that {{employeeName}} (Employee Code: {{employeeCode}}) was employed with {{companyName}} as {{designation}} in the {{department}} department from {{joiningDate}} until {{today}}.\n\nDuring their tenure, their conduct and performance were satisfactory.\n\nWe wish them the best in future endeavors.\n\nSincerely,\nHR — {{companyName}}']
  );

  // ---------- Billing ----------
  const [cust1] = await pool.query(
    `INSERT INTO customers (tenant_id, name, gstin, address, city, state, state_code, pincode, contact_name, email, phone) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [T, 'Zenith Retail Pvt Ltd', '27AAECZ1234F1Z2', 'Plot 14, MIDC', 'Pune', 'Maharashtra', 'MH', '411001', 'S. Kulkarni', 'accounts@zenith.example', '9822011122']
  );
  await pool.query(
    `INSERT INTO customers (tenant_id, name, gstin, address, city, state, state_code, pincode, contact_name, email, phone) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [T, 'BlueOrbit Media LLP', '29AAGFB1234C1ZK', 'MG Road', 'Bengaluru', 'Karnataka', 'KA', '560001', 'R. Fernandes', 'pay@blueorbit.example', '9886012345']
  );
  const invDate = dayjs().subtract(12, 'day');
  const dueDate = invDate.add(30, 'day');
  const [inv] = await pool.query(
    `INSERT INTO invoices (tenant_id, customer_id, invoice_no, invoice_date, due_date, subtotal, cgst, sgst, igst, total, amount_paid, place_of_supply, is_intra_state, status)
     VALUES (?,?,?,?,?,?,?,?,?,?,0,?,0, 'sent')`,
    [T, cust1.insertId, `INV-${YEAR}${String((YEAR + 1) % 100).padStart(2, '0')}-0001`, invDate.format('YYYY-MM-DD'), dueDate.format('YYYY-MM-DD'), 250000, 22500, 22500, 0, 295000, 'MH']
  );
  await pool.query(
    `INSERT INTO invoice_items (invoice_id, description, hsn_sac, quantity, rate, gst_rate, amount) VALUES (?,?,?,?,?,?,?)`,
    [inv.insertId, 'HRMS implementation & onboarding — Zenith Retail', '998314', 1, 250000, 18, 250000]
  );

  // ---------- Settings ----------
  await pool.query(`INSERT INTO settings (tenant_id, skey, svalue) VALUES (?,?,?)`, [T, 'attendance', JSON.stringify({ autoAbsent: true, geoRequired: false, deviceKey: 'demo-device-key-2026' })]);
  await pool.query(`INSERT INTO settings (tenant_id, skey, svalue) VALUES (?,?,?)`, [T, 'payroll', JSON.stringify({ monthDays: 30 })]);
  await pool.query(`INSERT INTO settings (tenant_id, skey, svalue) VALUES (?,?,?)`, [T, 'workflows', JSON.stringify({ leave: ['manager', 'hr'], expense: ['manager', 'finance'], regularization: ['manager'] })]);
  await pool.query(`INSERT INTO settings (tenant_id, skey, svalue) VALUES (?,?,?)`, [T, 'notifications', JSON.stringify({ smtpHost: '', smtpUser: '', fromName: 'Arthvex HRMS' })]);

  // ---------- Payroll run for last month ----------
  const lastMonth = dayjs().subtract(1, 'month');
  const [run] = await pool.query(
    `INSERT INTO payroll_runs (tenant_id, period_year, period_month, pay_date, status, month_days) VALUES (?,?,?,?, 'draft', 30)`,
    [T, lastMonth.year(), lastMonth.month() + 1, lastMonth.add(1, 'month').date(1).format('YYYY-MM-DD')]
  );
  console.log(`[seed] payroll run created for ${lastMonth.format('YYYY-MM')} (id ${run.insertId})`);

  console.log('[seed] done.');
  console.log('  Logins (password: Password@123):');
  console.log('   super@arthvex.com | owner@arthvex.com | hr@arthvex.com | payroll@arthvex.com | finance@arthvex.com');
  console.log('   manager@arthvex.com | depthead@arthvex.com | recruiter@arthvex.com');
  console.log('   employee@arthvex.com (Diya Patel) | auditor@arthvex.com');
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
