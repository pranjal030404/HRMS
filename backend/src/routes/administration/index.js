/**
 * Administration Center API.
 *
 * Mounted at `/api/administration`. Every route below derives its company from the
 * caller's session, requires a permission that is resolved through
 * `services/rbac`, and records what changed in the audit trail.
 */
const express = require('express');
const { asyncH } = require('../../utils/helpers');
const { authenticate } = require('../../middleware/auth');
const { PERMISSION_CATALOG, MODULE_CATALOG, hasPerm } = require('../../utils/permissions');
const rbac = require('../../services/rbac');

const r = express.Router();
r.use(authenticate);

/**
 * GET /meta
 * The contract the UI boots from: which administration sections this user may
 * open, and the permission behind each one. The UI hides what it cannot use;
 * the server still enforces every check independently.
 */
r.get('/meta', asyncH(async (req, res) => {
  // Must answer exactly what requirePermission() would answer, or the menu hides a
  // screen the API would happily serve (or the reverse). Raw `includes` does not
  // understand aliases or scoped variants, so delegate to the same predicate.
  const can = (p) => req.user.isPlatformAdmin || hasPerm(req.user.permissions || [], p);
  const sections = [
    { key: 'dashboard', path: '/administration', label: 'Administration Center', permission: 'administration.view' },
    { key: 'organization', path: '/administration/organization', label: 'Organization Builder', permission: 'administration.organization.view' },
    { key: 'teams', path: '/administration/teams', label: 'Teams', permission: 'administration.organization.view' },
    { key: 'positions', path: '/administration/positions', label: 'Positions', permission: 'administration.organization.view' },
    { key: 'users', path: '/administration/users', label: 'Users & Access', permission: 'administration.users.view' },
    { key: 'roles', path: '/administration/roles', label: 'Roles', permission: 'administration.roles.view' },
    { key: 'permissions', path: '/administration/permissions', label: 'Permissions', permission: 'administration.permissions.view' },
    { key: 'access', path: '/administration/access', label: 'Access Review', permission: 'administration.access_preview.view' },
    { key: 'tenants', path: '/administration/tenants', label: 'Companies', permission: 'platform.tenants.view' },
    { key: 'workflows', path: '/administration/workflows', label: 'Workflows', permission: 'administration.workflows.view' },
    { key: 'customization', path: '/administration/customization', label: 'Custom Fields & Forms', permission: 'administration.custom_fields.view' },
    { key: 'master-data', path: '/administration/master-data', label: 'Master Data', permission: 'administration.master_data.view' },
    { key: 'modules', path: '/administration/modules', label: 'Modules & Features', permission: 'administration.modules.view' },
    { key: 'security', path: '/administration/security', label: 'Security', permission: 'administration.security.view' },
    { key: 'config', path: '/administration/config', label: 'Configuration History', permission: 'administration.config.view' },
    { key: 'data', path: '/administration/data', label: 'Bulk, Import & Export', permission: 'administration.bulk.manage' },
    { key: 'onboarding', path: '/administration/onboarding', label: 'Onboarding', permission: 'administration.onboarding.view' },
    { key: 'audit', path: '/administration/audit', label: 'Audit Trail', permission: 'administration.audit.view' },
  ].map((s) => ({ ...s, accessible: can(s.permission) }));

  const [counts] = await Promise.all([
    rbac.enabledModules(req.user.tenant_id),
  ]);
  res.json({
    data: {
      sections,
      tenant: { id: req.user.tenant_id, name: req.user.tenant_name || null },
      user: {
        id: req.user.id,
        name: req.user.name,
        email: req.user.email,
        role: req.user.role,
        roles: req.user.roles,
        isPlatformAdmin: req.user.isPlatformAdmin,
      },
      permissions: req.user.permissions,
      scopes: req.user.scopes,
      enabledModules: counts,
      moduleCatalog: MODULE_CATALOG.map((m) => ({ key: m.key, name: m.name, category: m.category, defaultEnabled: !!m.defaultEnabled })),
      catalogSize: PERMISSION_CATALOG.length,
    },
  });
}));

/** GET /health — a single round trip that proves the admin stack is wired up. */
r.get('/health', asyncH(async (req, res) => {
  const effective = await rbac.effectivePermissions(req.user);
  res.json({
    data: {
      ok: true,
      tenantId: req.user.tenant_id,
      role: req.user.role,
      roles: effective.roles.map((x) => x.label),
      permissionCount: effective.permissions.length,
      enabledModules: effective.accessibleModules.length,
      requestId: req.requestId,
    },
  });
}));

// Each sub-router declares its own absolute paths (e.g. /users, /teams, /roles),
// so they all mount at the root of the Administration Center.
r.use(require('./organization'));
r.use(require('./users'));
r.use(require('./access'));
r.use(require('./customization'));
r.use(require('./masterdata'));
r.use(require('./workflows-config'));
r.use(require('./platform'));
r.use(require('./operations'));

module.exports = r;
