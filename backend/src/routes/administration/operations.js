/**
 * Administration operations — the dashboard, bulk changes, import/export and the
 * audit trail reader.
 *
 * Bulk and import paths are deliberately two-phase: every one of them validates
 * first and reports what *would* change, and only applies when asked. An admin
 * editing 200 employees should never have to trust a single blind click.
 */
const express = require('express');
const dayjs = require('dayjs');
const { pool } = require('../../config/db');
const { asyncH, HttpError } = require('../../utils/helpers');
const { requirePermission } = require('../../middleware/auth');
const { tenantId, writeTenantId, audit, int, paging, decode, insertRows } = require('./_shared');
const { toCsv, parseCsv } = require('../../utils/csv');
const rbac = require('../../services/rbac');

const r = express.Router();

const DASH = requirePermission('administration.dashboard.view', { anyOf: ['dashboard.view'] });
const BULK = requirePermission('administration.bulk.manage', { anyOf: ['settings.manage'] });
const IMPORT = requirePermission('administration.import.manage', { anyOf: ['settings.manage'] });
const EXPORT = requirePermission('administration.export.manage', { anyOf: ['report.export', 'settings.manage'] });
const AUDIT_READ = requirePermission('administration.audit.view', { anyOf: ['audit.view'] });

// ---------------------------------------------------------------- dashboard
/**
 * GET /dashboard
 * One screen that answers "is this company configured correctly?" — live counts,
 * real problems, and the recent administration trail.
 */
r.get('/dashboard', DASH, asyncH(async (req, res) => {
  const t = tenantId(req);
  const one = async (sql, params = [t]) => Number((await pool.query(sql, params))[0][0].c || 0);

  const [
    employees, activeEmployees, teams, positions, departments,
    users, customRoles, customFields, forms, masterItems,
    enabledModules, disabledModules, pendingInvitations, openPositions,
  ] = await Promise.all([
    one('SELECT COUNT(*) AS c FROM employees WHERE tenant_id = ? AND deleted_at IS NULL'),
    one("SELECT COUNT(*) AS c FROM employees WHERE tenant_id = ? AND deleted_at IS NULL AND status = 'active'"),
    one('SELECT COUNT(*) AS c FROM teams WHERE tenant_id = ? AND (status IS NULL OR status <> \'inactive\')'),
    one('SELECT COUNT(*) AS c FROM positions WHERE tenant_id = ? AND (status IS NULL OR status <> \'inactive\')'),
    one('SELECT COUNT(*) AS c FROM departments WHERE tenant_id = ? AND archived_at IS NULL'),
    one('SELECT COUNT(*) AS c FROM users WHERE tenant_id = ?'),
    one('SELECT COUNT(*) AS c FROM roles WHERE tenant_id = ? AND is_custom = 1'),
    one("SELECT COUNT(*) AS c FROM custom_field_definitions WHERE tenant_id = ? AND status = 'active'"),
    one("SELECT COUNT(*) AS c FROM custom_forms WHERE tenant_id = ? AND status = 'published'"),
    one("SELECT COUNT(*) AS c FROM master_data_items WHERE tenant_id = ? AND status = 'active'"),
    (await rbac.enabledModules(t)).length,
    rbac.MODULE_CATALOG.length - (await rbac.enabledModules(t)).length,
    one("SELECT COUNT(*) AS c FROM user_invitations WHERE tenant_id = ? AND status = 'pending'"),
    one('SELECT COUNT(*) AS c FROM positions WHERE tenant_id = ? AND (status IS NULL OR status = \'open\') AND filled < openings'),
  ]);

  const alerts = [];
  const [[deptNoHead]] = await pool.query(
    'SELECT COUNT(*) AS c FROM departments WHERE tenant_id = ? AND archived_at IS NULL AND head_employee_id IS NULL', [t]
  );
  if (Number(deptNoHead.c)) alerts.push({ severity: 'warning', key: 'departments_without_head', count: Number(deptNoHead.c), message: `${deptNoHead.c} department(s) have no head` });
  const [[noRole]] = await pool.query(
    "SELECT COUNT(*) AS c FROM users WHERE tenant_id = ? AND status = 'active' AND (role IS NULL OR role = '')", [t]
  );
  if (Number(noRole.c)) alerts.push({ severity: 'critical', key: 'users_without_role', count: Number(noRole.c), message: `${noRole.c} active login(s) have no role` });
  const [[expDocs]] = await pool.query(
    `SELECT COUNT(*) AS c FROM employee_documents WHERE tenant_id = ? AND expires_on IS NOT NULL
       AND expires_on BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 30 DAY)`, [t]
  );
  if (Number(expDocs.c)) alerts.push({ severity: 'info', key: 'documents_expiring', count: Number(expDocs.c), message: `${expDocs.c} document(s) expire within 30 days` });
  if (pendingInvitations) alerts.push({ severity: 'info', key: 'pending_invitations', count: pendingInvitations, message: `${pendingInvitations} invitation(s) awaiting acceptance` });
  if (openPositions) alerts.push({ severity: 'info', key: 'open_positions', count: openPositions, message: `${openPositions} position(s) are open` });

  const [recentAdmin] = await pool.query(
    `SELECT id, actor_name, actor_role, action, entity_type, entity_id, created_at, ip, outcome
     FROM admin_audit_logs WHERE tenant_id = ? AND module = 'administration'
     ORDER BY created_at DESC LIMIT 10`, [t]
  );
  const [moduleList] = await pool.query(
    'SELECT module_key, enabled FROM module_configurations WHERE tenant_id = ?', [t]
  );
  const enabledSet = new Set(await rbac.enabledModules(t));

  res.json({
    data: {
      company: { id: t },
      counts: {
        employees, activeEmployees, departments, teams, positions, users,
        customRoles, customFields, forms, masterItems,
        modules: { enabled: enabledModules, disabled: disabledModules },
      },
      alerts,
      recentAdministration: recentAdmin,
      modules: moduleList.map((m) => ({ key: m.module_key, enabled: enabledSet.has(m.module_key) })),
      quickActions: buildQuickActions(req.user),
    },
  });
}));

