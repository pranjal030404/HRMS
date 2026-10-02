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
  'payroll.adjust', 'payroll.adjust_approve',
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
  // Career & Talent (skills, career paths, development plans, talent pools, succession)
  'talent.view', 'talent.manage',
  // Engagement (surveys, polls, recognition, suggestions)
  'engagement.view', 'engagement.manage', 'engagement.respond',
  // Employee relations (grievances, disciplinary)
  'relations.view', 'relations.manage',
  // Travel
  'travel.view:own', 'travel.view:team', 'travel.view:company',
  'travel.create', 'travel.approve', 'travel.manage',
  // Compensation & benefits
  'compensation.view', 'compensation.manage',
  'benefit.view', 'benefit.manage',
  'bonus.view', 'bonus.manage',
  // Workforce planning & people analytics
  'workforce.view', 'workforce.manage', 'analytics.view',
  // Workflow & automation
  'workflow.view', 'workflow.manage', 'workflow.action',
  // Timesheets
  'timesheet.view:own', 'timesheet.view:team', 'timesheet.view:company',
  'timesheet.create', 'timesheet.approve', 'timesheet.manage',
  // Integrations & API platform
  'integration.manage', 'lms.sync',
  // Notification center
  'notification.manage',
  // Lifecycle
  'onboarding.view', 'onboarding.manage', 'separation.view', 'separation.approve', 'separation.manage',
  // Billing
  'billing.view', 'billing.manage',
  // Reports & audit & settings
  'report.view', 'report.export', 'audit.view', 'settings.view', 'settings.manage',
  'user.manage', 'role.manage', 'tenant.manage',

  // ---------- Administration Center ----------
  // Namespace: administration.<area>.<action>. Aliased to the legacy flat keys so
  // existing routes and roles keep working (see PERMISSION_ALIASES).
  'administration.view',
  'administration.dashboard.view',
  'administration.organization.view', 'administration.organization.manage',
  'administration.business_units.manage', 'administration.teams.manage',
  'administration.designations.manage', 'administration.grades.manage',
  'administration.locations.manage', 'administration.cost_centers.manage',
  'administration.positions.manage',
  'administration.users.view', 'administration.users.manage', 'administration.users.invite',
  'administration.users.status', 'administration.users.sessions',
  'administration.roles.view', 'administration.roles.manage', 'administration.roles.clone',
  'administration.permissions.view', 'administration.permissions.manage',
  'administration.permission_groups.manage',
  'administration.workflows.view', 'administration.workflows.manage', 'administration.workflows.publish',
  'administration.workflows.approve',
  'administration.approval_rules.manage',
  'administration.master_data.view', 'administration.master_data.manage',
  'administration.custom_fields.view', 'administration.custom_fields.manage',
  'administration.forms.view', 'administration.forms.manage',
  'administration.menu.manage', 'administration.dashboard_builder.manage',
  'administration.modules.view', 'administration.modules.manage',
  'administration.notifications.manage',
  'administration.security.view', 'administration.security.manage',
  'administration.security_policies.view', 'administration.security_policies.manage',
  'administration.security.sessions.view', 'administration.security.sessions.manage',
  'administration.security.login_history.view', 'administration.security.mfa.manage',
  'administration.security.ip_restrictions.manage',
  'administration.audit.view', 'administration.audit.export',
  'administration.integrations.api_keys.manage', 'administration.integrations.webhooks.manage',
  'administration.bulk.manage', 'administration.import.manage', 'administration.export.manage',
  'administration.onboarding.view', 'administration.onboarding.manage',
  'administration.config.view', 'administration.config.manage',
  'administration.access.view', 'administration.access.manage',
  'administration.access_requests.view', 'administration.access_requests.manage',
  'administration.access_preview.view', 'administration.access_debug.view',
  // ---------- Platform (above tenant) ----------
  'platform.tenants.view', 'platform.tenants.manage', 'platform.tenants.delete',
  'platform.tenants.impersonate', 'platform.plans.manage',
  'platform.feature_flags.manage', 'platform.settings.manage',
  'platform.audit.view', 'platform.stats.view', 'platform.integrations.manage',
];

/**
 * Scope lattice. Highest rank wins when several grants of the same base
 * permission reach one user, and every rank is comparable so the matrix UI and
 * the API agree on what "wider" means.
 */
const SCOPES = ['own', 'team', 'department', 'business_unit', 'location', 'company', 'platform'];
const SCOPE_RANK = Object.fromEntries(SCOPES.map((s, i) => [s, i]));

