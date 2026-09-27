// Central permission catalogue: module.action[:scope]
// Scopes: own | team | department | location | company | tenant

const PERMISSIONS = [
  // Dashboard
  'dashboard.view',
  // Employees
  'employee.view:own', 'employee.view:team', 'employee.view:department', 'employee.view:company',
  'employee.create', 'employee.edit', 'employee.edit:team', 'employee.edit:department', 'employee.delete',
  'employee.import', 'employee.view_sensitive', 'employee.edit_sensitive',
  // Organization & master data
  'org.view', 'org.manage',
  // Attendance
  'attendance.view:own', 'attendance.view:team', 'attendance.view:department', 'attendance.view:company',
  'attendance.punch', 'attendance.regularize', 'attendance.approve',
  'attendance.manage', 'attendance.import', 'attendance.lock',
  // Leave
  'leave.view:own', 'leave.view:team', 'leave.view:department', 'leave.view:company',
  'leave.apply', 'leave.approve', 'leave.configure', 'leave.override',
  // Payroll & statutory
  'payroll.view', 'payroll.view_sensitive', 'payroll.configure',
  'payroll.calculate', 'payroll.submit', 'payroll.approve', 'payroll.lock', 'payroll.pay',
  'statutory.manage', 'tax.view', 'tax.manage',
  // Expenses & loans
  'expense.view:own', 'expense.view:team', 'expense.view:department', 'expense.view:company',
  'expense.create', 'expense.approve', 'expense.configure', 'expense.reimburse',
  'loan.view:own', 'loan.view:company', 'loan.manage',
  // Documents & letters
  'document.view:own', 'document.view:company', 'document.manage', 'letter.generate',
  // Performance
  'performance.view', 'performance.view:department', 'performance.manage', 'performance.review',
  // Recruitment
  'recruitment.view', 'recruitment.manage',
  // Assets
  'asset.view', 'asset.manage',
  // Helpdesk
  'ticket.view:own', 'ticket.view:company', 'ticket.create', 'ticket.handle',
  // Announcements
  'announcement.view', 'announcement.manage',
  // Lifecycle
  'onboarding.view', 'onboarding.manage', 'separation.view', 'separation.approve', 'separation.manage',
  // Billing
  'billing.view', 'billing.manage',
  // Reports & audit & settings
  'report.view', 'report.export', 'audit.view', 'settings.view', 'settings.manage',
  'user.manage', 'role.manage', 'tenant.manage',
];

// Highest scope wins per base permission (module.action).
function allowedScopes(perms, base) {
  const scopes = new Set();
  for (const p of perms) {
    if (p === base) { scopes.add('company'); continue; } // bare = company-level
    if (p.startsWith(base + ':')) scopes.add(p.slice(base.length + 1));
  }
  const order = ['own', 'team', 'department', 'location', 'company', 'tenant'];
  return order.filter((s) => scopes.has(s));
}

function hasPerm(perms, perm) {
  if (!perm) return false;
  if (perms.includes(perm)) return true;
  const [base, scope] = perm.split(':');
  if (scope) return perms.includes(base); // explicit scope satisfied by unscoped grant
  return perms.some((p) => p === base || p.startsWith(base + ':')); // bare perm satisfied by any scope
}