/** What this particular user may start doing right now. */
function buildQuickActions(user) {
  const can = (p) => user.isPlatformAdmin || (user.permissions || []).includes(p);
  const actions = [];
  if (can('administration.users.invite')) actions.push({ key: 'invite_user', label: 'Invite a user', route: '/administration/users?action=invite' });
  if (can('administration.roles.manage')) actions.push({ key: 'create_role', label: 'Create a role', route: '/administration/roles?action=create' });
  if (can('administration.teams.manage')) actions.push({ key: 'create_team', label: 'Add a team', route: '/administration/organization?action=team' });
  if (can('administration.custom_fields.manage')) actions.push({ key: 'create_field', label: 'Add a custom field', route: '/administration/customization?action=field' });
  if (can('administration.master_data.manage')) actions.push({ key: 'master_data', label: 'Manage master data', route: '/administration/master-data' });
  if (can('administration.modules.manage')) actions.push({ key: 'modules', label: 'Configure modules', route: '/administration/modules' });
  if (can('administration.workflows.manage')) actions.push({ key: 'workflows', label: 'Configure workflows', route: '/administration/workflows' });
  if (can('administration.import.manage')) actions.push({ key: 'import', label: 'Import data', route: '/administration/data?action=import' });
  return actions;
}

// ---------------------------------------------------------------- bulk
const BULK_OPERATIONS = {
  users: {
    table: 'users',
    ops: {
      set_status: async ({ tenant, ids, value, actor }) => {
        const status = String(value);
        if (!['active', 'inactive', 'suspended', 'disabled', 'archived'].includes(status)) {
          throw new HttpError(400, 'That is not a valid user status');
        }
        // The same self-protection the single-user endpoint applies, so bulk cannot
        // be used to sidestep it (locking yourself out, or demoting the last owner).
        await assertNotSelf(actor, ids, 'change the status of your own login');
        if (status !== 'active') await assertNoLastOwner(tenant, ids, 'disable');
        return { sql: 'UPDATE users SET status = ? WHERE tenant_id = ? AND id IN (?)', params: [status, tenant, ids] };
      },
      assign_role: async ({ tenant, ids, value, actor }) => {
        const role = await rbac.resolveRole(tenant, value);
        if (!role || role.id == null) throw new HttpError(400, 'Unknown role');
        await rbac.assertCanAssignRole(actor, role);
        await assertNotSelf(actor, ids, 'change your own role assignment');
        if (role.name === 'company_owner') await assertNoLastOwner(tenant, ids, 'demote');
        return {
          apply: async () => {
            await pool.query('DELETE FROM user_roles WHERE user_id IN (?)', [ids]);
            await insertRows('user_roles',
              ['tenant_id', 'user_id', 'role_id', 'is_primary', 'assigned_by'],
              ids.map((id) => [tenant, id, role.id, 1, actor.id]));
            await pool.query(
              `UPDATE users u JOIN (SELECT id FROM users WHERE id IN (?)) x ON x.id = u.id
               SET u.role = ?`, [ids, role.name]
            );
          },
          describe: `assign the ${role.label} role`,
          after: async () => ids.forEach((id) => rbac.invalidateUser(id)),
        };
      },
      reset_password: async ({ tenant, ids, actor }) => {
        await assertNotSelf(actor, ids, 'reset your own password from here');
        return ({
        apply: async () => {
          const bcrypt = require('bcryptjs');
          const crypto = require('crypto');
          const issued = [];
          for (const id of ids) {
            const temp = `Av@${crypto.randomBytes(3).toString('hex')}`;
            await pool.query('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ? AND tenant_id = ?',
              [await bcrypt.hash(temp, 10), id, tenant]);
            issued.push({ userId: id, tempPassword: temp });
          }
          return { issued };
        },
        describe: 'reset passwords and force a change at next login',
        });
      },
    },
  },
  teams: {
    table: 'teams',
    ops: {
      set_status: async ({ tenant, ids, value }) => ({
        sql: 'UPDATE teams SET status = ? WHERE tenant_id = ? AND id IN (?)', params: [value, tenant, ids],
      }),
      set_department: async ({ tenant, ids, value }) => {
        const [dept] = await pool.query('SELECT id FROM departments WHERE id = ? AND tenant_id = ?', [int(value), tenant]);
        if (!dept[0]) throw new HttpError(400, 'That department does not belong to this company');
        return { sql: 'UPDATE teams SET department_id = ? WHERE tenant_id = ? AND id IN (?)', params: [dept[0].id, tenant, ids] };
      },
    },
  },
};