/** Base permissions that accept a `:scope` suffix, with the scopes offered. */
const SCOPEABLE_BASES = {
  'employee.view': ['own', 'team', 'department', 'company'],
  'employee.edit': ['own', 'team', 'department', 'company'],
  'attendance.view': ['own', 'team', 'department', 'company'],
  'leave.view': ['own', 'team', 'department', 'company'],
  'expense.view': ['own', 'team', 'department', 'company'],
  'travel.view': ['own', 'team', 'department', 'company'],
  'timesheet.view': ['own', 'team', 'department', 'company'],
  'document.view': ['own', 'team', 'department', 'company'],
  'ticket.view': ['own', 'team', 'department', 'company'],
  'report.view': ['department', 'company'],
  'user.view': ['own', 'team', 'department', 'company'],
  'workflow.view': ['own', 'team', 'department', 'company'],
};

const MODULE_LABELS = {
  dashboard: 'Dashboard', employee: 'Employee', org: 'Organization', organization: 'Organization',
  attendance: 'Attendance', leave: 'Leave', payroll: 'Payroll', statutory: 'Statutory', tax: 'Tax',
  expense: 'Expense', loan: 'Loan', document: 'Document', performance: 'Performance',
  recruitment: 'Recruitment', asset: 'Asset', ticket: 'Helpdesk', announcement: 'Announcement',
  talent: 'Talent', engagement: 'Engagement', relations: 'Employee Relations', travel: 'Travel',
  compensation: 'Compensation', benefit: 'Benefit', bonus: 'Bonus', workforce: 'Workforce Planning',
  analytics: 'People Analytics', workflow: 'Workflow', timesheet: 'Timesheet', integration: 'Integrations',
  notification: 'Notifications', onboarding: 'Onboarding', separation: 'Separation',
  billing: 'Billing', report: 'Reports', audit: 'Audit', settings: 'Settings',
  user: 'User Accounts', role: 'Roles', tenant: 'Tenants', security: 'Security',
  administration: 'Administration Center', platform: 'Platform', integrations: 'Integrations',
};
const ACTION_LABELS = {
  view: 'View', create: 'Create', edit: 'Edit', update: 'Edit', delete: 'Delete', manage: 'Manage',
  approve: 'Approve', reject: 'Reject', apply: 'Apply', punch: 'Punch', regularize: 'Regularize',
  configure: 'Configure', calculate: 'Calculate', submit: 'Submit', lock: 'Lock', pay: 'Pay',
  adjust: 'Adjust', adjust_approve: 'Approve adjustments', import: 'Import', export: 'Export',
  lockout: 'Lock out', view_sensitive: 'View sensitive data', edit_sensitive: 'Edit sensitive data',
  override: 'Override', respond: 'Respond', review: 'Review', generate: 'Generate', reimburse: 'Reimburse',
  sync: 'Sync', action: 'Act on tasks', handle: 'Handle', cancel: 'Cancel',
};

const humanize = (s) => String(s).split(/[._]/).filter(Boolean).map((w) => {
  const l = w.toLowerCase();
  if (ACTION_LABELS[l]) return ACTION_LABELS[l];
  return l.charAt(0).toUpperCase() + l.slice(1);
}).join(' ');

/**
 * The browsable permission registry published into the `permissions` table.
 * One row per grantable key (scoped variants included) so the Role Permission
 * Matrix can be driven from data instead of a hard-coded array.
 */
const PERMISSION_CATALOG = (() => {
  const keys = new Set(PERMISSIONS);
  for (const base of Object.keys(SCOPEABLE_BASES)) keys.add(base);
  const out = [];
  for (const key of [...keys].sort()) {
    const [module, ...rest] = key.split('.');
    const action = rest.join('.');
    const [base, scope] = key.split(':');
    const scopes = scope ? [] : (SCOPEABLE_BASES[base] || []);
    out.push({
      key,
      base,
      scope: scope || null,
      module,
      action,
      category: module,
      label: `${humanize(module)} · ${humanize(action)}`,
      description: scope ? `${humanize(base)} limited to the ${scope} scope` : null,
      scopes,
      supportsScope: scopes.length > 0,
    });
  }
  return out;
})();

/**
 * Legacy ⇄ Administration-Center permission aliases. Both directions are honoured
 * so a role holding `org.manage` satisfies `administration.organization.manage`
 * and vice-versa. Keeps every pre-existing role and API gate valid.
 */
