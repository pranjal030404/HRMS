/**
 * Demo seed: 1 tenant ("Arthvex Technologies Pvt Ltd"), system roles, statutory rules,
 * salary components/structure, shifts, leave types, holidays, ~16 employees incl.
 * a manager hierarchy, attendance punches, leave requests, expenses, loans, goals,
 * requisitions, candidates, assets, tickets, announcements, customers + an invoice,
 * and a calculated payroll run for last month.
 *
 * Login (all with password "Password@123"):
 *   admin@arthvex.com        (Administrator for the /admin console — Admin@12345,
 *                             every permission + every module + every company)
 *   super@arthvex.com        (Platform Super Admin, no company bound)
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
const crypto = require('crypto');
const dayjs = require('dayjs');
const { pool } = require('../config/db');
const { encrypt } = require('../utils/crypto');
const {
  ROLE_DEFS, DEFAULT_ROLES, MODULE_CATALOG,
  SYSTEM_PERMISSION_GROUPS, SYSTEM_RELATIONSHIP_TYPES,
} = require('../utils/permissions');
const { ensureAdminUser, ADMIN_EMAIL, ADMIN_PASSWORD } = require('./lib/adminAccount');

const sha256Key = (s) => crypto.createHash('sha256').update(s).digest('hex');

const PASSWORD = 'Password@123';
const YEAR = dayjs().year();
// Stable per-run salt so invitation token hashes differ between seeds but are
// deterministic inside one, which keeps re-seeding idempotent.
const slugSalt = crypto.randomBytes(8).toString('hex');

const FIRST = ['Aarav', 'Diya', 'Kabir', 'Ananya', 'Rohan', 'Ishita', 'Vivaan', 'Meera', 'Arjun', 'Saanvi', 'Aditya', 'Priya', 'Nikhil', 'Kavya'];
const LAST = ['Sharma', 'Iyer', 'Patel', 'Reddy', 'Nair', 'Gupta', 'Menon', 'Joshi', 'Kulkarni', 'Das', 'Verma', 'Rao', 'Mehta', 'Pillai'];

/**
 * Administration Center demo data.
 *
 * Everything here is content a real company would configure on day one — teams and
 * open positions, the custom fields and forms HR asks for, master data, workflow SLAs,
 * menus, widgets, onboarding progress and a couple of deliberate security decisions
 * (a retained audit window, a denied permission) so the access screens have something
 * truthful to show. RBAC catalog rows stay owned by the migration; only this tenant's
 * configuration and content is seeded here.
 */