/** Refuse a bulk operation that would act on the caller's own account. */
async function assertNotSelf(actor, ids, what) {
  if (ids.map(Number).includes(Number(actor.id))) {
    throw new HttpError(400, `You cannot ${what}`);
  }
}

/** Refuse a bulk operation that would leave the company without an active owner. */
async function assertNoLastOwner(tenant, ids, verb) {
  const placeholders = ids.map(() => '?').join(',');
  const [staying] = await pool.query(
    `SELECT COUNT(*) AS c FROM users WHERE tenant_id = ? AND status = 'active'
       AND (role = 'company_owner'
            OR id IN (SELECT ur.user_id FROM user_roles ur JOIN roles r ON r.id = ur.role_id
                      WHERE r.name = 'company_owner'))
       AND id NOT IN (${placeholders})`,
    [tenant, ...ids]
  );
  if (Number(staying[0].c) === 0) {
    throw new HttpError(400, `This would ${verb} the last active Company Owner — appoint another owner first`);
  }
}

/**
 * POST /bulk/:entity
 * Body: { ids: [...], operation, value, dry_run }
 * Always returns what would change; `dry_run: true` stops before writing.
 */
r.post('/bulk/:entity', BULK, asyncH(async (req, res) => {
  const t = writeTenantId(req);
  const spec = BULK_OPERATIONS[req.params.entity];
  if (!spec) throw new HttpError(404, `Bulk operations are not available for "${req.params.entity}"`);
  const { ids, operation, value, dry_run: dryRun } = req.body || {};
  const idList = [...new Set((ids || []).map((x) => int(x)).filter(Boolean))];
  if (!idList.length) throw new HttpError(400, 'ids[] is required');
  if (idList.length > 500) throw new HttpError(400, 'Select at most 500 records at a time');
  const handler = spec.ops[operation];
  if (!handler) throw new HttpError(400, `Unknown operation "${operation}". Available: ${Object.keys(spec.ops).join(', ')}`);

  // Only records inside this company are eligible — the rest are reported as skipped.
  const [owned] = await pool.query(`SELECT id FROM ${spec.table} WHERE tenant_id = ? AND id IN (?)`, [t, idList]);
  const ownedIds = owned.map((x) => x.id);
  const skipped = idList.filter((id) => !ownedIds.includes(id));

  // Nothing owned in this company: report it and stop. Building `IN ()` here would
  // be a syntax error, and there is nothing to write in any case.
  if (!ownedIds.length && !dryRun) {
    throw new HttpError(404, 'None of the selected records belong to this company');
  }

  const plan = await handler({ tenant: t, ids: ownedIds, value, actor: req.user });
  const describe = plan.describe || `set ${operation} to "${value}"`;

  if (dryRun) {
    return res.json({
      data: {
        dryRun: true, target: ownedIds.length, skipped,
        planned: `Would ${describe} for ${ownedIds.length} record(s)`,
      },
    });
  }
  let result = null;
  if (plan.apply) {
    result = await plan.apply();
  } else if (plan.sql) {
    const [res2] = await pool.query(plan.sql, plan.params);
    result = { affected: res2.affectedRows };
  }
  await plan.after?.();
  await audit(req, { action: `bulk.${req.params.entity}.${operation}`, entityType: req.params.entity, after: { count: ownedIds.length, value, skipped: skipped.length } });
  res.json({ data: { applied: true, affected: ownedIds.length, skipped, result } });
}));