const PERMISSION_ALIASES = {
  'administration.organization.manage': ['org.manage'],
  'administration.organization.view': ['org.view'],
  'administration.users.manage': ['user.manage'],
  'administration.users.view': ['user.manage'],
  'administration.users.status': ['user.manage'],
  'administration.users.sessions': ['user.manage'],
  'administration.users.invite': ['user.manage'],
  'administration.roles.manage': ['role.manage'],
  'administration.roles.view': ['settings.view'],
  'administration.roles.clone': ['role.manage'],
  'administration.permissions.manage': ['role.manage'],
  'administration.permissions.view': ['settings.view'],
  'administration.permission_groups.manage': ['role.manage'],
'administration.workflows.manage': ['workflow.manage'],
  'administration.workflows.view': ['workflow.view'],
  'administration.workflows.publish': ['workflow.manage'],
  'administration.workflows.approve': ['administration.workflows.publish'],
  // Security, onboarding, configuration history and access requests are the
  // Administration Center's own surfaces. Each is aliased to the legacy settings /
  // user permission that already gates the equivalent work, so a company that used
  // `settings.manage` before the Center existed keeps exactly the reach it had.
  'administration.security.view': ['administration.security_policies.view', 'settings.view'],
  'administration.security.manage': ['administration.security_policies.manage', 'settings.manage'],
  'administration.onboarding.view': ['settings.view'],
  'administration.config.view': ['settings.view'],
  'administration.config.manage': ['settings.manage'],
  // Cross-tenant company data is platform-only, so `administration.access.*` has
  // NO alias to `platform.tenants.*` on purpose. Aliasing them would hand every
  // company owner a list of every other company on the platform. The Companies
  // screen is gated on `platform.tenants.view` itself.
  'administration.access.view': [],
  'administration.access.manage': [],
  'administration.access_requests.view': ['administration.users.view'],
  'administration.access_requests.manage': ['administration.users.manage'],
  'administration.settings.manage': ['settings.manage'],
  'administration.security_policies.manage': ['settings.manage'],
  'administration.security_policies.view': ['settings.view'],
  'administration.security.sessions.manage': ['user.manage'],
  'administration.security.sessions.view': ['user.manage'],
  'administration.security.mfa.manage': ['user.manage'],
  'administration.security.ip_restrictions.manage': ['settings.manage'],
  'administration.security.login_history.view': ['audit.view'],
  'administration.audit.view': ['audit.view'],
  'administration.audit.export': ['audit.view', 'report.export'],
  'administration.access_preview.view': ['settings.view'],
  'administration.access_debug.view': ['audit.view'],
  'administration.master_data.manage': ['org.manage'],
  'administration.master_data.view': ['org.view'],
  'administration.custom_fields.manage': ['org.manage'],
  'administration.custom_fields.view': ['org.view'],
  'administration.forms.manage': ['org.manage'],
  'administration.forms.view': ['org.view'],
  'administration.menu.manage': ['settings.manage'],
  'administration.dashboard_builder.manage': ['settings.manage'],
  'administration.modules.manage': ['settings.manage'],
  'administration.modules.view': ['settings.view'],
  'administration.integrations.api_keys.manage': ['integration.manage'],
  'administration.integrations.webhooks.manage': ['integration.manage'],
  'administration.notification.manage': ['notification.manage'],
  'administration.bulk.manage': ['user.manage'],
  'administration.export.manage': ['report.export'],
  'administration.onboarding.manage': ['settings.manage'],
  'administration.dashboard.view': ['dashboard.view'],
  'security.audit.view': ['audit.view'],
  'security.sessions.manage': ['user.manage'],
  'security.policies.manage': ['settings.manage'],
  'integrations.api_keys.manage': ['integration.manage'],
  'integrations.webhooks.manage': ['integration.manage'],
};
// Reverse map: which modern permissions a legacy grant stands in for.
// This is *display and reporting* information (the Permissions screen uses it to
// say "this legacy right already covers these"). It is deliberately NOT consulted
// when deciding whether a held permission satisfies a gate — see aliasCandidates.
const REVERSE_ALIASES = (() => {
  const rev = {};
  for (const [modern, legacy] of Object.entries(PERMISSION_ALIASES)) {
    for (const l of legacy) (rev[l] = rev[l] || []).push(modern);
  }
  return rev;
})();

/**
 * Grants that satisfy a gate written as `perm`.
 *
 * Direction is one-way on purpose: a modern permission declares the legacy grants
 * that stand in for it, so a gate written in modern terms accepts the legacy
 * umbrella. Resolving in reverse as well would equate a *narrow* permission with
 * the *broad* umbrella it was derived from — holding
 * `administration.onboarding.manage` would then satisfy a gate on
 * `settings.manage`, silently promoting an onboarding step-editor into a settings
 * administrator. Legacy gates keep working through their explicit `anyOf`
 * fallbacks and through the permission their role actually holds.
 */
