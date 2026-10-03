/**
 * Setup health: concrete checks computed from the tenant's own configuration. No score — every
 * line is a pass/fail with the number behind it and, when failing, what to do. Aggregates only;
 * it never returns an employee's private data, just counts and (for data quality) record ids.
 */
const { pool } = require('../config/db');

const n = async (sql, params) => Number(((await pool.query(sql, params))[0][0] || {}).n || 0);
const check = (key, label, ok, detail, fix, severity = 'required') => ({ key, label, ok: !!ok, detail, fix: ok ? null : fix, severity });

async function setupChecks(tenantId) {
  const T = [tenantId];
  const [[tenant]] = await pool.query('SELECT name, industry, country, timezone, currency, contact_email FROM tenants WHERE id = ?', T);
  const entities = await n('SELECT COUNT(*) n FROM companies WHERE tenant_id = ?', T);
  const entitiesWithPan = await n("SELECT COUNT(*) n FROM companies WHERE tenant_id = ? AND (pan IS NOT NULL AND pan <> '')", T);
  const locations = await n("SELECT COUNT(*) n FROM locations WHERE tenant_id = ? AND status = 'active'", T);
  const departments = await n("SELECT COUNT(*) n FROM departments WHERE tenant_id = ? AND (status = 'active' OR status IS NULL)", T);
  const designations = await n('SELECT COUNT(*) n FROM designations WHERE tenant_id = ?', T);
  const shifts = await n("SELECT COUNT(*) n FROM shifts WHERE tenant_id = ? AND status = 'active'", T);
  const holidays = await n('SELECT COUNT(*) n FROM holidays WHERE tenant_id = ? AND YEAR(hdate) = YEAR(CURDATE())', T);
  const leaveTypes = await n('SELECT COUNT(*) n FROM leave_types WHERE tenant_id = ?', T);
  const employees = await n("SELECT COUNT(*) n FROM employees WHERE tenant_id = ? AND deleted_at IS NULL AND status IN ('active','on_probation','on_notice')", T);
  const admins = await n("SELECT COUNT(*) n FROM users WHERE tenant_id = ? AND status = 'active' AND role IN ('company_owner','hr_admin','payroll_admin')", T);
  const adminsNoMfa = await n("SELECT COUNT(*) n FROM users WHERE tenant_id = ? AND status = 'active' AND role IN ('company_owner','hr_admin','payroll_admin') AND (mfa_enabled = 0 OR mfa_enabled IS NULL)", T);
  const structures = await n('SELECT COUNT(*) n FROM salary_structures WHERE tenant_id = ? AND active = 1', T);
  const components = await n('SELECT COUNT(*) n FROM salary_components WHERE tenant_id = ? AND active = 1', T);
  const paid = await n(`SELECT COUNT(DISTINCT es.employee_id) n FROM employee_salaries es JOIN employees e ON e.id = es.employee_id
      WHERE es.tenant_id = ? AND e.deleted_at IS NULL AND e.status IN ('active','on_probation','on_notice') AND es.effective_from <= CURDATE() AND (es.effective_to IS NULL OR es.effective_to >= CURDATE())`, T);
  const stat = await n("SELECT COUNT(DISTINCT rule_type) n FROM statutory_rules WHERE tenant_id = ? AND effective_from <= CURDATE() AND (effective_to IS NULL OR effective_to >= CURDATE())", T);
  const noBank = await n("SELECT COUNT(*) n FROM employees WHERE tenant_id = ? AND deleted_at IS NULL AND status IN ('active','on_probation','on_notice') AND (bank_account_enc IS NULL OR bank_account_enc = '') AND (bank_name IS NULL OR bank_name = '')", T);

  const setup = [
    check('profile', 'Company profile', tenant && tenant.industry && tenant.contact_email, `${tenant?.name || ''}${tenant?.industry ? ` · ${tenant.industry}` : ''}`, 'Add the industry and a contact email.'),
    check('legal_entity', 'Legal entity', entities > 0, `${entities} entity(ies)`, 'Create at least one legal entity.'),
    check('locations', 'Locations', locations > 0, `${locations} active`, 'Add a location.'),
    check('departments', 'Departments', departments > 0, `${departments} active`, 'Add departments.'),
    check('designations', 'Designations', designations > 0, `${designations}`, 'Add designations.'),
    check('shifts', 'Shifts', shifts > 0, `${shifts} active`, 'Create a shift so attendance can be evaluated.'),
    check('holidays', 'Holiday calendar (this year)', holidays > 0, `${holidays} holiday(s)`, 'Add this year\'s holidays.', 'recommended'),
    check('leave', 'Leave policies', leaveTypes > 0, `${leaveTypes} type(s)`, 'Create leave types.'),
    check('employees', 'Employees', employees > 0, `${employees} active`, 'Add or import employees.'),
    check('admins', 'Administrator accounts', admins >= 2, `${admins} admin(s)`, 'Have at least two administrators so one lost login cannot lock the company out.', 'recommended'),
  ];
  const payroll = [
    check('p_entity', 'Legal entity with a PAN', entitiesWithPan > 0, `${entitiesWithPan} of ${entities}`, 'Add the entity\'s PAN.'),
    check('p_components', 'Salary components', components > 0, `${components} active`, 'Define salary components.'),
    check('p_structure', 'Salary structure', structures > 0, `${structures} active`, 'Create a salary structure.'),
    check('p_assigned', 'Salary assigned to employees', employees > 0 && paid === employees, `${paid} of ${employees} employees`, `Assign an effective salary to the ${Math.max(0, employees - paid)} employee(s) without one.`),
    check('p_statutory', 'Statutory configuration', stat > 0, `${stat} rule type(s) in effect`, 'Configure PF / ESI / PT / TDS rules for the current date.'),
    check('p_bank', 'Bank details', employees > 0 && noBank === 0, `${noBank} employee(s) without bank details`, 'Collect bank details before paying salaries.', 'recommended'),
  ];
  const requiredPayrollOk = payroll.filter((c) => c.severity === 'required').every((c) => c.ok);
  const security = [
    check('s_mfa', 'MFA on administrator accounts', admins > 0 && adminsNoMfa === 0, `${adminsNoMfa} of ${admins} admin(s) without MFA`, 'Ask administrators to enrol MFA.', 'recommended'),
  ];
  return {
    setup, security,
    payroll: { ready: requiredPayrollOk, checks: payroll, message: requiredPayrollOk ? 'Payroll can run.' : `Payroll cannot run until: ${payroll.filter((c) => c.severity === 'required' && !c.ok).map((c) => c.label).join(', ')}.` },
  };
}