// ---------------------------------------------------------------- import / export
/** Each importable/exportable entity declares its columns and validation. */
const DATA_SETS = {
  employees: {
    read: ['administration.users.view', 'employee.view'],
    write: 'administration.import.manage',
    columns: ['employee_code', 'first_name', 'last_name', 'email', 'phone', 'gender', 'date_of_birth',
      'joined_on', 'status', 'department', 'designation', 'location', 'grade', 'employment_type'],
    required: ['first_name', 'last_name'],
    lookup: { department: ['departments', 'name'], designation: ['designations', 'name'], location: ['locations', 'name'], grade: ['grades', 'name'] },
    insert: async (tenant, row, actorId) => {
      const cols = ['tenant_id', 'first_name', 'last_name', 'employee_code', 'email', 'phone', 'gender',
        'date_of_birth', 'joined_on', 'status', 'department_id', 'designation_id', 'location_id', 'grade_id', 'employment_type'];
      const [ins] = await pool.query(
        `INSERT INTO employees (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
        cols.map((c) => (c === 'tenant_id' ? tenant : c.endsWith('_id') ? (row[`${c.replace(/_id$/, '')}_id`] ?? null) : row[c] ?? null))
      );
      return ins.insertId;
    },
  },
  teams: {
    read: ['administration.organization.view', 'org.manage'],
    write: 'administration.import.manage',
    columns: ['name', 'code', 'description', 'department', 'team_lead_email', 'status'],
    required: ['name'],
    lookup: { department: ['departments', 'name'] },
    insert: async (tenant, row) => {
      const [ins] = await pool.query(
        `INSERT INTO teams (tenant_id, name, code, description, department_id, team_lead_id, status)
         VALUES (?,?,?,?,?,?,?)`,
        [tenant, row.name, row.code || null, row.description || null, row.department_id ?? null, row.team_lead_id ?? null, row.status || 'active']
      );
      return ins.insertId;
    },
  },
  positions: {
    read: ['administration.organization.view', 'org.manage'],
    write: 'administration.import.manage',
    columns: ['title', 'code', 'description', 'department', 'designation', 'grade', 'location', 'employment_type', 'openings', 'filled', 'status'],
    required: ['title'],
    lookup: { department: ['departments', 'name'], designation: ['designations', 'name'], grade: ['grades', 'name'], location: ['locations', 'name'] },
    insert: async (tenant, row) => {
      const [ins] = await pool.query(
        `INSERT INTO positions (tenant_id, title, code, description, department_id, designation_id, grade_id, location_id, employment_type, openings, filled, status)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [tenant, row.title, row.code || null, row.description || null, row.department_id ?? null,
          row.designation_id ?? null, row.grade_id ?? null, row.location_id ?? null,
          row.employment_type || 'full_time', Number(row.openings || 1), Number(row.filled || 0), row.status || 'open']
      );
      return ins.insertId;
    },
  },
};