const aliasCandidates = (perm) => [...(PERMISSION_ALIASES[perm] || [])];

/** Modern permissions a legacy grant covers. For explanations, never for gating. */
const modernEquivalents = (perm) => [...(REVERSE_ALIASES[perm] || [])];

// Highest scope wins per base permission (module.action).
function allowedScopes(perms, base) {
  const scopes = new Set();
  for (const p of perms) {
    if (p === base) { scopes.add('company'); continue; } // bare = company-level
    if (p.startsWith(base + ':')) scopes.add(p.slice(base.length + 1));
  }
  const order = ['own', 'team', 'department', 'business_unit', 'location', 'company', 'platform'];
  return order.filter((s) => scopes.has(s));
}

function hasPerm(perms, perm) {
  if (!perm) return false;
  const list = perms || [];
  if (list.includes(perm)) return true;
  const [base, scope] = perm.split(':');
  if (list.includes(base)) return true;                       // bare perm covers any scope
  const scoped = list.some((p) => p === base || p.startsWith(base + ':'));
  if (!scope && scoped) return true;                          // any scope covers the bare perm
  // Administration ⇄ legacy equivalence
  return aliasCandidates(perm).some((a) => list.includes(a) || list.some((p) => p.startsWith(a + ':')));
}

const ROLE_DEFS = {
  platform_super_admin: {
    label: 'Platform Super Admin',
    tenantScoped: false,
    permissions: PERMISSIONS.filter((p) => p !== 'dashboard.view'),
  },
  company_owner: {
    label: 'Company Owner',
    // Everything inside the tenant. Platform-level keys are never granted here —
    // only the Platform Super Admin role (tenant_id NULL) may cross tenants.
    permissions: PERMISSIONS.filter((p) => p !== 'tenant.manage' && !p.startsWith('platform.')),
  },
  hr_admin: {
    label: 'HR Admin',
    permissions: [
      'dashboard.view', 'employee.view:company', 'employee.create', 'employee.edit', 'employee.delete',
      'employee.import', 'employee.view_sensitive', 'employee.edit_sensitive', 'org.view', 'org.manage',
      'attendance.view:company', 'attendance.approve', 'attendance.manage', 'attendance.import', 'attendance.lock',
      'leave.view:company', 'leave.approve', 'leave.configure', 'leave.override',
      'payroll.view', 'payroll.adjust', 'expense.view:company', 'expense.approve', 'expense.configure',
      'loan.view:company', 'loan.manage', 'document.view:company', 'document.manage', 'letter.generate',
      'performance.view', 'performance.manage', 'recruitment.view', 'recruitment.manage',
      'asset.view', 'asset.manage', 'ticket.view:company', 'ticket.handle', 'announcement.view', 'announcement.manage',
      'onboarding.view', 'onboarding.manage', 'separation.view', 'separation.approve', 'separation.manage',
      'report.view', 'report.export', 'settings.view', 'tax.view',
      'talent.view', 'talent.manage', 'engagement.view', 'engagement.manage', 'engagement.respond',
      'relations.view', 'relations.manage', 'travel.view:company', 'travel.approve', 'travel.manage',
      'compensation.view', 'compensation.manage', 'bonus.view', 'bonus.manage', 'analytics.view',
      'benefit.view', 'benefit.manage', 'workforce.view', 'workforce.manage', 'analytics.view',
      'workflow.view', 'workflow.manage', 'workflow.action', 'notification.manage',
      'timesheet.view:company', 'timesheet.approve', 'timesheet.manage', 'attendance.view:own', 'attendance.punch',
      'attendance.regularize', 'leave.view:own', 'leave.apply', 'expense.create', 'travel.create', 'timesheet.create', 'ticket.create', 'ticket.view:own',
      // Administration Center — HR owns people & structure. Role/permission
      // authoring stays with the Company Owner and delegated administrators.
      'administration.view', 'administration.dashboard.view',
      'administration.organization.view', 'administration.organization.manage',
      'administration.business_units.manage', 'administration.teams.manage',
      'administration.designations.manage', 'administration.grades.manage',
      'administration.locations.manage', 'administration.cost_centers.manage', 'administration.positions.manage',
      'administration.users.view', 'administration.users.manage', 'administration.users.invite',
      'administration.users.status', 'administration.users.sessions',
      'administration.roles.view', 'administration.permissions.view',
      'administration.workflows.view', 'administration.workflows.manage',
      'administration.master_data.view', 'administration.master_data.manage',
      'administration.custom_fields.view', 'administration.custom_fields.manage',
      'administration.forms.view', 'administration.forms.manage',
      'administration.modules.view', 'administration.notifications.manage',
      'administration.bulk.manage', 'administration.import.manage', 'administration.export.manage',
      'administration.onboarding.manage', 'administration.access_preview.view',
    ],
  },
  payroll_admin: {
    label: 'Payroll Admin',
    permissions: [
      'dashboard.view', 'employee.view:company', 'employee.view_sensitive',
      'attendance.view:company', 'attendance.lock', 'attendance.import',
      'payroll.view', 'payroll.view_sensitive', 'payroll.configure', 'payroll.calculate',
      'payroll.submit', 'payroll.approve', 'payroll.lock', 'payroll.pay',
      'payroll.adjust', 'payroll.adjust_approve',
      'statutory.manage', 'tax.view', 'tax.manage', 'loan.view:company', 'loan.manage',
      'expense.view:company', 'expense.reimburse', 'report.view', 'report.export', 'settings.view',
      'compensation.view', 'compensation.manage', 'bonus.view', 'analytics.view',
      'benefit.view', 'travel.view:company', 'timesheet.view:company',
      // Read-only administration surface: payroll configuration is administered,
      // but the access model itself is not editable from this role.
      'administration.view', 'administration.dashboard.view',
      'administration.users.view', 'administration.roles.view', 'administration.workflows.view',
      'administration.master_data.view', 'administration.modules.view',
      'administration.access_preview.view', 'administration.export.manage',
    ],
  },
  finance_admin: {
    label: 'Finance/Admin',
    permissions: [
      'dashboard.view', 'billing.view', 'billing.manage', 'payroll.view', 'payroll.view_sensitive',
      'expense.view:company', 'expense.reimburse', 'loan.view:company',
      'report.view', 'report.export', 'settings.view', 'ticket.view:company', 'ticket.handle',
      'compensation.view', 'benefit.view', 'bonus.view', 'analytics.view',
      'travel.view:company', 'travel.approve', 'workforce.view',
      'administration.view', 'administration.dashboard.view', 'administration.users.view',
      'administration.roles.view', 'administration.workflows.view',
      'administration.master_data.view', 'administration.modules.view', 'administration.access_preview.view',
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
      'talent.view', 'engagement.view', 'engagement.respond', 'travel.view:team', 'travel.approve',
      'travel.create', 'timesheet.view:team', 'timesheet.approve', 'timesheet.create',
      'workflow.action', 'analytics.view', 'compensation.view',
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
      'talent.view', 'engagement.respond', 'travel.create', 'travel.view:own', 'timesheet.create', 'timesheet.view:own',
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
      'talent.view', 'engagement.view', 'engagement.respond', 'relations.view',
      'travel.view:department', 'travel.approve', 'travel.create', 'timesheet.view:team', 'timesheet.approve',
      'timesheet.create', 'workflow.action', 'analytics.view', 'workforce.view', 'compensation.view',
    ],
  },
  employee: {
    label: 'Employee',
    permissions: [
      'attendance.view:own', 'attendance.punch', 'attendance.regularize',
      'leave.view:own', 'leave.apply', 'expense.view:own', 'expense.create',
      'loan.view:own', 'ticket.view:own', 'ticket.create', 'announcement.view',
      'document.view:own', 'performance.view', 'report.view',
      'engagement.respond', 'travel.create', 'travel.view:own', 'timesheet.create', 'timesheet.view:own',
    ],
  },
  auditor: {
    label: 'Auditor (Read Only)',
    permissions: [
      'dashboard.view', 'employee.view:company', 'attendance.view:company', 'leave.view:company',
      'payroll.view', 'expense.view:company', 'billing.view', 'report.view', 'audit.view',
      'document.view:company', 'asset.view', 'loan.view:company',
      'analytics.view', 'compensation.view', 'benefit.view', 'travel.view:company',
      'relations.view', 'timesheet.view:company', 'workflow.view',
      // Administration Center in strict read-only mode: an auditor can inspect the
      // access model and the audit trail, never change it.
      'administration.view', 'administration.dashboard.view', 'administration.audit.view',
      'administration.access_preview.view', 'administration.roles.view', 'administration.users.view',
      'administration.permissions.view', 'administration.organization.view',
      'administration.master_data.view', 'administration.modules.view',
      'administration.workflows.view', 'administration.security_policies.view',
      'administration.security.login_history.view',
    ],
  },
};

