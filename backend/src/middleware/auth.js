const { pool } = require('../config/db');
const { verifyAccessToken } = require('../utils/jwt');
const { hasPerm, allowedScopes, ROLE_DEFS } = require('../utils/permissions');
const { HttpError } = require('../utils/helpers');

const rolePermCache = new Map(); // tenantId -> {roleKey: perms[]}

async function loadRolePermissions(tenantId) {
  if (rolePermCache.has(tenantId)) return rolePermCache.get(tenantId);
  const [rows] = await pool.query(
    'SELECT name, permissions FROM roles WHERE tenant_id = ? OR tenant_id IS NULL',
    [tenantId]
  );
  const map = {};
  for (const r of rows) map[r.name] = Array.isArray(r.permissions) ? r.permissions : JSON.parse(r.permissions || '[]');
  // fall back to system defaults for anything missing
  for (const [k, def] of Object.entries(ROLE_DEFS)) if (!map[k]) map[k] = def.permissions;
  rolePermCache.set(tenantId, map);
  return map;
}
function invalidateRoleCache() { rolePermCache.clear(); }

/** Require a valid access token. Attaches req.user = {id, tenant_id, role, employee_id, name, permissions}. */
async function authenticate(req, res, next) {
  try {
    const hdr = req.headers.authorization || '';
    const token = hdr.startsWith('Bearer ') ? hdr.slice(7) : null;
    if (!token) throw new HttpError(401, 'Authentication required');
    const payload = verifyAccessToken(token);
    const [rows] = await pool.query(
      `SELECT u.id, u.tenant_id, u.role, u.employee_id, u.name, u.email, u.status, t.status AS tenant_status
       FROM users u LEFT JOIN tenants t ON t.id = u.tenant_id WHERE u.id = ?`,
      [payload.sub]
    );
    const user = rows[0];
    if (!user || user.status !== 'active') throw new HttpError(401, 'Account is disabled');
    if (user.tenant_id && user.tenant_status !== 'active') throw new HttpError(403, 'Company account suspended');
    const permMap = await loadRolePermissions(user.tenant_id || 0);
    user.permissions = permMap[user.role] || [];
    req.user = user;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') return next(new HttpError(401, 'Session expired'));
    next(err.status ? err : new HttpError(401, 'Invalid or expired token'));
  }
}

/** Gate a route on a permission string (e.g. 'payroll.approve'). */
function requirePermission(perm) {
  return (req, res, next) => {
    if (req.user.role === 'platform_super_admin') return next();
    if (hasPerm(req.user.permissions || [], perm)) return next();
    next(new HttpError(403, `Missing permission: ${perm}`));
  };
}

/** Returns the widest employee-scope the user holds for a base perm (e.g. 'employee.view'). */
function scopeFor(user, base) {
  if (user.role === 'platform_super_admin') return 'company';
  const scopes = allowedScopes(user.permissions || [], base);
  if (scopes.includes('company') || scopes.includes('tenant')) return 'company';
  if (scopes.includes('department')) return 'department';
  if (scopes.includes('team')) return 'team';
  return scopes[0] || 'none';
}

/** SQL condition fragment limiting employees to the user's scope. */
function employeeScopeCondition(user, base, alias = 'e') {
  const scope = scopeFor(user, base);
  if (scope === 'company') return { sql: '1=1', params: [] };
  if (scope === 'department') {
    return {
      sql: `(${alias}.id = ? OR ${alias}.department_id IN (SELECT id FROM departments WHERE head_employee_id = ?))`,
      params: [user.employee_id, user.employee_id],
    };
  }
  if (scope === 'team') {
    return { sql: `(${alias}.id = ? OR ${alias}.manager_id = ? OR ${alias}.reporting_head_id = ?)`, params: [user.employee_id, user.employee_id, user.employee_id] };
  }
  if (scope === 'own') return { sql: `${alias}.id = ?`, params: [user.employee_id] };
  return { sql: '1=0', params: [] };
}

/** SQL condition fragment for a non-employee row (e.g. 'lr.employee_id') within the user's department scope. */
function departmentRowCondition(user, column) {
  return {
    sql: `(${column} = ? OR ${column} IN (SELECT id FROM employees WHERE department_id IN (SELECT id FROM departments WHERE head_employee_id = ?)))`,
    params: [user.employee_id, user.employee_id],
  };
}

/** Department ids whose head is the user's linked employee record. */
async function headedDepartmentIds(employeeId) {
  if (!employeeId) return [];
  const [rows] = await pool.query('SELECT id FROM departments WHERE head_employee_id = ?', [employeeId]);
  return rows.map((r) => r.id);
}

/** Guard: action allowed only on the employee themself or a direct report (for team-scope perms). */
function canActOnEmployee(user, base, targetEmployeeId) {
  if (user.role === 'platform_super_admin') return true;
  const scope = scopeFor(user, base);
  if (scope === 'company') return true;
  if (scope === 'team') return targetEmployeeId === user.employee_id || user.teamEmployeeIds?.includes(Number(targetEmployeeId));
  return Number(targetEmployeeId) === Number(user.employee_id);
}

module.exports = { authenticate, requirePermission, scopeFor, employeeScopeCondition, departmentRowCondition, headedDepartmentIds, canActOnEmployee, invalidateRoleCache, loadRolePermissions };