/** Concrete records needing attention. Ids and codes only — no salary, bank or ID numbers. */
async function dataQuality(tenantId, limit = 20) {
  const T = [tenantId];
  const act = "tenant_id = ? AND deleted_at IS NULL AND status IN ('active','on_probation','on_notice')";
  const [noDept] = await pool.query(`SELECT id, employee_code FROM employees WHERE ${act} AND department_id IS NULL LIMIT ?`, [...T, limit]);
  const [noMgr] = await pool.query(`SELECT id, employee_code FROM employees WHERE ${act} AND manager_id IS NULL LIMIT ?`, [...T, limit]);
  const [noLoc] = await pool.query(`SELECT id, employee_code FROM employees WHERE ${act} AND location_id IS NULL LIMIT ?`, [...T, limit]);
  const [dupCodes] = await pool.query('SELECT employee_code, COUNT(*) AS n FROM employees WHERE tenant_id = ? AND deleted_at IS NULL GROUP BY employee_code HAVING n > 1 LIMIT ?', [...T, limit]);
  const [orphanUsers] = await pool.query(
    `SELECT u.id FROM users u LEFT JOIN employees e ON e.id = u.employee_id WHERE u.tenant_id = ? AND u.employee_id IS NOT NULL AND (e.id IS NULL OR e.deleted_at IS NOT NULL) LIMIT ?`, [...T, limit]);
  const [badRole] = await pool.query(
    `SELECT u.id FROM users u WHERE u.tenant_id = ? AND NOT EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = u.id) LIMIT ?`, [...T, limit]);
  const [noSalary] = await pool.query(
    `SELECT e.id, e.employee_code FROM employees e WHERE e.${act.replace(/tenant_id/, 'tenant_id')}
        AND NOT EXISTS (SELECT 1 FROM employee_salaries s WHERE s.employee_id = e.id AND s.effective_from <= CURDATE() AND (s.effective_to IS NULL OR s.effective_to >= CURDATE())) LIMIT ?`, [...T, limit]);
  return {
    employeesMissingDepartment: noDept, employeesMissingManager: noMgr, employeesMissingLocation: noLoc,
    duplicateEmployeeCodes: dupCodes, usersLinkedToMissingEmployee: orphanUsers, usersWithoutRole: badRole, employeesWithoutSalary: noSalary,
  };
}

module.exports = { setupChecks, dataQuality };