/**
 * Reusable permission groups. Roles can receive these bundles instead of (or in
 * addition to) individual permissions. `permissions` lists base keys — the
 * resolver expands each to the widest scope granted in the group's membership.
 */
const SYSTEM_PERMISSION_GROUPS = [
  {
    code: 'employee_management', name: 'Employee Management',
    description: 'Create, edit and maintain the employee master.',
    permissions: ['employee.create', 'employee.edit', 'employee.import', 'employee.view_sensitive', 'employee.edit_sensitive'],
  },
  {
    code: 'attendance_management', name: 'Attendance Management',
    description: 'Registers, regularisation, approvals and period locks.',
    permissions: ['attendance.manage', 'attendance.regularize', 'attendance.approve', 'attendance.import', 'attendance.lock'],
  },
  {
    code: 'leave_management', name: 'Leave Management',
    description: 'Leave types, approvals and policy overrides.',
    permissions: ['leave.apply', 'leave.approve', 'leave.configure', 'leave.override'],
  },
  {
    code: 'payroll_management', name: 'Payroll Management',
    description: 'Full payroll lifecycle including lock and disbursement.',
    permissions: ['payroll.configure', 'payroll.calculate', 'payroll.submit', 'payroll.approve', 'payroll.lock', 'payroll.pay', 'payroll.view_sensitive'],
  },
  {
    code: 'recruitment_management', name: 'Recruitment Management',
    description: 'Requisitions, candidates, interviews and offers.',
    permissions: ['recruitment.create', 'recruitment.update', 'recruitment.delete'],
  },
  {
    code: 'performance_management', name: 'Performance Management',
    description: 'Cycles, goals, reviews and calibration.',
    permissions: ['performance.manage', 'performance.review'],
  },
  {
    code: 'administration', name: 'Administration',
    description: 'Organization structure, users and master data — no permission authoring.',
    permissions: [
      'administration.organization.manage', 'administration.teams.manage',
      'administration.users.manage', 'administration.users.invite', 'administration.users.status',
      'administration.master_data.manage',
    ],
  },
  {
    code: 'security', name: 'Security',
    description: 'Sessions, MFA, IP restrictions, policies and audit.',
    permissions: [
      'administration.security.sessions.manage', 'administration.security.mfa.manage',
      'administration.security.ip_restrictions.manage', 'administration.security_policies.manage',
      'administration.audit.view', 'administration.access_debug.view',
    ],
  },
  {
    code: 'reports', name: 'Reports',
    description: 'Run and export every register report.',
    permissions: ['report.view', 'report.export'],
  },
  {
    code: 'integrations', name: 'Integrations',
    description: 'API keys, webhooks and connected systems.',
    permissions: ['integration.manage', 'lms.sync', 'administration.integrations.api_keys.manage', 'administration.integrations.webhooks.manage'],
  },
  {
    code: 'workflow_administration', name: 'Workflow Administration',
    description: 'Build, publish and govern approval workflows.',
    permissions: ['administration.workflows.manage', 'administration.workflows.publish', 'administration.approval_rules.manage'],
  },
  {
    code: 'access_model_administration', name: 'Access Model Administration',
    description: 'Author roles, permissions, groups and menu access. Company-owner level.',
    permissions: [
      'administration.roles.manage', 'administration.roles.clone',
      'administration.permissions.manage', 'administration.permission_groups.manage',
      'administration.menu.manage', 'administration.dashboard_builder.manage',
    ],
  },
];