async function seedAdministrationCenter(T, ctx) {
  const { hr, mgr, deptHead, empIds, deptIds, desigIds, gradeIds, locations } = ctx;
  const [locBlr, locPune] = locations;
  const j = (v) => JSON.stringify(v);

  // ---------- Teams and open positions ----------
  const teams = [
    ['Platform Engineering', 'TEAM-PLAT', 'Product Engineering', 'Bengaluru HQ', mgr, mgr],
    ['People Operations', 'TEAM-PEOPLE', 'Human Resources', 'Bengaluru HQ', hr, null],
    ['Revenue — Enterprise', 'TEAM-ENT', 'Sales', 'Pune Office', deptHead, deptHead],
  ];
  const teamIds = [];
  for (const [name, code, dept, locName, lead, manager] of teams) {
    const [ins] = await pool.query(
      `INSERT INTO teams (tenant_id, department_id, location_id, name, code, description, team_lead_id, manager_id, status, effective_from)
       VALUES (?, (SELECT id FROM departments WHERE tenant_id = ? AND name = ?),
               (SELECT id FROM locations WHERE tenant_id = ? AND name = ?), ?,?,?,?,?,'active', CURDATE())`,
      [T, T, dept, T, locName, name, code, `${name} — ${dept} team`, lead, manager]
    );
    teamIds.push(ins.insertId);
  }
  const memberRows = [
    [teamIds[0], mgr, 'Lead', 100],
    [teamIds[0], empIds[3].id, 'Member', 80],
    [teamIds[0], empIds[5].id, 'Member', 60],
    [teamIds[1], hr, 'Lead', 100],
    [teamIds[1], empIds[7].id, 'Member', 50],
    [teamIds[2], deptHead, 'Lead', 100],
    [teamIds[2], empIds[9].id, 'Member', 100],
  ];
  for (const [team, emp, role, pct] of memberRows) {
    await pool.query(
      `INSERT INTO team_members (tenant_id, team_id, employee_id, member_role, allocation_pct, effective_from, status)
       VALUES (?,?,?,?,?,CURDATE(),'active')`, [T, team, emp, role, pct]
    );
  }

  const positions = [
    ['POS-SEN-01', 'Senior Backend Engineer', 'Engineering', 'Senior Software Engineer', 'L4', 2, 0, 'open'],
    ['POS-ENGM-02', 'Engineering Manager — Data', 'Engineering', 'Engineering Manager', 'L5', 1, 0, 'open'],
    ['POS-PM-03', 'Product Manager — Payments', 'Product', 'Product Manager', 'L4', 1, 1, 'open'],
    ['POS-FIN-04', 'Accounts Payable Executive', 'Finance', 'Accountant', 'L2', 1, 0, 'planned'],
  ];
  for (const [code, title, dept, desig, grade, openings, filled, status] of positions) {
    await pool.query(
      `INSERT INTO positions (tenant_id, department_id, designation_id, grade_id, location_id, code, title, description,
         openings, filled, employment_type, status, opened_on, created_by)
       VALUES (?, (SELECT id FROM departments WHERE tenant_id = ? AND name = ?),
               (SELECT id FROM designations WHERE tenant_id = ? AND name = ?),
               (SELECT id FROM grades WHERE tenant_id = ? AND name = ?),
               ?, ?, ?, ?, ?, ?, 'full_time', ?, CURDATE(), ?)`,
      [T, T, dept, T, desig, T, grade, locBlr, code, title, `${title} — ${dept}`, openings, filled, status, hr]
    );
  }

  // ---------- Custom fields on employees ----------
  const customFields = [
    ['preferred_name', 'Preferred name', 'What colleagues should call them', 'text', 0, { mode: 'all' }, []],
    ['emergency_contact_verified', 'Emergency contact verified', 'Checked against the verified contact list', 'checkbox', 0, { mode: 'roles' }, ['hr_admin', 'company_owner']],
    ['notice_period_days', 'Notice period (days)', 'Days of notice the employee committed to', 'number', 0, { mode: 'roles' }, ['hr_admin', 'company_owner']],
    ['blood_group', 'Blood group', 'Optional, used by occupational health', 'dropdown', 0, { mode: 'all' }, []],
    ['laptop_asset_tag', 'Laptop asset tag', 'Assigned from the asset register', 'text', 0, { mode: 'hidden' }, []],
  ];
  const fieldIds = {};
  for (const [key, label, description, type, required, visibility, roles] of customFields) {
    const [ins] = await pool.query(
      `INSERT INTO custom_field_definitions (tenant_id, entity_type, field_key, label, description, field_type, required,
         visibility, allowed_role_codes, status, created_by)
       VALUES (?, 'employee', ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
      [T, key, label, description, type, required, j(visibility), j(roles), hr]
    );
    fieldIds[key] = ins.insertId;
  }
  for (const [i, group] of ['A+', 'A-', 'B+', 'B-', 'O+', 'O-'].entries()) {
    await pool.query(
      `INSERT INTO custom_field_options (tenant_id, field_id, option_value, option_label, sort_order, status)
       VALUES (?,?,?,?,?,'active')`, [T, fieldIds.blood_group, group, group, i]
    );
  }
  const values = [
    ['preferred_name', 'Diya', 'text'],
    ['emergency_contact_verified', '1', 'number'],
    ['notice_period_days', '60', 'number'],
    ['blood_group', 'B+', 'text'],
    ['laptop_asset_tag', 'AT-0042', 'text'],
  ];
  for (const [emp, idx] of [[empIds[1], 1], [empIds[2], 2], [empIds[4], 3]]) {
    for (const [key, value, col] of values) {
      if (key === 'laptop_asset_tag' && idx !== 1) continue;
      await pool.query(
        `INSERT INTO custom_field_values (tenant_id, entity_type, entity_id, field_id, field_key, value_text, updated_by)
         VALUES (?, 'employee', ?, ?, ?, ?, ?)`,
        [T, emp.id, fieldIds[key], key, value, hr]
      );
    }
  }

  // ---------- Custom forms ----------
  const [form] = await pool.query(
    `INSERT INTO custom_forms (tenant_id, form_key, name, entity_type, description, version, status, is_system, created_by, published_at)
     VALUES (?, 'onboarding_checklist', 'New joiner checklist', 'employee',
       'What HR confirms on day one for every new joiner', 1, 'published', 0, ?, NOW())`, [T, hr]
  );
  const sections = [
    ['Identity & documents', 'Verified identity, address and right to work'],
    ['IT & access', 'Laptop, accounts and building access'],
    ['Payroll & benefits', 'Bank details, provident fund and beneficiaries'],
  ];
  const sectionIds = [];
  for (const [i, [title, description]] of sections.entries()) {
    const [ins] = await pool.query(
      `INSERT INTO custom_form_sections (tenant_id, form_id, title, description, sort_order, visibility)
       VALUES (?,?,?,?,?, '{"mode":"all"}')`, [T, form.insertId, title, description, i]
    );
    sectionIds.push(ins.insertId);
  }
  const formFields = [
    [sectionIds[0], 'id_proof', 'ID proof verified', 'boolean', 1],
    [sectionIds[0], 'address_proof', 'Address proof verified', 'boolean', 1],
    [sectionIds[0], 'right_to_work', 'Right to work checked', 'boolean', 1],
    [sectionIds[1], 'laptop_issued', 'Laptop issued', 'boolean', 1],
    [sectionIds[1], 'email_created', 'Work email created', 'text', 1],
    [sectionIds[2], 'bank_details', 'Bank details captured', 'text', 1],
    [sectionIds[2], 'pf_opted_in', 'Provident fund opted in', 'boolean', 0],
  ];
  for (const [i, [section, key, label, type, required]] of formFields.entries()) {
    await pool.query(
      `INSERT INTO custom_form_fields (tenant_id, form_id, section_id, field_key, label, field_type, required, is_locked, sort_order)
       VALUES (?,?,?,?,?,?,?,?,?)`, [T, form.insertId, section, key, label, type, required, 0, i]
    );
  }

  const [exitForm] = await pool.query(
    `INSERT INTO custom_forms (tenant_id, form_key, name, entity_type, description, version, status, is_system, created_by)
     VALUES (?, 'exit_interview', 'Exit interview', 'employee',
       'Structured exit conversation — why they are leaving and what to fix', 1, 'draft', 0, ?)`, [T, hr]
  );
  const [exitSection] = await pool.query(
    `INSERT INTO custom_form_sections (tenant_id, form_id, title, description, sort_order, visibility)
     VALUES (?,?, 'Conversation', 'Reason for leaving, notice period, handover', 0, '{"mode":"roles"}')`, [T, exitForm.insertId]
  );
  for (const [i, [key, label, type, required]] of [
    ['primary_reason', 'Primary reason for leaving', 'textarea', 1],
    ['would_rejoin', 'Would you rejoin?', 'boolean', 1],
    ['handover_notes', 'Handover notes', 'textarea', 0],
  ].entries()) {
    await pool.query(
      `INSERT INTO custom_form_fields (tenant_id, form_id, section_id, field_key, label, field_type, required, is_locked, sort_order)
       VALUES (?,?,?,?,?,?,?,0,?)`, [T, exitForm.insertId, exitSection.insertId, key, label, type, required, i]
    );
  }

  // ---------- Master data ----------
  const categories = [
    ['skills', 'Skills', 'Reusable skill taxonomy used by profiles, goals and learning'],
    ['certifications', 'Certifications', 'Certifications HR recognises for eligibility'],
    ['exit_reasons', 'Exit reasons', 'Standardised reasons for attrition reporting'],
    ['work_authorisations', 'Work authorisations', 'Right-to-work categories'],
  ];
  const categoryIds = {};
  for (const [code, name, description] of categories) {
    const [ins] = await pool.query(
      `INSERT INTO master_data_categories (tenant_id, code, name, description, entity_binding, is_system, status, created_by)
       VALUES (?,?,?,?, NULL, 0, 'active', ?)`, [T, code, name, description, hr]
    );
    categoryIds[code] = ins.insertId;
  }
  const items = {
    skills: [['JAVA', 'Java'], ['REACT', 'React'], ['SQL', 'SQL'], ['PYTHON', 'Python'], ['AWS', 'AWS'], ['KUBERNETES', 'Kubernetes']],
    certifications: [['AWS_SAA', 'AWS Solutions Architect Associate'], ['PMP', 'Project Management Professional'], ['SHRM_CP', 'SHRM Certified Professional'], ['CFA', 'Chartered Financial Analyst']],
    exit_reasons: [['BETTER_PAY', 'Better compensation'], ['GROWTH', 'Limited growth'], ['RELOCATION', 'Relocation'], ['COMPANY', 'Company restructuring'], ['PERSONAL', 'Personal reasons']],
    work_authorisations: [['CITIZEN', 'Citizenship'], ['PR', 'Permanent residence'], ['SINGLE_VISA', 'Single work visa'], ['DUAL', 'Dual authorisation']],
  };
  for (const [code, list] of Object.entries(items)) {
    for (const [i, [itemCode, name]] of list.entries()) {
      await pool.query(
        `INSERT INTO master_data_items (tenant_id, category_id, code, name, status, sort_order, created_by)
         VALUES (?,?,?,?,'active',?,?)`, [T, categoryIds[code], itemCode, name, i, hr]
      );
    }
  }

  // ---------- Workflow SLA + onboarding progress ----------
  const [leaveWorkflow] = await pool.query(
    `SELECT id FROM workflows WHERE tenant_id = ? AND trigger_event = 'leave.submitted' LIMIT 1`, [T]
  );
  if (leaveWorkflow[0]) {
    for (const [step, hours, remind] of [['Manager approval', 24, 8], ['HR review', 48, 24]]) {
      await pool.query(
        `INSERT INTO workflow_sla_rules (tenant_id, workflow_id, step_name, sla_hours, remind_after_hours, active)
         VALUES (?,?,?,?,?,1)`, [T, leaveWorkflow[0].id, step, hours, remind]
      );
    }
  }
  await pool.query(
    `INSERT INTO company_onboarding (tenant_id, current_step, completed_steps, skipped_steps, status, started_by)
     VALUES (?, 'security', ?, '["expense_categories"]', 'in_progress', ?)`, [T, j(['company_profile', 'org_structure', 'locations', 'owner', 'employees', 'leave_types']), hr]
  );

  // ---------- Menus and dashboard widgets ----------
  const menus = [
    ['administration', 'Administration', 'shield', '/administration', 'dashboard', 10, 'administration.access.view'],
    ['administration.organization', 'Organization', 'sitemap', '/administration/organization', 'administration', 11, 'administration.organization.view'],
    ['administration.users', 'Users & Roles', 'users', '/administration/users', 'administration', 12, 'administration.users.view'],
    ['administration.workflows', 'Workflows', 'sitemap', '/administration/workflows', 'administration', 13, 'administration.workflows.view'],
    ['administration.security', 'Security', 'lock', '/administration/security', 'administration', 14, 'administration.security.view'],
    ['administration.audit', 'Audit Trail', 'list', '/administration/audit', 'administration', 15, 'administration.audit.view'],
  ];
  for (const [key, label, icon, route, parent, sort, permission] of menus) {
    await pool.query(
      `INSERT INTO menu_items (tenant_id, menu_key, label, icon, parent_key, route, target, sort_order, required_permission, visible, is_system)
       VALUES (?,?,?,?,?,?, '_self', ?,?,1,0)`,
      [T, key, label, icon, parent, route, sort, permission]
    );
  }
  const widgets = [
    ['admin_headcount', 'Headcount', 'employees', { metric: 'headcount' }, 10, 'employee.view'],
    ['admin_open_positions', 'Open positions', 'employees', { metric: 'openPositions' }, 20, 'administration.organization.view'],
    ['admin_pending_leave', 'Leave awaiting approval', 'leave', { metric: 'pendingLeave' }, 30, 'leave.approve'],
    ['admin_security_posture', 'Security posture', 'administration', { metric: 'securityPosture' }, 40, 'administration.security.view'],
    ['admin_recent_activity', 'Recent administration activity', 'administration', { metric: 'recentAudit' }, 50, 'administration.audit.view'],
  ];
  for (const [key, title, module, config, sort, permission] of widgets) {
    await pool.query(
      `INSERT INTO dashboard_widgets (tenant_id, widget_key, title, module, config, sort_order, required_permission, visible)
       VALUES (?,?,?,?,?,?,?,1)`, [T, key, title, module, j(config), sort, permission]
    );
  }

  // ---------- Security decisions the company has actually made ----------
  const policies = [
    ['audit.retention_days', 365],
    ['password.min_length', 12],
    ['session.idle_timeout_minutes', 45],
    ['mfa.required_for_admins', true],
  ];
  for (const [key, value] of policies) {
    await pool.query(
      `INSERT INTO security_policies (tenant_id, policy_key, policy_value, updated_by) VALUES (?,?,?,?)
       ON DUPLICATE KEY UPDATE policy_value = VALUES(policy_value), updated_by = VALUES(updated_by), updated_at = NOW()`,
      [T, key, j(value), hr]
    );
  }

  // ---------- One deliberate denial so the access screens show a real decision ----------
  const [auditor] = await pool.query(
    `SELECT u.id FROM users u WHERE u.email = 'auditor@arthvex.com'`, []
  );
  const [payrollPerm] = await pool.query(
    `SELECT id FROM permissions WHERE pkey = 'payroll.approve'`, []
  );
  if (auditor[0] && payrollPerm[0]) {
    await pool.query(
      `INSERT INTO user_direct_permissions (tenant_id, user_id, permission_id, effect, reason, granted_by)
       VALUES (?,?,?,'deny','Audit role is read-only across payroll',?)`, [T, auditor[0].id, payrollPerm[0].id, hr]
    );
  }

  console.log('[seed] administration center seeded (teams, positions, custom fields/forms, master data, workflow SLA, menus, widgets, policies).');

  await seedAdministrationAccess(T, ctx);
}

/**
 * The access/configuration half of the Administration Center.
 *
 * Seeded separately because it is the part an administrator actually reviews: who
 * can do what, which modules the company has switched on, what has been delegated
 * and by whom. Empty screens teach nothing; these rows are the realistic shapes
 * the screens have to cope with — multi-role users, a composed role built from
 * permission groups, a pending access request, a revoked invitation, a retired
 * module and a deliberately narrower permission.
 */
async function seedAdministrationAccess(T, ctx) {
  const { hr, mgr, deptHead, empIds, locations } = ctx;
  const j = (v) => JSON.stringify(v);
  const [locBlr, locPune] = locations;

  // ---------- Permission groups (system template → this company's copy) ----------
  const groupIds = {};
  for (const g of SYSTEM_PERMISSION_GROUPS) {
    const [ins] = await pool.query(
      `INSERT INTO permission_groups (tenant_id, code, name, description, is_system, status, created_by)
       VALUES (?,?,?,?,1,'active',?)`, [T, g.code, g.name, g.description, hr]
    );
    groupIds[g.code] = ins.insertId;
    const [perms] = await pool.query(
      'SELECT id, pkey FROM permissions WHERE pkey IN (?)', [g.permissions]
    );
    if (perms.length) {
      await pool.query(
        `INSERT IGNORE INTO permission_group_permissions (tenant_id, group_id, permission_id)
         VALUES ${perms.map(() => '(?,?,?)').join(', ')}`,
        perms.flatMap((p) => [T, ins.insertId, p.id])
      );
    }
  }

  // ---------- Custom roles, one of them composed out of groups ----------
  const customRoles = [
    {
      name: 'payroll_specialist', label: 'Payroll Specialist',
      description: 'Runs payroll but never approves a final pay run on their own.',
      permissions: ['payroll.view', 'payroll.create', 'payroll.edit', 'payroll.export', 'payroll.view_payslips'],
      groups: [],
    },
    {
      name: 'hr_ops', label: 'HR Operations',
      description: 'Day-to-day people operations without access to role design.',
      permissions: ['employee.view', 'employee.create', 'employee.edit', 'attendance.manage', 'leave.approve'],
      groups: ['employee_management', 'leave_management'],
    },
    {
      name: 'compliance_reviewer', label: 'Compliance Reviewer',
      description: 'Read-only across the record, plus the audit trail.',
      permissions: ['audit.view', 'administration.audit.view', 'settings.view'],
      groups: [],
    },
  ];
  const customRoleIds = {};
  for (const r of customRoles) {
    const [ins] = await pool.query(
      `INSERT INTO roles (tenant_id, name, label, description, permissions, is_system, role_type, is_custom, is_protected, status, created_by)
       VALUES (?,?,?,?,?,0,'custom',1,0,'active',?)`,
      [T, r.name, r.label, r.description, j(r.permissions), hr]
    );
    customRoleIds[r.name] = ins.insertId;
    const [perms] = await pool.query('SELECT id FROM permissions WHERE pkey IN (?)', [r.permissions]);
    if (perms.length) {
      await pool.query(
        `INSERT IGNORE INTO role_permissions (tenant_id, role_id, permission_id, granted_by)
         VALUES ${perms.map(() => '(?,?,?,?)').join(', ')}`,
        perms.flatMap((p) => [T, ins.insertId, p.id, hr])
      );
    }
    for (const code of r.groups) {
      await pool.query(
        `INSERT IGNORE INTO role_permission_groups (tenant_id, role_id, group_id, granted_by) VALUES (?,?,?,?)`,
        [T, ins.insertId, groupIds[code], hr]
      );
    }
  }

  // ---------- Real user → role assignments (multi-role, not just the legacy column) ----------
  const [usersByEmail] = await pool.query(
    `SELECT id, email FROM users WHERE tenant_id = ?`, [T]
  );
  const uid = (email) => (usersByEmail.find((u) => u.email === email) || {}).id;
  const [systemRoles] = await pool.query(
    'SELECT id, name FROM roles WHERE tenant_id = ?', [T]
  );
  const rid = (name) => (systemRoles.find((r) => r.name === name) || {}).id;

  const assignments = [
    // email, role, primary
    ['hr@arthvex.com', 'hr_admin', true],
    ['hr@arthvex.com', 'hr_ops', false],
    ['payroll@arthvex.com', 'payroll_admin', true],
    ['payroll@arthvex.com', 'payroll_specialist', false],
    ['finance@arthvex.com', 'finance_admin', true],
    ['manager@arthvex.com', 'manager', true],
    ['depthead@arthvex.com', 'department_head', true],
    ['recruiter@arthvex.com', 'recruiter', true],
    ['owner@arthvex.com', 'company_owner', true],
    ['auditor@arthvex.com', 'auditor', true],
    ['auditor@arthvex.com', 'compliance_reviewer', false],
  ];
  for (const [email, role, primary] of assignments) {
    const userId = uid(email);
    const roleId = rid(role);
    if (!userId || !roleId) continue;
    await pool.query(
      `INSERT IGNORE INTO user_roles (tenant_id, user_id, role_id, is_primary, assigned_by)
       VALUES (?,?,?,?,?)`, [T, userId, roleId, primary ? 1 : 0, hr]
    );
  }

  // ---------- Module configuration: what this company has actually switched on ----------
  // `travel`, `workforce_planning`, `integrations` and `ai_assistant` stay off so the
  // Modules screen has both states to show, and the ones that are off are the ones
  // whose routes 403 while off.
  const modulesOff = new Set(['travel', 'workforce_planning', 'integrations', 'ai_assistant']);
  for (const m of MODULE_CATALOG) {
    const enabled = !modulesOff.has(m.key);
    await pool.query(
      `INSERT INTO module_configurations (tenant_id, module_key, name, category, enabled, settings, updated_by)
       VALUES (?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE name = VALUES(name), category = VALUES(category),
         enabled = VALUES(enabled), settings = VALUES(settings), updated_by = VALUES(updated_by)`,
      [T, m.key, m.name, m.category, enabled ? 1 : 0, j({ seeded: true }), hr]
    );
  }

  // ---------- Feature flags layered on top of modules ----------
  // The catalog of flags is global; the company's choice of value is per tenant.
  const flags = [
    ['engagement_surveys', 'Engagement surveys', 'boolean', '1', true],
    ['expense_autopilot', 'Auto-approve expenses under a threshold', 'boolean', '0', false],
    ['payroll_cutoff_day', 'Payroll submission cutoff (day of month)', 'number', '24', true],
    ['support_email', 'Support contact shown on the login screen', 'string', 'hr@arthvex.com', false],
  ];
  // (flag ids are read back rather than trusted from insertId, which is 0 on update)
  const flagIds = {};
  for (const [key, name, type, defaultValue, core] of flags) {
    await pool.query(
      `INSERT INTO feature_flags (flag_key, name, description, value_type, default_value, is_core)
       VALUES (?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE name = VALUES(name), description = VALUES(description)`,
      [key, name, name, type, defaultValue, core ? 1 : 0]
    );
    const [[row]] = await pool.query('SELECT id FROM feature_flags WHERE flag_key = ?', [key]);
    flagIds[key] = row.id;
  }
  for (const [key, , type, value, enabled] of flags) {
    await pool.query(
      `INSERT INTO company_feature_flags (tenant_id, flag_key, enabled, value, updated_by)
       VALUES (?,?,?,?,?)
       ON DUPLICATE KEY UPDATE enabled = VALUES(enabled), value = VALUES(value), updated_by = VALUES(updated_by)`,
      [T, key, enabled ? 1 : 0, type === 'boolean' ? null : String(value), hr]
    );
  }

  // ---------- Reporting and dotted-line relationships ----------
  for (const t of SYSTEM_RELATIONSHIP_TYPES) {
    await pool.query(
      `INSERT INTO employee_relationship_types (tenant_id, code, name, description, is_primary_type, is_system, sort_order)
       VALUES (?,?,?,?,?,1,?)
       ON DUPLICATE KEY UPDATE name = VALUES(name), description = VALUES(description)`,
      [T, t.code, t.name, t.description, t.isPrimary ? 1 : 0, t.sortOrder]
    );
  }
  const [relTypes] = await pool.query('SELECT id, code FROM employee_relationship_types WHERE tenant_id = ?', [T]);
  const relTypeId = Object.fromEntries(relTypes.map((r) => [r.code, r.id]));
  const links = [
    // employee, related, type, primary
    [empIds[1].id, empIds[0].id, 'reporting_manager', true],
    [empIds[2].id, empIds[0].id, 'reporting_manager', true],
    [empIds[4].id, empIds[1].id, 'mentor', false],
    [empIds[6].id, empIds[2].id, 'buddy', false],
    [empIds[8].id, empIds[1].id, 'functional_manager', false],
    [empIds[10].id, empIds[3].id, 'reporting_manager', true],
  ];
  for (const [employeeId, relatedId, code, primary] of links) {
    if (!relTypeId[code]) continue;
    await pool.query(
      `INSERT INTO employee_relationships (tenant_id, employee_id, related_employee_id, relationship_type_id,
         effective_from, is_primary, notes)
       VALUES (?,?,?,?,CURDATE(),?,?)`,
      [T, employeeId, relatedId, relTypeId[code], primary ? 1 : 0,
        primary ? 'Solid-line reporting line' : 'Secondary reporting or support line']
    );
  }

  // ---------- Invitations: one waiting, one already used, one revoked ----------
  const invitations = [
    ['nikhil.rao@arthvex.com', 'Nikhil Rao', 'recruiter', 'pending'],
    ['sana.khan@arthvex.com', 'Sana Khan', 'employee', 'pending'],
    ['outdated.invite@arthvex.com', 'Outdated Invite', 'employee', 'revoked'],
  ];
  for (const [email, name, role, status] of invitations) {
    await pool.query(
      `INSERT INTO user_invitations (tenant_id, email, name, role_id, invited_by, token_hash, status, expires_at)
       VALUES (?,?,?,?,?,?,?, DATE_ADD(NOW(), INTERVAL 7 DAY))`,
      [T, email, name, rid(role), hr, crypto.createHash('sha256').update(`${email}:${slugSalt}`).digest('hex'), status]
    );
  }

  // ---------- Access requests: what self-service escalation looks like ----------
  const permId = async (pkey) => {
    const [row] = await pool.query('SELECT id FROM permissions WHERE pkey = ?', [pkey]);
    return row[0]?.id;
  };
  const employeeUser = uid('employee@arthvex.com');
  const requests = [
    [employeeUser, 'travel.view', 'I need to book travel for the Pune client visit', 'pending'],
    [employeeUser, 'expense.view', 'Finance asked me to reconcile last quarter', 'rejected'],
    [uid('manager@arthvex.com'), 'payroll.view', 'Reviewing team pay structure for a comp proposal', 'approved'],
  ];
  for (const [userId, pkey, reason, status] of requests) {
    if (!userId) continue;
    const pid = await permId(pkey);
    if (!pid) continue;
    await pool.query(
      `INSERT INTO access_requests (tenant_id, user_id, permission_id, permission_key, reason, status, decided_by, decided_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      [T, userId, pid, pkey, reason, status,
        status === 'pending' ? null : hr,
        status === 'pending' ? null : new Date()]
    );
  }

  // ---------- Network restrictions ----------
  const ips = [
    ['10.20.0.0/16', 'allow', 'all', 'Bengaluru office VPN range'],
    ['49.207.0.0/16', 'deny', 'admin', 'Blocked after an attempt from an unrecognised network'],
  ];
  for (const [cidr, scope, applies, note] of ips) {
    await pool.query(
      `INSERT INTO ip_restrictions (tenant_id, cidr, scope, applies_to, note, active, created_by)
       VALUES (?,?,?,?,?,1,?)
       ON DUPLICATE KEY UPDATE note = VALUES(note), active = 1`,
      [T, cidr, scope, applies, note, hr]
    );
  }

  // ---------- Configuration history: versions that can be rolled back to ----------
  const versions = [
    ['payroll', 'payroll', 1, 'archived', { cut_off_day: 20, proration: 'calendar' }, 'Original policy at go-live', '2024-04-01', '2024-09-30'],
    ['payroll', 'payroll', 2, 'expired', { cut_off_day: 22, proration: 'calendar' }, 'Cut-off moved with the pay cycle', '2024-10-01', '2025-03-31'],
    ['payroll', 'payroll', 3, 'active', { cut_off_day: 24, proration: 'working_days' }, 'Current: later cut-off, working-day proration', '2025-04-01', null],
    ['leave_policy', 'leave', 1, 'active', { annualCarryForward: 15, maxCarryForward: 30 }, 'Carry-forward capped at 30 days', null, null],
    ['attendance_policy', 'attendance', 1, 'active', { graceMinutes: 15, halfDayMinutes: 240, geoFence: false }, 'Geo-fencing left off for field staff', null, null],
  ];
  for (const [key, module, version, status, config, notes, from, to] of versions) {
    await pool.query(
      `INSERT INTO config_versions (tenant_id, config_key, module, version, status, config, notes,
         effective_from, effective_to, created_by, approved_by, published_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE status = VALUES(status), notes = VALUES(notes)`,
      [T, key, module, version, status, j(config), notes, from, to, hr,
        status === 'active' ? hr : null, status === 'active' ? new Date() : null]
    );
  }

  // ---------- Approval rules that are not tied to one workflow ----------
  const rules = [
    ['Expense claim over ₹25,000', 'Anything above ₹25,000 needs a second approver', 'expense',
      [{ field: 'amount', op: 'gt', value: 25000 }],
      [
        { name: 'Manager approval', approver: { type: 'role', value: 'manager' }, slaHours: 24, mandatory: true },
        { name: 'Finance approval', approver: { type: 'role', value: 'finance_admin' }, slaHours: 48, mandatory: true },
      ]],
    ['New starter access bundle', 'Every new joiner gets the standard employee bundle', 'employee',
      [{ field: 'event', op: 'eq', value: 'employee.created' }],
      [
        { name: 'Grant employee access', approver: { type: 'role', value: 'hr_admin' }, slaHours: 24, mandatory: true },
        { name: 'Notify IT', approver: { type: 'group', value: 'it-helpdesk' }, slaHours: 24, mandatory: false },
      ]],
  ];
  for (const [name, description, entity, conditions, steps] of rules) {
    await pool.query(
      `INSERT INTO workflow_approval_rules (tenant_id, name, description, entity_type, conditions, steps, is_system, status, created_by)
       VALUES (?,?,?,?,?,?,0,'active',?)`,
      [T, name, description, entity, j(conditions), j(steps), hr]
    );
  }

  // ---------- A second menu and widget that a reviewer would actually expect ----------
  const extraMenus = [
    ['administration.access', 'Access Review', 'key', '/administration/access', 'administration', 16, 'administration.access_preview.view'],
    ['administration.modules', 'Modules & Features', 'plug', '/administration/modules', 'administration', 17, 'administration.modules.view'],
    ['administration.masterdata', 'Master Data', 'database', '/administration/master-data', 'administration', 18, 'administration.master_data.view'],
    ['administration.tenants', 'Companies', 'building', '/administration/tenants', 'administration', 19, 'platform.tenants.view'],
  ];
  for (const [key, label, icon, route, parent, sort, permission] of extraMenus) {
    await pool.query(
      `INSERT INTO menu_items (tenant_id, menu_key, label, icon, parent_key, route, target, sort_order, required_permission, visible, is_system)
       VALUES (?,?,?,?,?,?, '_self', ?,?,1,0)`,
      [T, key, label, icon, parent, route, sort, permission]
    );
  }
  const extraWidgets = [
    ['admin_module_health', 'Module coverage', 'administration', { metric: 'moduleCoverage' }, 60, 'administration.modules.view'],
    ['admin_access_review', 'Access awaiting review', 'administration', { metric: 'pendingAccessRequests' }, 70, 'administration.access_requests.manage'],
  ];
  for (const [key, title, module, config, sort, permission] of extraWidgets) {
    await pool.query(
      `INSERT INTO dashboard_widgets (tenant_id, widget_key, title, module, config, sort_order, required_permission, visible)
       VALUES (?,?,?,?,?,?,?,1)`, [T, key, title, module, j(config), sort, permission]
    );
  }

  console.log('[seed] administration access seeded (permission groups, 3 custom roles, multi-role assignments, module configuration, feature flags, relationships, invitations, access requests, IP rules, config versions, approval rules).');
}

async function main() {
  console.log('[seed] starting…');
  const hash = await bcrypt.hash(PASSWORD, 10);

  await pool.query('SET FOREIGN_KEY_CHECKS = 0');
  const TABLES = ['tenants', 'roles', 'users', 'companies', 'locations', 'departments', 'designations', 'grades', 'cost_centers', 'shifts', 'holidays',
    'employees', 'employee_timeline', 'employee_salaries', 'attendance_records', 'attendance_regularizations', 'leave_types', 'leave_balances', 'leave_requests',
    'salary_components', 'salary_structures', 'salary_structure_items', 'payroll_runs', 'payroll_items', 'payslips', 'statutory_rules', 'tax_declarations',
    'expense_categories', 'expense_claims', 'loans', 'loan_installments', 'performance_cycles', 'goals', 'reviews', 'requisitions', 'candidates', 'interviews', 'offers',
    'assets', 'asset_assignments', 'tickets', 'ticket_comments', 'announcements', 'onboarding_tasks', 'separations', 'fnf_items', 'clearances',
    'customers', 'invoices', 'invoice_items', 'invoice_payments', 'notifications', 'settings', 'audit_logs', 'company_documents', 'letter_templates',
    // v2
    'legal_entities', 'business_units', 'job_levels', 'skills', 'employee_skills', 'career_paths', 'development_plans', 'talent_pools', 'talent_pool_members', 'succession_plans',
    'salary_bands', 'comp_cycles', 'comp_reviews', 'bonus_plans', 'bonus_awards', 'benefit_plans', 'benefit_enrollments',
    'surveys', 'survey_responses', 'polls', 'poll_votes', 'recognitions', 'suggestions',
    'hr_cases', 'hr_case_notes', 'disciplinary_actions', 'travel_requests', 'travel_advances', 'travel_bookings', 'travel_settlements',
    'headcount_plans', 'projects', 'project_members', 'timesheets', 'timesheet_entries', 'shift_swaps', 'comp_off_requests',
    'payroll_adjustments',
    'workflows', 'workflow_runs', 'workflow_tasks', 'approval_delegations', 'notification_templates',
    'webhook_subscriptions', 'webhook_deliveries', 'api_keys', 'integration_connections', 'idempotency_keys',
    'training_records', 'certifications', 'login_events', 'sso_configs', 'ai_conversations', 'referrals',
    // Administration Center content (RBAC catalog rows are owned by the migration)
    'user_direct_permissions', 'user_invitations', 'access_requests', 'security_policies', 'company_onboarding',
    'dashboard_widgets', 'menu_items', 'workflow_sla_rules', 'workflow_approval_rules',
    'custom_field_values', 'custom_field_options', 'custom_field_definitions',
    'custom_form_fields', 'custom_form_sections', 'custom_forms',
    'master_data_items', 'master_data_categories', 'team_members', 'teams', 'positions', 'employee_relationships',
    'employee_relationship_types', 'permission_group_permissions', 'permission_groups', 'role_permission_groups',
    'role_permissions', 'user_roles', 'module_configurations', 'company_feature_flags', 'feature_flags',
    'ip_restrictions', 'config_versions', 'workflow_versions', 'workflow_actions'];
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
  // Its roles row is created by migrate (tenant_id NULL, not tenant-scoped); the auth
  // middleware falls back to ROLE_DEFS anyway, so seeding standalone still works.
  await pool.query(`INSERT INTO users (tenant_id, email, password_hash, name, role, status) VALUES (NULL, 'super@arthvex.com', ?, 'Platform Admin', 'platform_super_admin', 'active')`, [hash]);

  // ---------- The administrator behind /admin ----------
  await ensureAdminUser(pool);

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

  // ================= v2 EXPANSION SEED =================

  // ---------- Org masters (v2) ----------
  await pool.query(`INSERT INTO legal_entities (tenant_id, name, code, entity_type, cin, pan, gstin, city, state) VALUES (?,?,?,?,?,?,?,?,?)`,
    [T, 'Arthvex Technologies Private Limited', 'ATPL', 'company', 'U72900KA2020PTC000000', 'AABCA1234F', '29ABCDE1234F1Z5', 'Bengaluru', 'Karnataka']);
  await pool.query(`INSERT INTO legal_entities (tenant_id, name, code, entity_type, pan, gstin, city, state) VALUES (?,?,?,?,?,?,?,?)`,
    [T, 'Arthvex Consulting LLP', 'ACL', 'llp', 'AAJCA9876B', '29AAJCA9876B1ZP', 'Pune', 'Maharashtra']);
  const [buEng] = await pool.query(`INSERT INTO business_units (tenant_id, name, code, head_employee_id) VALUES (?,?,?,?)`, [T, 'Product Engineering', 'BU-ENG', mgr.id]);
  await pool.query(`INSERT INTO business_units (tenant_id, name, code, head_employee_id) VALUES (?,?,?,?)`, [T, 'Enterprise Sales', 'BU-SALES', deptHead.id]);
  for (const [nm, lvl] of [['Individual Contributor', 1], ['Team Lead', 2], ['Manager', 3], ['Senior Manager', 4], ['Director', 5]]) {
    await pool.query(`INSERT INTO job_levels (tenant_id, name, level) VALUES (?,?,?)`, [T, nm, lvl]);
  }

  // ---------- Talent: skills matrix ----------
  const skillNames = [['JavaScript', 'Engineering'], ['Node.js', 'Engineering'], ['React', 'Engineering'], ['SQL', 'Engineering'], ['DevOps', 'Engineering'],
    ['Recruitment', 'HR'], ['HR Operations', 'HR'], ['Financial Analysis', 'Finance'], ['Sales Negotiation', 'Sales'], ['Project Management', 'Delivery']];
  const skillIds = {};
  for (const [nm, cat] of skillNames) {
    const [ins] = await pool.query(`INSERT INTO skills (tenant_id, name, category) VALUES (?,?,?)`, [T, nm, cat]);
    skillIds[nm] = ins.insertId;
  }
  const proficiencies = ['beginner', 'intermediate', 'advanced', 'expert'];
  for (let i = 0; i < empIds.length; i++) {
    const picks = [['JavaScript', 'Node.js', 'SQL'], ['JavaScript', 'React', 'SQL'], ['DevOps', 'SQL'], ['JavaScript', 'React'], ['Recruitment', 'HR Operations'], ['Sales Negotiation'], ['Financial Analysis', 'SQL'], ['Project Management']][i % 8];
    for (const s of picks) {
      await pool.query(`INSERT IGNORE INTO employee_skills (tenant_id, employee_id, skill_id, proficiency, years_experience, verified) VALUES (?,?,?,?,?,?)`,
        [T, empIds[i].id, skillIds[s], proficiencies[(i + s.length) % 4], 1 + ((i * 3) % 8), i % 2]);
    }
  }
  await pool.query(`INSERT INTO career_paths (tenant_id, name, track, from_designation_id, to_designation_id, steps, description) VALUES (?,?,?,?,?,?,?)`,
    [T, 'Engineering Track — Engineer to Architect', 'technical', desigIds['Software Engineer'], desigIds['Senior Software Engineer'],
      JSON.stringify([
        { order: 1, title: 'Software Engineer', competency: 'Core development, code reviews' },
        { order: 2, title: 'Senior Software Engineer', competency: 'System design, mentoring' },
        { order: 3, title: 'Principal / Architect', competency: 'Cross-team architecture, tech strategy' },
      ]), 'Growth path for engineering roles: depth in design and mentorship.']);
  await pool.query(`INSERT INTO development_plans (tenant_id, employee_id, title, description, mentor_id, start_date, target_date, progress, status) VALUES (?,?,?,?,?,?,?,?, 'active')`,
    [T, empIds[3].id, 'Backend specialization — distributed systems', 'Structured plan: MySQL performance, message queues, system design reviews.', mgr.id,
      dayjs().subtract(30, 'day').format('YYYY-MM-DD'), dayjs().add(90, 'day').format('YYYY-MM-DD'), 35]);
  await pool.query(`INSERT INTO development_plans (tenant_id, employee_id, title, mentor_id, start_date, target_date, progress, status) VALUES (?,?,?,?,?,?,?, 'active')`,
    [T, empIds[10].id, 'Sales leadership readiness', deptHead.id, dayjs().subtract(45, 'day').format('YYYY-MM-DD'), dayjs().add(120, 'day').format('YYYY-MM-DD'), 20]);
  const [poolHiPo] = await pool.query(`INSERT INTO talent_pools (tenant_id, name, description) VALUES (?,?,?)`,
    [T, 'High-Potential (HiPo) 2026', 'Top-quartile performers identified in the annual review.']);
  const [poolSales] = await pool.query(`INSERT INTO talent_pools (tenant_id, name, description) VALUES (?,?,?)`,
    [T, 'Sales leadership bench', 'Succession-ready sales managers.']);
  for (const [poolId, empIdx] of [[poolHiPo.insertId, 2], [poolHiPo.insertId, 3], [poolHiPo.insertId, 5], [poolSales.insertId, 10]]) {
    await pool.query(`INSERT INTO talent_pool_members (tenant_id, pool_id, employee_id, added_by) VALUES (?,?,?,1)`, [T, poolId, empIds[empIdx].id]);
  }
  await pool.query(`INSERT INTO succession_plans (tenant_id, position_title, employee_id, criticality, risk, successor_employee_id, readiness, development_actions) VALUES (?,?,?,?,?,?,?,?)`,
    [T, 'Engineering Manager — Engineering', mgr.id, 'critical', 'high', empIds[2].id, 'ready_1_2_years', 'Shadowing manager in sprint planning; leadership course enrollment.']);
  await pool.query(`INSERT INTO succession_plans (tenant_id, position_title, employee_id, criticality, risk, successor_employee_id, readiness, development_actions) VALUES (?,?,?,?,?,?,?,?)`,
    [T, 'Sales Head — Sales', deptHead.id, 'high', 'medium', empIds[10].id, 'ready_3_5_years', 'Regional exposure + mentorship from Kiran.']);
  await pool.query(`INSERT INTO succession_plans (tenant_id, position_title, employee_id, criticality, risk, readiness) VALUES (?,?,?,?,?,?)`,
    [T, 'HR Manager — Human Resources', hr.id, 'high', 'high', 'not_ready']);

  // ---------- Compensation ----------
  for (const [nm, grade, mn, mid, mx] of [['Band L1', 'L1', 350000, 500000, 700000], ['Band L2', 'L2', 700000, 1000000, 1400000], ['Band L3', 'L3', 1400000, 1900000, 2500000], ['Band L4', 'L4', 2400000, 3000000, 3800000], ['Band L5', 'L5', 3200000, 4000000, 5200000]]) {
    await pool.query(`INSERT INTO salary_bands (tenant_id, name, grade_id, min_amount, mid_amount, max_amount, effective_from) VALUES (?,?,?,?,?,?,?)`,
      [T, nm, gradeIds[grade], mn, mid, mx, `${YEAR}-04-01`]);
  }
  const [ccycle] = await pool.query(`INSERT INTO comp_cycles (tenant_id, name, cycle_year, effective_date, increment_budget_pct, status, created_by) VALUES (?,?,?,?,?, 'active', 1)`,
    [T, `Annual Increment ${YEAR}`, YEAR, `${YEAR}-07-01`, 10]);
  for (const [idx, pct, bonus, promo, just] of [[2, 12, 80000, 0, 'Consistently exceeded delivery goals'], [3, 15, 60000, 1, 'Promotion to Senior Engineer — expanded ownership'], [5, 10, 0, 0, 'Strong product launches'], [10, 14, 50000, 1, 'Top regional sales performer']]) {
    await pool.query(`INSERT INTO comp_reviews (tenant_id, cycle_id, employee_id, current_ctc, proposed_increment_pct, proposed_bonus, promotion_flag, new_designation_id, new_ctc, justification, status)
      VALUES (?,?,?,?,?,?,?,?,?,?,'pending')`,
      [T, ccycle.insertId, empIds[idx].id, empIds[idx].ctc, pct, bonus, promo, promo ? desigIds['Senior Software Engineer'] : null,
        Math.round(empIds[idx].ctc * (1 + pct / 100)), just]);
  }
  const [bplan] = await pool.query(`INSERT INTO bonus_plans (tenant_id, name, plan_year, btype, budget, status) VALUES (?,?,?,?,?, 'active')`,
    [T, `Performance Bonus ${YEAR}`, YEAR, 'performance', 1200000]);
  for (const [idx, amt, pct, reason] of [[1, 150000, 6.25, 'Exceeded team OKRs'], [2, 90000, 5.6, 'Rated outstanding'], [15, 120000, 3.75, 'Regional revenue target beat']]) {
    await pool.query(`INSERT INTO bonus_awards (tenant_id, plan_id, employee_id, amount, pct_of_ctc, reason, status) VALUES (?,?,?,?,?,?, 'proposed')`,
      [T, bplan.insertId, empIds[idx].id, amt, pct, reason]);
  }

  // ---------- Benefits ----------
  const [bpMed] = await pool.query(`INSERT INTO benefit_plans (tenant_id, name, btype, provider, description, eligibility, employer_cost, employee_cost, effective_from) VALUES (?,?,?,?,?,?,?,?,?)`,
    [T, 'Group Medical Insurance — Family Floater ₹5L', 'insurance', 'Star Health', 'Family floater policy covering employee, spouse, kids and dependent parents.',
      JSON.stringify({ employmentTypes: ['full_time'], minTenureMonths: 0 }), 12000, 0, `${YEAR}-04-01`]);
  const [bpTerm] = await pool.query(`INSERT INTO benefit_plans (tenant_id, name, btype, provider, description, eligibility, employer_cost, employee_cost, effective_from) VALUES (?,?,?,?,?,?,?,?,?)`,
    [T, 'Term Life Insurance — 3x CTC', 'insurance', 'LIC', 'Company-paid term life cover.', JSON.stringify({ employmentTypes: ['full_time'], minTenureMonths: 3 }), 4500, 0, `${YEAR}-04-01`]);
  await pool.query(`INSERT INTO benefit_plans (tenant_id, name, btype, provider, description, eligibility, employer_cost, employee_cost, effective_from) VALUES (?,?,?,?,?,?,?,?,?)`,
    [T, 'Meal Card Allowance', 'allowance', 'Sodexo', '₹1,100/month meal card.', JSON.stringify({}), 0, 1100, `${YEAR}-04-01`]);
  for (let i = 0; i < 10; i++) {
    await pool.query(`INSERT INTO benefit_enrollments (tenant_id, plan_id, employee_id, nominee_name, nominee_relation, coverage_details, enrolled_on) VALUES (?,?,?,?,?,?,?)`,
      [T, bpMed.insertId, empIds[i].id, ['Ramesh Sharma', 'Sunita Iyer', 'Bhavesh Patel', 'Kiran Reddy', 'Lakshmi Nair'][i % 5], 'spouse',
        JSON.stringify({ policyNo: `STAR-${YEAR}-${1000 + i}`, sumInsured: 500000 }), dayjs().subtract(150 - i, 'day').format('YYYY-MM-DD')]);
  }
  for (const i of [1, 2, 8]) {
    await pool.query(`INSERT INTO benefit_enrollments (tenant_id, plan_id, employee_id, nominee_name, nominee_relation, coverage_details, enrolled_on) VALUES (?,?,?,?,?,?,?)`,
      [T, bpTerm.insertId, empIds[i].id, 'Family', 'spouse', JSON.stringify({ policyNo: `LIC-${YEAR}-${200 + i}`, cover: empIds[i].ctc * 3 }), dayjs().subtract(120, 'day').format('YYYY-MM-DD')]);
  }

  // ---------- Engagement ----------
  const [survey] = await pool.query(
    `INSERT INTO surveys (tenant_id, title, description, stype, anonymity, questions, start_date, end_date, status, created_by)
     VALUES (?,?,?,?,?,?,?,?, 'active', 1)`,
    [T, 'Pulse Survey — Q3 Work Experience', 'A quick 3-question pulse. Takes under a minute.', 'pulse', 'anonymous',
      JSON.stringify([
        { id: 1, text: 'How satisfied are you with your current role?', type: 'rating' },
        { id: 2, text: 'Would you recommend Arthvex as a great place to work?', type: 'rating' },
        { id: 3, text: 'What is one thing we should improve next quarter?', type: 'text' },
      ]),
      dayjs().subtract(7, 'day').format('YYYY-MM-DD'), dayjs().add(14, 'day').format('YYYY-MM-DD')]
  );
  for (let i = 0; i < 6; i++) {
    await pool.query(`INSERT INTO survey_responses (tenant_id, survey_id, employee_id, answers) VALUES (?,?,NULL,?)`,
      [T, survey.insertId, JSON.stringify([
        { qid: 1, value: 3 + (i % 3) }, { qid: 2, value: 3 + ((i + 1) % 3) },
        { qid: 3, value: ['Better hybrid policy', 'Clearer career paths', 'More team outings', 'Upgraded laptops'][i % 4] },
      ])]);
  }
  const [poll] = await pool.query(`INSERT INTO polls (tenant_id, question, options, ends_at, status, created_by) VALUES (?,?,?,?,'active',1)`,
    [T, 'Preferred format for the next town hall?', JSON.stringify(['In-office + lunch', 'Fully virtual', 'Hybrid']), dayjs().add(5, 'day').format('YYYY-MM-DD HH:mm:ss')]);
  for (let i = 0; i < 5; i++) {
    await pool.query(`INSERT INTO poll_votes (tenant_id, poll_id, employee_id, option_index) VALUES (?,?,?,?)`, [T, poll.insertId, empIds[i].id, i % 3]);
  }
  const recog = [
    [hr.id, empIds[13].id, 'kudos', 10, 'Went above and beyond coordinating the wellness session!'],
    [mgr.id, empIds[2].id, 'badge', 25, 'Outstanding work shipping the billing service ahead of schedule.'],
    [empIds[2].id, empIds[3].id, 'kudos', 10, 'Thanks for the late-night deploy support!'],
    [deptHead.id, empIds[10].id, 'reward', 50, 'Quarterly top performer — Sales.'],
  ];
  for (const [from, to, rtype, points, msg] of recog) {
    await pool.query(`INSERT INTO recognitions (tenant_id, from_employee_id, to_employee_id, rtype, points, message) VALUES (?,?,?,?,?,?)`, [T, from, to, rtype, points, msg]);
  }
  await pool.query(`INSERT INTO suggestions (tenant_id, employee_id, category, subject, body, status) VALUES (?,?,?,?,?, 'reviewing')`,
    [T, empIds[4].id, 'facilities', 'Standing desks for the Pune office', 'A few of us would like standing desks — even two per floor would help.']);
  await pool.query(`INSERT INTO suggestions (tenant_id, employee_id, category, subject, body, status) VALUES (?,?,?,?,'','submitted')`,
    [T, null, 'policy', 'Allow flexible start times between 9 and 11', null]);

  // ---------- Employee Relations ----------
  const [hcase] = await pool.query(
    `INSERT INTO hr_cases (tenant_id, case_no, employee_id, raised_by, category, title, description, severity, status, assigned_to)
     VALUES (?,?,?,?,?,?,?,?, 'investigating', ?)`,
    [T, `HRC-${YEAR}-0001`, empIds[12].id, empIds[3].id, 'grievance', 'Workload imbalance within the team',
      'Team member reports recurring weekend work while others are unallocated. Requesting a review of sprint allocation.', 'medium', hr.id]);
  await pool.query(`INSERT INTO hr_case_notes (tenant_id, case_id, author_id, note, visibility) VALUES (?,?,?,?, 'internal')`,
    [T, hcase.insertId, hr.id, 'Spoke with the team lead — sprint allocation review scheduled for next week.']);
  await pool.query(`INSERT INTO hr_case_notes (tenant_id, case_id, author_id, note, visibility) VALUES (?,?,?,?, 'hr_only')`,
    [T, hcase.insertId, hr.id, 'Confidential: compensation context may be a factor — handle sensitively.']);
  await pool.query(`INSERT INTO disciplinary_actions (tenant_id, case_id, employee_id, action_type, reason, issued_by, issued_on) VALUES (?,?,?,?,?,?,?)`,
    [T, null, empIds[7].id, 'written_warning', 'Repeated late arrivals after prior verbal discussion.', hr.id, dayjs().subtract(20, 'day').format('YYYY-MM-DD')]);

  // ---------- Travel ----------
  const [tr1] = await pool.query(
    `INSERT INTO travel_requests (tenant_id, trno, employee_id, purpose, destination, start_date, end_date, estimated_cost, travel_mode, status, approver_id, actioned_at)
     VALUES (?,?,?,?,?,?,?,?, 'flight', 'approved', ?, NOW())`,
    [T, `TRV-${YEAR}-0001`, empIds[10].id, 'Client visit — Zenith Retail quarterly review', 'Pune',
      dayjs().add(6, 'day').format('YYYY-MM-DD'), dayjs().add(8, 'day').format('YYYY-MM-DD'), 18000, deptHead.id]);
  await pool.query(`INSERT INTO travel_advances (tenant_id, request_id, employee_id, amount, issued_on, status) VALUES (?,?,?,?,?, 'issued')`,
    [T, tr1.insertId, empIds[10].id, 10000, dayjs().subtract(1, 'day').format('YYYY-MM-DD')]);
  await pool.query(`INSERT INTO travel_bookings (tenant_id, request_id, mode, provider, reference, booked_on, amount) VALUES (?,?,?,?,?,?,?)`,
    [T, tr1.insertId, 'flight', 'IndiGo', 'PNQ-BLR-99821', dayjs().format('YYYY-MM-DD'), 8450]);
  const [tr2] = await pool.query(
    `INSERT INTO travel_requests (tenant_id, trno, employee_id, purpose, destination, start_date, end_date, estimated_cost, travel_mode, status)
     VALUES (?,?,?,?,?,?,?,?, 'train', 'pending')`,
    [T, `TRV-${YEAR}-0002`, empIds[11].id, 'Vendor audit — logistics partner', 'Mumbai',
      dayjs().add(12, 'day').format('YYYY-MM-DD'), dayjs().add(13, 'day').format('YYYY-MM-DD'), 9000]);
  await pool.query(`INSERT INTO travel_advances (tenant_id, request_id, employee_id, amount, status) VALUES (?,?,?,?, 'requested')`,
    [T, tr2.insertId, empIds[11].id, 5000]);

  // ---------- Workforce planning ----------
  const deptList = Object.entries(deptIds);
  const planned = { Engineering: 10, Product: 3, Sales: 4, Operations: 2, Finance: 2, 'Human Resources': 2 };
  for (const [deptName, deptId] of deptList) {
    for (const q of [1, 2, 3, 4]) {
      await pool.query(`INSERT INTO headcount_plans (tenant_id, plan_year, quarter, department_id, planned_count, budget_ctc, scenario) VALUES (?,?,?,?,?,?,'base')`,
        [T, YEAR, q, deptId, planned[deptName] || 2, (planned[deptName] || 2) * 1200000]);
    }
  }

  // ---------- Timesheets ----------
  // Bill/cost rates drive project billing analytics, so seed them alongside the projects.
  const [projCore] = await pool.query(
    `INSERT INTO projects (tenant_id, name, code, client, billable, bill_rate, cost_rate)
     VALUES (?,?,?,?,1, 1800, 900)`, [T, 'HRMS Platform', 'PRJ-HRMS', 'Internal']);
  const [projZen] = await pool.query(
    `INSERT INTO projects (tenant_id, name, code, client, billable, bill_rate, cost_rate)
     VALUES (?,?,?,?,1, 2500, 1100)`, [T, 'Zenith Retail Implementation', 'PRJ-ZEN', 'Zenith Retail']);
  const [projRnd] = await pool.query(
    `INSERT INTO projects (tenant_id, name, code, client, billable, bill_rate, cost_rate)
     VALUES (?,?,?,NULL,0, 0, 800)`, [T, 'Internal R&D', 'PRJ-RND']);
  // Internal R&D is the default sink for non-billable time, so mark it as such.
  await pool.query('UPDATE projects SET default_project = 1 WHERE id = ?', [projRnd.insertId]);

  const monday = dayjs().startOf('week').add(1, 'day'); // this week's Monday
  for (const idx of [3, 2]) {
    const entries = [];
    for (let d = 0; d < 5; d++) {
      const date = monday.add(d, 'day').format('YYYY-MM-DD');
      entries.push({ date, project_id: projCore.insertId, hours: 5, task: 'Feature development', billable: false });
      entries.push({ date, project_id: projZen.insertId, hours: 3, task: 'Client integration work', billable: true });
    }
    const billable = entries.filter((e) => e.billable).reduce((s, e) => s + e.hours, 0);
    const [sheet] = await pool.query(
      `INSERT INTO timesheets (tenant_id, employee_id, week_start, entries, total_hours, billable_hours, non_billable_hours, status)
       VALUES (?,?,?,?,?,?,?, 'submitted')`,
      [T, empIds[idx].id, monday.format('YYYY-MM-DD'), JSON.stringify([]), 40, billable, 40 - billable]
    );
    // timesheet_entries is the source of truth; the legacy JSON mirror above stays empty.
    for (const e of entries) {
      await pool.query(
        `INSERT INTO timesheet_entries (tenant_id, timesheet_id, employee_id, entry_date, project_id, hours, task, billable, source)
         VALUES (?,?,?,?,?,?,?,?, 'manual')`,
        [T, sheet.insertId, empIds[idx].id, e.date, e.project_id, e.hours, e.task, e.billable ? 1 : 0]
      );
    }
    // Project membership drives allocation validation in the timesheet service.
    await pool.query(
      `INSERT INTO project_members (tenant_id, project_id, employee_id, allocation_pct, from_date, active)
       VALUES (?,?,?,?,?,1),(?,?,?,?,?,1)`,
      [T, projCore.insertId, empIds[idx].id, 60, monday.format('YYYY-MM-DD'),
       T, projZen.insertId, empIds[idx].id, 40, monday.format('YYYY-MM-DD')]
    );
  }

  // ---------- Demo payroll adjustment (arrears awaiting approval) ----------
  await pool.query(
    `INSERT INTO payroll_adjustments (tenant_id, employee_id, atype, direction, component, description, amount,
       for_period_year, for_period_month, source_type, status, reason, requested_by, requested_at)
     VALUES (?,?, 'arrears', 'earning', 'Arrears Salary', 'Unpaid salary revision — Aug 2026', 18500, ?, ?, 'manual', 'submitted', 'Pending board approval', 1, NOW())`,
    [T, empIds[3].id, YEAR, Math.max(1, dayjs().month() + 1)]
  );

  // ---------- Workflow engine ----------
  const [wfLeave] = await pool.query(
    `INSERT INTO workflows (tenant_id, name, trigger_event, entity_type, conditions, steps, active, created_by)
     VALUES (?,?,?,?,?,?,1,1)`,
    [T, 'Leave approval — Manager → HR', 'leave.submitted', 'leave_request',
      JSON.stringify([{ field: 'days', op: 'gte', value: 3 }]),
      JSON.stringify([
        { name: 'Manager approval', assignee: { type: 'manager' }, slaHours: 24 },
        { name: 'HR confirmation', assignee: { type: 'role', value: 'hr_admin' }, slaHours: 48 },
      ])]
  );
  await pool.query(
    `INSERT INTO workflows (tenant_id, name, trigger_event, entity_type, conditions, steps, active, created_by) VALUES (?,?,?,?,?,?,1,1)`,
    [T, 'Travel expense approval', 'travel.submitted', 'travel_request', null,
      JSON.stringify([{ name: 'Manager approval', assignee: { type: 'manager' }, slaHours: 24 }])]
  );
  // a sample run awaiting the manager
  const [wfrun] = await pool.query(
    `INSERT INTO workflow_runs (tenant_id, workflow_id, entity_type, entity_id, context, status, current_step) VALUES (?,?,?,?,?, 'running', 'Manager approval')`,
    [T, wfLeave.insertId, 'leave_request', 1, JSON.stringify({ employeeId: empIds[3].id, days: 3, sample: true })]
  );
  await pool.query(
    `INSERT INTO workflow_tasks (tenant_id, run_id, step_name, assignee_user_id, sla_hours, due_at) VALUES (?,?,?,?,24, DATE_ADD(NOW(), INTERVAL 24 HOUR))`,
    [T, wfrun.insertId, 'Manager approval', 2]
  );
  await pool.query(
    `INSERT INTO approval_delegations (tenant_id, from_user_id, to_user_id, base_permission, starts_on, ends_on, active) VALUES (?,?,?,?,?,?,1)`,
    [T, 3, 2, 'leave.approve', dayjs().format('YYYY-MM-DD'), dayjs().add(3, 'day').format('YYYY-MM-DD')]
  );

  // ---------- Integrations & LMS ----------
  await pool.query(
    `INSERT INTO webhook_subscriptions (tenant_id, url, secret, events, created_by) VALUES (?,?,?,?,1)`,
    [T, 'https://webhook.site/demo-arthvex-hrms', 'whsec_demo_signing_secret_2026',
      JSON.stringify(['employee.created', 'employee.exited', 'lms.course_completed', 'travel.approved'])]
  );
  await pool.query(
    `INSERT INTO integration_connections (tenant_id, itype, name, config, status) VALUES (?,?,?,?, 'connected')`,
    [T, 'lms', 'Arthvex LMS (standalone)', JSON.stringify({ baseUrl: 'https://lms.arthvex.example', protocol: 'rest+sso', externalEmployeeIdField: 'external_employee_id' })]
  );
  await pool.query(
    `INSERT INTO integration_connections (tenant_id, itype, name, config, status) VALUES (?,?,?,?, 'connected')`,
    [T, 'biometric', 'ZKTeco device — Bengaluru HQ', JSON.stringify({ deviceKey: 'demo-device-key-2026', pushEndpoint: '/api/attendance/device-punch' })]
  );
  await pool.query(
    `INSERT INTO integration_connections (tenant_id, itype, name, config, status) VALUES (?,?,?,?, 'disabled')`,
    [T, 'accounting', 'Tally export (F&F + reimbursements)', JSON.stringify({ format: 'csv-vouchers' })]
  );
  // deterministic demo API key (documented in FEATURES.md)
  const DEMO_KEY = 'akv1_arthvex_demo_key_2026_lms_sync_0001';
  await pool.query(
    `INSERT INTO api_keys (tenant_id, name, key_prefix, key_hash, scopes, created_by) VALUES (?,?,?,?,?,1)`,
    [T, 'Arthvex LMS integration (demo)', DEMO_KEY.slice(0, 12), sha256Key(DEMO_KEY),
      JSON.stringify(['employee.read', 'employee.write', 'lms.sync', 'webhooks.manage'])]
  );
  // LMS → HRMS: training records + certifications
  for (const [idx, course, hrs, date] of [[3, 'Security Awareness 101', 2, 12], [3, 'Python for Data Analysis', 6, 40], [2, 'Leadership Foundations', 8, 25], [12, 'Anti-harassment (POSH) Training', 1, 18]]) {
    await pool.query(
      `INSERT INTO training_records (tenant_id, employee_id, external_employee_id, course_name, provider, completed_on, learning_hours, source)
       VALUES (?,?,?,?,?,?,?, 'lms')`,
      [T, empIds[idx].id, empIds[idx].code, course, 'Arthvex LMS', dayjs().subtract(date, 'day').format('YYYY-MM-DD'), hrs]
    );
  }
  await pool.query(
    `INSERT INTO certifications (tenant_id, employee_id, name, issued_by, issued_on, expires_on, credential_id, verified) VALUES (?,?,?,?,?,?,?,1)`,
    [T, empIds[2].id, 'AWS Certified Solutions Architect', 'Amazon Web Services', dayjs().subtract(300, 'day').format('YYYY-MM-DD'), dayjs().add(45, 'day').format('YYYY-MM-DD'), 'AWS-SAA-2025-8812']
  );
  await pool.query(
    `INSERT INTO certifications (tenant_id, employee_id, name, issued_by, issued_on, expires_on, verified) VALUES (?,?,?,?,?,?,1)`,
    [T, empIds[6].id, 'Certified Kubernetes Administrator', 'CNCF', dayjs().subtract(500, 'day').format('YYYY-MM-DD'), dayjs().add(20, 'day').format('YYYY-MM-DD')]
  );

  // ---------- Referrals ----------
  await pool.query(`INSERT INTO referrals (tenant_id, employee_id, candidate_name, candidate_email, status, notes) VALUES (?,?,?,?, 'in_process', 'Resume forwarded to recruiter')`,
    [T, empIds[5].id, 'Suresh Kamath', 'suresh.kamath@example.com']);
  await pool.query(`INSERT INTO referrals (tenant_id, employee_id, candidate_name, candidate_email, status, reward_amount) VALUES (?,?,?,?, 'rewarded', 15000)`,
    [T, empIds[4].id, 'Neha Singh', 'neha.singh@example.com']);

  // ---------- Login events ----------
  await pool.query(
    `INSERT INTO login_events (tenant_id, user_id, email, event, ip, user_agent, details, created_at) VALUES
     (?,?, 'hr@arthvex.com', 'login', '10.0.14.22', 'Mozilla/5.0 (X11; Linux x86_64)', NULL, DATE_SUB(NOW(), INTERVAL 2 HOUR)),
     (?,?, 'manager@arthvex.com', 'login', '10.0.14.31', 'Mozilla/5.0 (Windows NT 10.0)', NULL, DATE_SUB(NOW(), INTERVAL 5 HOUR)),
     (NULL, NULL, 'unknown@arthvex.com', 'login_failed', '203.0.113.55', 'curl/8.4.0', '3rd failed attempt', DATE_SUB(NOW(), INTERVAL 26 HOUR)),
     (?, NULL, 'manager@arthvex.com', 'suspicious', '198.51.100.7', 'Mozilla/5.0 (Macintosh)', '5 failed attempts in 15 min', DATE_SUB(NOW(), INTERVAL 50 HOUR))`,
    [T, 3, T, 4, T, 2]
  );

  // ---------- Notification templates (one custom override as demo) ----------
  await pool.query(
    `INSERT INTO notification_templates (tenant_id, event_key, channel, subject, body, locale) VALUES (?,?,?,?,?, 'en')`,
    [T, 'leave.actioned', 'email', 'Your {{leaveTypeName}} request was {{status}}',
      'Hello {{employeeName}},\n\nYour {{leaveTypeName}} request ({{startDate}} to {{endDate}}, {{days}} day(s)) was {{status}}.\nComment: {{comment}}\n\n— {{companyName}} HR']
  );

  console.log('[seed] v2 modules seeded (talent, engagement, relations, travel, comp, benefits, workforce, timesheets, workflows, integrations, LMS, security).');

  await seedAdministrationCenter(T, {
    hr: hr.id,
    mgr: mgr.id,
    deptHead: deptHead.id,
    empIds,
    deptIds,
    desigIds,
    gradeIds,
    locations: [locBlr.insertId, locPune.insertId],
  });

  console.log('[seed] done.');
  console.log(`  Administration console → http://localhost:5173/admin  (${ADMIN_EMAIL} | ${ADMIN_PASSWORD})`);
  console.log('  Logins (password: Password@123):');
  console.log('   super@arthvex.com | owner@arthvex.com | hr@arthvex.com | payroll@arthvex.com | finance@arthvex.com');
  console.log('   manager@arthvex.com | depthead@arthvex.com | recruiter@arthvex.com');
  console.log('   employee@arthvex.com (Diya Patel) | auditor@arthvex.com');
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