/** GET /data-sets — what can be imported/exported, and with which columns. */
r.get('/data-sets', EXPORT, asyncH(async (req, res) => {
  res.json({
    data: Object.entries(DATA_SETS).map(([key, spec]) => ({
      key, columns: spec.columns, required: spec.required,
      canImport: req.user.isPlatformAdmin || (req.user.permissions || []).includes(spec.write),
      canExport: req.user.isPlatformAdmin || spec.read.some((p) => (req.user.permissions || []).includes(p)),
    })),
  });
}));

/**
 * POST /import/:entity
 * Body: { rows: [...] } or { csv: "..." }, plus `dry_run` (default false) and
 * `mode`: create | upsert. Every rejected row is returned with the reason, so a
 * partial import is never a mystery.
 */
r.post('/import/:entity', IMPORT, asyncH(async (req, res) => {
  const t = writeTenantId(req);
  const spec = DATA_SETS[req.params.entity];
  if (!spec) throw new HttpError(404, `Unknown data set "${req.params.entity}"`);
  const { dry_run: dryRun = true, mode = 'create', csv, rows } = req.body || {};

  let records = rows;
  if (!records && csv) records = parseCsv(csv);
  if (!Array.isArray(records) || !records.length) throw new HttpError(400, 'Provide rows[] or csv');
  if (records.length > 2000) throw new HttpError(400, 'Import at most 2000 rows at a time');

  // Resolve human-readable lookups (department "Engineering") to ids once.
  const idMaps = {};
  for (const [field, [table, col]] of Object.entries(spec.lookup || {})) {
    const [found] = await pool.query(`SELECT id, ${col} AS name FROM ${table} WHERE tenant_id = ?`, [t]);
    idMaps[field] = new Map(found.map((x) => [String(x.name).toLowerCase(), x.id]));
  }

  const accepted = [];
  const rejected = [];
  for (const [i, raw] of records.entries()) {
    const row = { ...raw };
    const missing = (spec.required || []).filter((c) => !row[c] && row[c] !== 0);
    if (missing.length) { rejected.push({ row: i + 1, reason: `Missing required column(s): ${missing.join(', ')}`, data: raw }); continue; }
    for (const field of Object.keys(spec.lookup || {})) {
      if (row[field] !== undefined && row[field] !== null && row[field] !== '') {
        const id = idMaps[field].get(String(row[field]).toLowerCase());
        if (!id) { rejected.push({ row: i + 1, reason: `Unknown ${field}: "${row[field]}"`, data: raw }); row.__reject = true; break; }
        row[`${field}_id`] = id;
      }
    }
    if (row.__reject) continue;
    accepted.push(row);
  }

  const created = [];
  if (!dryRun && accepted.length) {
    for (const row of accepted) {
      try {
        const id = await spec.insert(t, row, req.user.id);
        created.push({ id, ...row });
      } catch (e) {
        rejected.push({ reason: e.message, data: row });
      }
    }
    await audit(req, { action: 'import', entityType: req.params.entity, after: { created: created.length, rejected: rejected.length, mode } });
  }
  res.json({
    data: {
      dryRun: !!dryRun,
      mode,
      received: records.length,
      valid: accepted.length,
      created: created.length,
      rejected,
      templateColumns: spec.columns,
    },
  });
}));