/** Modules an administrator can switch on/off. Disabling blocks access; it never deletes data. */
const MODULE_CATALOG = [
  { key: 'employees', name: 'Employees', category: 'people', defaultEnabled: true, description: 'Employee master, documents, onboarding and exit' },
  { key: 'attendance', name: 'Attendance', category: 'time', defaultEnabled: true, description: 'Punches, registers, regularisation and period locks' },
  { key: 'leave', name: 'Leave', category: 'time', defaultEnabled: true, description: 'Leave types, balances, requests and approvals' },
  { key: 'timesheets', name: 'Timesheets', category: 'time', defaultEnabled: true, description: 'Weekly timesheets, projects and approvals' },
  { key: 'payroll', name: 'Payroll', category: 'pay', defaultEnabled: true, description: 'Payroll runs, adjustments, statutory and tax' },
  { key: 'compensation', name: 'Compensation', category: 'pay', defaultEnabled: true, description: 'Salary bands, increments, reviews and bonus' },
  { key: 'benefits', name: 'Benefits', category: 'pay', defaultEnabled: true, description: 'Benefit plans, eligibility and enrollments' },
  { key: 'recruitment', name: 'Recruitment', category: 'talent', defaultEnabled: true, description: 'Requisitions, candidates, interviews and offers' },
  { key: 'performance', name: 'Performance', category: 'talent', defaultEnabled: true, description: 'Cycles, goals and reviews' },
  { key: 'talent', name: 'Talent & Succession', category: 'talent', defaultEnabled: true, description: 'Skills, career paths, development plans and succession' },
  { key: 'learning', name: 'Learning (via LMS)', category: 'talent', defaultEnabled: false, description: 'Delivered by the standalone LMS through the /api/v1 contract' },
  { key: 'engagement', name: 'Engagement', category: 'talent', defaultEnabled: true, description: 'Surveys, polls, recognition and suggestions' },
  { key: 'employee_relations', name: 'Employee Relations', category: 'people', defaultEnabled: true, description: 'Grievances, HR cases and disciplinary actions' },
  { key: 'lifecycle', name: 'Onboarding & Exit', category: 'people', defaultEnabled: true, description: 'Onboarding tasks, separation, clearance and F&F' },
  { key: 'expenses', name: 'Expenses', category: 'finance', defaultEnabled: true, description: 'Expense claims, receipts and reimbursement' },
  { key: 'loans', name: 'Loans & Advances', category: 'finance', defaultEnabled: true, description: 'Loans, EMI schedules and settlement' },
  { key: 'billing', name: 'Billing & Invoicing', category: 'finance', defaultEnabled: true, description: 'Customers, GST invoices and payments' },
  { key: 'documents', name: 'Documents', category: 'people', defaultEnabled: true, description: 'Employee and company document vault, letters' },
  { key: 'assets', name: 'Assets', category: 'ops', defaultEnabled: true, description: 'Asset register, assignment and lifecycle' },
  { key: 'helpdesk', name: 'Helpdesk', category: 'ops', defaultEnabled: true, description: 'Tickets, announcements and notifications' },
  { key: 'travel', name: 'Travel', category: 'ops', defaultEnabled: false, description: 'Requests, advances, bookings and settlement' },
  { key: 'workforce_planning', name: 'Workforce Planning', category: 'insight', defaultEnabled: false, description: 'Headcount plans, scenarios and vacancies' },
  { key: 'analytics', name: 'People Analytics', category: 'insight', defaultEnabled: true, description: 'Role-aware dashboards and register reports' },
  { key: 'workflow', name: 'Workflow & Automation', category: 'ops', defaultEnabled: true, description: 'Approval workflows, SLA and delegations' },
  { key: 'notifications', name: 'Notifications', category: 'ops', defaultEnabled: true, description: 'Notification templates, delivery logs and preferences' },
  { key: 'integrations', name: 'Integrations', category: 'ops', defaultEnabled: false, description: 'API keys, webhooks and connected systems' },
  { key: 'ai_assistant', name: 'AI HR Assistant', category: 'insight', defaultEnabled: false, description: 'Permission-scoped natural language Q&A' },
];