const ROLE_DEFS = {
  platform_super_admin: {
    label: 'Platform Super Admin',
    tenantScoped: false,
    permissions: PERMISSIONS.filter((p) => p !== 'dashboard.view'),
  },
  company_owner: {
    label: 'Company Owner',
    permissions: PERMISSIONS.filter((p) => p !== 'tenant.manage'),
  },
  hr_admin: {
    label: 'HR Admin',
    permissions: [
      'dashboard.view', 'employee.view:company', 'employee.create', 'employee.edit', 'employee.delete',
      'employee.import', 'employee.view_sensitive', 'employee.edit_sensitive', 'org.view', 'org.manage',
      'attendance.view:company', 'attendance.approve', 'attendance.manage', 'attendance.import', 'attendance.lock',
      'leave.view:company', 'leave.approve', 'leave.configure', 'leave.override',
      'payroll.view', 'expense.view:company', 'expense.approve', 'expense.configure',
      'loan.view:company', 'loan.manage', 'document.view:company', 'document.manage', 'letter.generate',
      'performance.view', 'performance.manage', 'recruitment.view', 'recruitment.manage',
      'asset.view', 'asset.manage', 'ticket.view:company', 'ticket.handle', 'announcement.view', 'announcement.manage',
      'onboarding.view', 'onboarding.manage', 'separation.view', 'separation.approve', 'separation.manage',
      'report.view', 'report.export', 'settings.view', 'tax.view',
    ],
  },
  payroll_admin: {
    label: 'Payroll Admin',
    permissions: [
      'dashboard.view', 'employee.view:company', 'employee.view_sensitive',
      'attendance.view:company', 'attendance.lock', 'attendance.import',
      'payroll.view', 'payroll.view_sensitive', 'payroll.configure', 'payroll.calculate',
      'payroll.submit', 'payroll.approve', 'payroll.lock', 'payroll.pay',
      'statutory.manage', 'tax.view', 'tax.manage', 'loan.view:company', 'loan.manage',
      'expense.view:company', 'expense.reimburse', 'report.view', 'report.export', 'settings.view',
    ],
  },
  finance_admin: {
    label: 'Finance/Admin',
    permissions: [
      'dashboard.view', 'billing.view', 'billing.manage', 'payroll.view', 'payroll.view_sensitive',
      'expense.view:company', 'expense.reimburse', 'loan.view:company',
      'report.view', 'report.export', 'settings.view', 'ticket.view:company', 'ticket.handle',
    ],
  },
  manager: {
    label: 'Manager',
    permissions: [
      'dashboard.view', 'employee.view:team', 'employee.edit:team',
      'attendance.view:team', 'attendance.approve', 'leave.view:team', 'leave.approve',
      'expense.view:team', 'expense.approve', 'performance.view', 'performance.manage', 'performance.review',
      'recruitment.view', 'recruitment.manage', 'ticket.view:company', 'announcement.view',
      'onboarding.view', 'separation.view', 'separation.approve', 'report.view',
      'attendance.view:own', 'attendance.punch', 'attendance.regularize',
      'leave.view:own', 'leave.apply', 'expense.create', 'ticket.create',
      'document.view:own', 'document.view:company',
    ],
  },
  recruiter: {
    label: 'Recruiter',
    permissions: [
      'dashboard.view', 'recruitment.view', 'recruitment.manage',
      'employee.view:company', 'announcement.view',
      'attendance.view:own', 'attendance.punch', 'attendance.regularize',
      'leave.view:own', 'leave.apply', 'expense.view:own', 'expense.create',
      'loan.view:own', 'ticket.view:own', 'ticket.create',
      'document.view:own', 'performance.view',
    ],
  },
  department_head: {
    label: 'Department Head',
    permissions: [
      'dashboard.view', 'employee.view:department', 'employee.edit:department',
      'attendance.view:department', 'attendance.approve',
      'leave.view:department', 'leave.approve',
      'expense.view:department', 'expense.approve',
      'performance.view:department', 'performance.manage', 'performance.review',
      'onboarding.view', 'separation.view', 'separation.approve',
      'asset.view', 'announcement.view', 'report.view',
      'attendance.view:own', 'attendance.punch', 'attendance.regularize',
      'leave.view:own', 'leave.apply', 'expense.create',
      'ticket.view:company', 'ticket.create',
      'document.view:own', 'document.view:company',
    ],
  },
  employee: {
    label: 'Employee',
    permissions: [
      'attendance.view:own', 'attendance.punch', 'attendance.regularize',
      'leave.view:own', 'leave.apply', 'expense.view:own', 'expense.create',
      'loan.view:own', 'ticket.view:own', 'ticket.create', 'announcement.view',
      'document.view:own', 'performance.view', 'report.view',
    ],
  },
  auditor: {
    label: 'Auditor (Read Only)',
    permissions: [
      'dashboard.view', 'employee.view:company', 'attendance.view:company', 'leave.view:company',
      'payroll.view', 'expense.view:company', 'billing.view', 'report.view', 'audit.view',
      'document.view:company', 'asset.view', 'loan.view:company',
    ],
  },
};

const DEFAULT_ROLES = ['company_owner', 'hr_admin', 'payroll_admin', 'finance_admin', 'manager', 'recruiter', 'department_head', 'employee', 'auditor'];

module.exports = { PERMISSIONS, ROLE_DEFS, DEFAULT_ROLES, hasPerm, allowedScopes };