/** GET /export/:entity — CSV download of a data set. */
r.get('/export/:entity', EXPORT, asyncH(async (req, res) => {
  const t = tenantId(req);
  const key = req.params.entity;

  const SELECTS = {
    employees: {
      columns: ['employee_code', 'first_name', 'last_name', 'email', 'phone', 'status', 'joined_on'],
      sql: `SELECT e.employee_code, e.first_name, e.last_name, e.email, e.phone, e.status, e.joined_on,
                   d.name AS department, ds.name AS designation, l.name AS location
            FROM employees e
            LEFT JOIN departments d ON d.id = e.department_id
            LEFT JOIN designations ds ON ds.id = e.designation_id
            LEFT JOIN locations l ON l.id = e.location_id
            WHERE e.tenant_id = ? AND e.deleted_at IS NULL ORDER BY e.employee_code`,
    },
    teams: {
      columns: ['name', 'code', 'description', 'status', 'department', 'team_lead', 'members'],
      sql: `SELECT tm.name, tm.code, tm.description, tm.status, d.name AS department,
                   CONCAT(l.first_name,' ',l.last_name) AS team_lead,
                   (SELECT COUNT(*) FROM team_members m WHERE m.team_id = tm.id AND m.status = 'active') AS members
            FROM teams tm
            LEFT JOIN departments d ON d.id = tm.department_id
            LEFT JOIN employees l ON l.id = tm.team_lead_id
            WHERE tm.tenant_id = ? ORDER BY tm.name`,
    },
    positions: {
      columns: ['title', 'code', 'status', 'employment_type', 'openings', 'filled', 'department', 'grade', 'location'],
      sql: `SELECT p.title, p.code, p.status, p.employment_type, p.openings, p.filled,
                   d.name AS department, g.name AS grade, l.name AS location
            FROM positions p
            LEFT JOIN departments d ON d.id = p.department_id
            LEFT JOIN grades g ON g.id = p.grade_id
            LEFT JOIN locations l ON l.id = p.location_id
            WHERE p.tenant_id = ? ORDER BY p.title`,
    },
    users: {
      columns: ['name', 'email', 'role', 'status', 'employee_code', 'last_login_at'],
      sql: `SELECT u.name, u.email, u.role, u.status, e.employee_code, u.last_login_at
            FROM users u LEFT JOIN employees e ON e.id = u.employee_id
            WHERE u.tenant_id = ? ORDER BY u.name`,
    },
    custom_fields: {
      columns: ['entity_type', 'field_key', 'label', 'field_type', 'required', 'visibility', 'status'],
      sql: `SELECT entity_type, field_key, label, field_type, required, visibility, status
            FROM custom_field_definitions WHERE tenant_id = ? ORDER BY entity_type, field_key`,
    },
    audit: {
      columns: ['created_at', 'actor_name', 'actor_role', 'action', 'module', 'entity_type', 'entity_id', 'ip', 'outcome'],
      sql: `SELECT created_at, actor_name, actor_role, action, module, entity_type, entity_id, ip, outcome
            FROM admin_audit_logs WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?`,
      extra: [2000],
      permission: 'administration.audit.view',
    },
  };

  const def = SELECTS[key];
  if (!def) throw new HttpError(404, `Nothing to export for "${key}"`);
  if (def.permission && !req.user.isPlatformAdmin && !(req.user.permissions || []).includes(def.permission)) {
    throw new HttpError(403, `Missing permission: ${def.permission}`);
  }
  const params = def.extra ? [t, ...def.extra] : [t];
  const [rows] = await pool.query(def.sql, params);
  const csv = toCsv(rows, def.columns.map((c) => ({ key: c, header: c.replace(/_/g, ' ').toUpperCase() })));
  await audit(req, { action: 'export', entityType: key, after: { rows: rows.length } });
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename=${key}-${dayjs().format('YYYYMMDD')}.csv`);
  res.send(csv);
}));

// ---------------------------------------------------------------- audit
/**
 * GET /audit — reads the shared `admin_audit_logs` view. Filterable by module,
 * actor, action, entity and outcome; paginated; exportable as CSV.
 */
r.get('/audit', AUDIT_READ, asyncH(async (req, res) => {
  const t = tenantId(req);
  const { limit, offset, page } = paging(req.query, 50);
  const where = ['tenant_id = ?']; const params = [t];
  if (req.query.module) { where.push('module = ?'); params.push(req.query.module); }
  if (req.query.actor) { where.push('actor_name LIKE ?'); params.push(`%${req.query.actor}%`); }
  if (req.query.action) { where.push('action LIKE ?'); params.push(`%${req.query.action}%`); }
  if (req.query.entity_type) { where.push('entity_type = ?'); params.push(req.query.entity_type); }
  if (req.query.entity_id) { where.push('entity_id = ?'); params.push(String(req.query.entity_id)); }
  if (req.query.outcome) { where.push('outcome = ?'); params.push(req.query.outcome); }
  if (req.query.from) { where.push('created_at >= ?'); params.push(`${dayjs(req.query.from).format('YYYY-MM-DD')} 00:00:00`); }
  if (req.query.to) { where.push('created_at <= ?'); params.push(`${dayjs(req.query.to).format('YYYY-MM-DD')} 23:59:59`); }
  const base = `FROM admin_audit_logs WHERE ${where.join(' AND ')}`;
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total ${base}`, params);

  if (req.query.format === 'csv') return sendAuditCsv(req, res, base, params);

  const [rows] = await pool.query(
    `SELECT id, created_at, actor_user_id, actor_name, actor_role, action, module, entity_type, entity_id, ip, request_id, outcome ${base}
     ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`, params
  );
  const [moduleRows] = await pool.query(
    'SELECT DISTINCT module FROM admin_audit_logs WHERE tenant_id = ? ORDER BY module', [t]
  );
  res.json({
    data: rows,
    meta: {
      total: Number(total), page, pages: Math.ceil(Number(total) / limit), limit,
      modules: moduleRows.map((m) => m.module).filter(Boolean),
    },
  });
}));