/**
 * Which permission namespaces decide whether a module is reachable.
 *
 * Module keys are product nouns while permission keys are `module.action`, and the
 * two do not always share a name (`employees` ⇄ `employee`, `ai_assistant` ⇄ `ai`,
 * `helpdesk` ⇄ `ticket`/`announcement`). Keeping the mapping here — as data —
 * means "can this person reach Travel?" is answered by one table rather than by
 * string prefix guessing at each call site.
 */
const MODULE_PERMISSION_MODULES = {
  employees: ['employee', 'onboarding', 'separation'],
  attendance: ['attendance'],
  leave: ['leave'],
  timesheets: ['timesheet'],
  payroll: ['payroll', 'statutory', 'tax', 'expense', 'loan'],
  compensation: ['compensation', 'bonus'],
  benefits: ['benefit'],
  recruitment: ['recruitment', 'onboarding'],
  performance: ['performance'],
  talent: ['talent'],
  learning: [],
  engagement: ['engagement'],
  employee_relations: ['relations'],
  lifecycle: ['onboarding', 'separation'],
  expenses: ['expense'],
  loans: ['loan'],
  billing: ['billing'],
  documents: ['document'],
  assets: ['asset'],
  helpdesk: ['ticket', 'announcement'],
  travel: ['travel'],
  workforce_planning: ['workforce'],
  analytics: ['analytics', 'report'],
  workflow: ['workflow'],
  notifications: ['notification'],
  integrations: ['integration', 'lms'],
  ai_assistant: ['ai'],
};

/** Reusable reporting-relationship types. `primary` mirrors the classic manager_id slot. */
const SYSTEM_RELATIONSHIP_TYPES = [
  { code: 'reporting_manager', name: 'Reporting Manager', description: 'Solid-line manager responsible for the employee.', isPrimary: true, sortOrder: 10 },
  { code: 'functional_manager', name: 'Functional Manager', description: 'Manager for a specific discipline or skill set.', isPrimary: false, sortOrder: 20 },
  { code: 'department_head', name: 'Department Head', description: 'Head of the department the employee belongs to.', isPrimary: false, sortOrder: 30 },
  { code: 'hr_business_partner', name: 'HR Business Partner', description: 'HR owner supporting this employee.', isPrimary: false, sortOrder: 40 },
  { code: 'project_manager', name: 'Project Manager', description: 'Manager for a project the employee is staffed on.', isPrimary: false, sortOrder: 50 },
  { code: 'mentor', name: 'Mentor', description: 'Mentor assigned for development.', isPrimary: false, sortOrder: 60 },
  { code: 'dotted_line_manager', name: 'Dotted-line Manager', description: 'Secondary manager without direct authority.', isPrimary: false, sortOrder: 70 },
];

/** Baseline platform security posture. Tenants may tighten, never silently loosen. */
const DEFAULT_SECURITY_POLICIES = {
  'password.min_length': { __desc: 'Minimum password length', value: 10, min: 8, max: 64 },
  'password.require_mixed_case': { __desc: 'Require upper and lower case characters', value: true },
  'password.require_number': { __desc: 'Require at least one digit', value: true },
  'password.require_symbol': { __desc: 'Require at least one symbol', value: false },
  'password.expiry_days': { __desc: 'Days before a password must be changed (0 = never)', value: 0 },
  'password.max_failed_attempts': { __desc: 'Failed logins before the account locks', value: 5 },
  'password.lockout_minutes': { __desc: 'Lockout duration in minutes', value: 15 },
  'session.max_per_user': { __desc: 'Concurrent sessions allowed per user', value: 5 },
  'session.idle_timeout_minutes': { __desc: 'Idle timeout for an interactive session', value: 60 },
  'session.refresh_days': { __desc: 'Refresh-token lifetime in days', value: 7 },
  'mfa.required_for_admin': { __desc: 'Force MFA for administrative roles', value: false },
  'ip.allowlist_enabled': { __desc: 'Restrict administrative access to allow-listed networks', value: false },
  'audit.retention_days': { __desc: 'Audit log retention in days (0 = forever)', value: 0 },
};

const PLATFORM_PLANS = [
  { key: 'trial', name: 'Trial', description: 'Evaluation access with core HR modules.', priceMonthly: 0, employeeLimit: 25, modules: ['employees', 'attendance', 'leave', 'documents'], sortOrder: 10 },
  { key: 'standard', name: 'Standard', description: 'Full people operations for small teams.', priceMonthly: 4999, employeeLimit: 100, modules: null, sortOrder: 20 },
  { key: 'enterprise', name: 'Enterprise', description: 'Unlimited modules, integrations and SSO.', priceMonthly: 14999, employeeLimit: 500, modules: null, sortOrder: 30 },
];

const DEFAULT_ROLES = ['company_owner', 'hr_admin', 'payroll_admin', 'finance_admin', 'manager', 'recruiter', 'department_head', 'employee', 'auditor'];

/** Widest scope held for a base permission, or null when it is not held at all. */
function widestScope(perms, base) {
  const scopes = allowedScopes(perms, base);
  return scopes.length ? scopes[scopes.length - 1] : null;
}

const hasScope = (perms, base, needed) => {
  const widest = widestScope(perms, base);
  if (!widest) return false;
  return SCOPE_RANK[widest] >= SCOPE_RANK[needed];
};

module.exports = {
  PERMISSIONS, PERMISSION_CATALOG, PERMISSION_ALIASES, REVERSE_ALIASES, aliasCandidates, modernEquivalents,
  SCOPES, SCOPE_RANK, SCOPEABLE_BASES, MODULE_LABELS, ACTION_LABELS, humanize,
  ROLE_DEFS, DEFAULT_ROLES, hasPerm, hasScope, allowedScopes, widestScope,
  SYSTEM_PERMISSION_GROUPS, MODULE_CATALOG, MODULE_PERMISSION_MODULES, SYSTEM_RELATIONSHIP_TYPES,
  DEFAULT_SECURITY_POLICIES, PLATFORM_PLANS,
};