/** GET /audit/stats — activity counts by module and by day, for the admin charts. */
r.get('/audit/stats', AUDIT_READ, asyncH(async (req, res) => {
  const t = tenantId(req);
  const days = Math.min(90, Math.max(7, int(req.query.days, 30)));
  const [byModule] = await pool.query(
    `SELECT module, COUNT(*) AS c FROM admin_audit_logs
     WHERE tenant_id = ? AND created_at > DATE_SUB(NOW(), INTERVAL ? DAY) GROUP BY module ORDER BY c DESC`, [t, days]
  );
  const [byDay] = await pool.query(
    `SELECT DATE(created_at) AS day, COUNT(*) AS c FROM admin_audit_logs
     WHERE tenant_id = ? AND created_at > DATE_SUB(NOW(), INTERVAL ? DAY) GROUP BY day ORDER BY day`, [t, days]
  );
  const [byActor] = await pool.query(
    `SELECT actor_name, COUNT(*) AS c FROM admin_audit_logs
     WHERE tenant_id = ? AND created_at > DATE_SUB(NOW(), INTERVAL ? DAY) GROUP BY actor_name ORDER BY c DESC LIMIT 10`, [t, days]
  );
  res.json({ data: { days, byModule, byDay, byActor } });
}));

module.exports = r;

const AUDIT_CSV_COLUMNS = ['created_at', 'actor_name', 'actor_role', 'actor_email', 'action', 'module', 'entity_type', 'entity_id', 'ip', 'request_id', 'outcome'];

/** Streams the audit trail as CSV. Shared by `?format=csv` and /audit/export. */
async function sendAuditCsv(req, res, base, params) {
  const [rows] = await pool.query(
    `SELECT ${AUDIT_CSV_COLUMNS.join(', ')} ${base} ORDER BY created_at DESC LIMIT 10000`, params
  );
  await audit(req, { action: 'audit.export', entityType: 'audit', after: { rows: rows.length } });
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename=audit-${dayjs().format('YYYYMMDD')}.csv`);
  return res.send(toCsv(rows, AUDIT_CSV_COLUMNS.map((c) => ({ key: c, header: c.toUpperCase() }))));
}

/**
 * GET /audit/export?format=csv — declared before /audit/:id so that "export" is
 * never parsed as an audit id.
 */
r.get('/audit/export', AUDIT_READ, asyncH(async (req, res) => {
  const t = tenantId(req);
  const where = ['tenant_id = ?']; const params = [t];
  if (req.query.module) { where.push('module = ?'); params.push(req.query.module); }
  if (req.query.outcome) { where.push('outcome = ?'); params.push(req.query.outcome); }
  return sendAuditCsv(req, res, `FROM admin_audit_logs WHERE ${where.join(' AND ')}`, params);
}));

/** GET /audit/:id — one entry with its full before/after images. */
r.get('/audit/:id', AUDIT_READ, asyncH(async (req, res) => {
  const [rows] = await pool.query(
    'SELECT * FROM admin_audit_logs WHERE id = ? AND tenant_id = ?', [int(req.params.id), tenantId(req)]
  );
  if (!rows[0]) throw new HttpError(404, 'Audit entry not found');
  const row = decode(rows[0], ['before_json', 'after_json']);
  res.json({
    data: {
      ...row,
      before_json: safeJson(row.before_json),
      after_json: safeJson(row.after_json),
    },
  });
}));

const safeJson = (v) => {
  if (!v) return null;
  try { return typeof v === 'string' ? JSON.parse(v) : v; } catch { return v; }
};

