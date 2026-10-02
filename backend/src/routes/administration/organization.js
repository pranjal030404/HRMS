/**
 * Organization Builder — the company chart, assembled for configuration.
 *
 * The individual entities (departments, designations, grades, locations, business
 * units, cost centres) keep their existing `/api/org` endpoints so nothing is
 * duplicated. This router adds the composite view the builder UI renders in one
 * call, plus the two structures the product did not have before: teams and
 * positions.
 */
const express = require('express');
const { pool } = require('../../config/db');
const { asyncH, HttpError } = require('../../utils/helpers');
const { requirePermission } = require('../../middleware/auth');
const { tenantId, writeTenantId, crud, audit, int, paging, j, unj } = require('./_shared');

const r = express.Router();

const READ = requirePermission('administration.organization.view', { anyOf: ['org.manage', 'settings.view'] });

/**
 * GET /organization/structure
 * One request, the whole chart: business units → departments → teams, with the
 * positions that belong to each department and the headcount on every node.
 */
r.get('/organization/structure', READ, asyncH(async (req, res) => {
  const t = tenantId(req);
  const [units] = await pool.query(
    `SELECT bu.id, bu.name, bu.code, bu.description, bu.head_employee_id, bu.parent_id, bu.status,
            CONCAT(h.first_name,' ',h.last_name) AS head_name
     FROM business_units bu LEFT JOIN employees h ON h.id = bu.head_employee_id
     WHERE bu.tenant_id = ? AND (bu.status IS NULL OR bu.status <> 'inactive')
     ORDER BY bu.name`, [t]
  );
  const [depts] = await pool.query(
    `SELECT d.id, d.name, d.code, d.description, d.parent_id, d.head_employee_id, d.location_id, d.status,
            l.name AS location_name,
            CONCAT(h.first_name,' ',h.last_name) AS head_name,
            (SELECT COUNT(*) FROM employees e WHERE e.department_id = d.id AND e.deleted_at IS NULL AND e.status NOT IN ('exited')) AS headcount
     FROM departments d
     LEFT JOIN employees h ON h.id = d.head_employee_id
     LEFT JOIN locations l ON l.id = d.location_id
     WHERE d.tenant_id = ? AND d.archived_at IS NULL AND (d.status IS NULL OR d.status <> 'inactive')
     ORDER BY d.name`, [t]
  );
  const [teams] = await pool.query(
    `SELECT tm.id, tm.name, tm.code, tm.department_id, tm.business_unit_id, tm.location_id, tm.status,
            tm.team_lead_id, tm.manager_id,
            CONCAT(l.first_name,' ',l.last_name) AS lead_name,
            (SELECT COUNT(*) FROM team_members m WHERE m.team_id = tm.id AND m.status = 'active') AS member_count
     FROM teams tm
     LEFT JOIN employees l ON l.id = tm.team_lead_id
     WHERE tm.tenant_id = ? AND (tm.status IS NULL OR tm.status <> 'inactive')
     ORDER BY tm.name`, [t]
  );
  const [positions] = await pool.query(
    `SELECT p.id, p.title, p.code, p.department_id, p.designation_id, p.grade_id, p.job_level_id,
            p.location_id, p.employment_type, p.openings, p.filled, p.status,
            g.name AS grade_name, jl.name AS job_level_name, ds.name AS designation_name
     FROM positions p
     LEFT JOIN grades g ON g.id = p.grade_id
     LEFT JOIN job_levels jl ON jl.id = p.job_level_id
     LEFT JOIN designations ds ON ds.id = p.designation_id
     WHERE p.tenant_id = ? AND (p.status IS NULL OR p.status <> 'inactive')
     ORDER BY p.title`, [t]
  );
  const [levels] = await pool.query(
    `SELECT id, name, code, level, status FROM job_levels WHERE tenant_id = ? AND (status IS NULL OR status <> 'inactive') ORDER BY level, name`, [t]
  );
  const [grades] = await pool.query(
    `SELECT id, name, code, level, career_track, status FROM grades WHERE tenant_id = ? AND (status IS NULL OR status <> 'inactive') ORDER BY level, name`, [t]
  );

  const unitsWithChildren = units.map((u) => ({
    ...u,
    departments: depts.filter((d) => d.parent_id === u.id)
      .map((d) => ({
        ...d,
        subDepartments: depts.filter((x) => x.parent_id === d.id),
        teams: teams.filter((tm) => tm.department_id === d.id),
        positions: positions.filter((p) => p.department_id === d.id),
      })),
  }));
  const assignedDept = new Set(unitsWithChildren.flatMap((u) => u.departments.map((d) => d.id)));
  const orphans = depts.filter((d) => !assignedDept.has(d.id) && !units.some((u) => u.id === d.parent_id));

  res.json({
    data: {
      businessUnits: unitsWithChildren,
      unassignedDepartments: orphans.map((d) => ({ ...d, teams: teams.filter((tm) => tm.department_id === d.id) })),
      standaloneTeams: teams.filter((tm) => !tm.department_id),
      positionsWithoutDepartment: positions.filter((p) => !p.department_id),
      jobLevels: levels,
      grades,
      counts: {
        businessUnits: units.length,
        departments: depts.length,
        teams: teams.length,
        positions: positions.length,
        headcount: depts.reduce((n, d) => n + Number(d.headcount || 0), 0),
        vacancies: positions.reduce((n, p) => n + Math.max(0, Number(p.openings || 0) - Number(p.filled || 0)), 0),
      },
    },
  });
}));

/**
 * GET /organization/health
 * Configuration gaps that quietly break downstream modules: departments without a
 * head, teams without a lead, employees with no department/position, vacant
 * positions, custom fields with no owner.
 */
r.get('/organization/health', requirePermission('administration.dashboard.view', { anyOf: ['administration.organization.view', 'org.manage'] }), asyncH(async (req, res) => {
  const t = tenantId(req);
  const q = async (sql, params = [t]) => (await pool.query(sql, params))[0];
  const issues = [];

  const noHead = await q(
    `SELECT d.id, d.name FROM departments d WHERE d.tenant_id = ? AND d.archived_at IS NULL
       AND d.head_employee_id IS NULL`);
  if (noHead.length) issues.push({ key: 'departments_without_head', severity: 'warning', count: noHead.length, message: `${noHead.length} department(s) have no department head`, items: noHead.slice(0, 10) });

  const orphanTeams = await q(
    `SELECT tm.id, tm.name FROM teams tm WHERE tm.tenant_id = ? AND (tm.status IS NULL OR tm.status <> 'inactive') AND tm.team_lead_id IS NULL`);
  if (orphanTeams.length) issues.push({ key: 'teams_without_lead', severity: 'warning', count: orphanTeams.length, message: `${orphanTeams.length} team(s) have no team lead`, items: orphanTeams.slice(0, 10) });

  const empNoDept = await q(
    `SELECT COUNT(*) AS c FROM employees WHERE tenant_id = ? AND deleted_at IS NULL AND department_id IS NULL`);
  if (Number(empNoDept[0].c)) issues.push({ key: 'employees_without_department', severity: 'warning', count: Number(empNoDept[0].c), message: `${empNoDept[0].c} active employee(s) are not in a department` });

  const empNoPos = await q(
    `SELECT COUNT(*) AS c FROM employees WHERE tenant_id = ? AND deleted_at IS NULL AND position_id IS NULL AND status NOT IN ('exited')`);
  if (Number(empNoPos[0].c)) issues.push({ key: 'employees_without_position', severity: 'info', count: Number(empNoPos[0].c), message: `${empNoPos[0].c} employee(s) have no position assigned` });

  const usersNoRole = await q(
    `SELECT COUNT(*) AS c FROM users WHERE tenant_id = ? AND status = 'active' AND role IS NULL`);
  if (Number(usersNoRole[0].c)) issues.push({ key: 'users_without_role', severity: 'critical', count: Number(usersNoRole[0].c), message: `${usersNoRole[0].c} active login(s) have no role assigned` });

  const vacant = await q(
    `SELECT COUNT(*) AS c FROM positions WHERE tenant_id = ? AND (status IS NULL OR status = 'open') AND filled < openings`);
  if (Number(vacant[0].c)) issues.push({ key: 'open_positions', severity: 'info', count: Number(vacant[0].c), message: `${vacant[0].c} position(s) are open` });

  const customFieldsNoEntity = await q(
    `SELECT COUNT(*) AS c FROM custom_field_definitions WHERE tenant_id = ? AND status = 'active' AND entity_type IS NULL`);
  if (Number(customFieldsNoEntity[0].c)) issues.push({ key: 'custom_fields_unbound', severity: 'info', count: Number(customFieldsNoEntity[0].c), message: `${customFieldsNoEntity[0].c} custom field(s) are not bound to an entity` });

  res.json({ data: issues, meta: { healthy: issues.filter((i) => i.severity !== 'critical').length === 0 } });
}));

// ---------------------------------------------------------------- teams
const TEAM_FIELDS = ['name', 'code', 'description', 'department_id', 'business_unit_id', 'location_id',
  'cost_center_id', 'team_lead_id', 'manager_id', 'status', 'effective_from', 'effective_to'];

crud(r, '/teams', {
  table: 'teams',
  fields: TEAM_FIELDS,
  perms: { read: 'administration.organization.view', write: 'administration.teams.manage', delete: 'administration.teams.manage', anyOf: ['org.manage'] },
  searchFields: ['name', 'code', 'description'],
  filterable: ['department_id', 'business_unit_id', 'location_id', 'status'],
  orderBy: 'name',
  softDelete: null,
  stamps: ['created_by', 'updated_by'],
  uniqueKeys: [{ key: 'code', col: 'code' }],
});

/** Team membership. Members are employees, never users — access follows people. */
r.get('/teams/:id/members', requirePermission('administration.organization.view', { anyOf: ['org.manage'] }), asyncH(async (req, res) => {
  const t = tenantId(req);
  const [team] = await pool.query('SELECT * FROM teams WHERE id = ? AND tenant_id = ?', [req.params.id, t]);
  if (!team[0]) throw new HttpError(404, 'Team not found');
  const [rows] = await pool.query(
    `SELECT m.id, m.employee_id, m.member_role, m.allocation_pct, m.effective_from, m.effective_to, m.status,
            e.employee_code, e.first_name, e.last_name, e.email, e.designation_id, ds.name AS designation,
            d.name AS department_name
     FROM team_members m
     JOIN employees e ON e.id = m.employee_id
     LEFT JOIN designations ds ON ds.id = e.designation_id
     LEFT JOIN departments d ON d.id = e.department_id
     WHERE m.team_id = ? ORDER BY m.status, e.first_name`, [team[0].id]
  );
  res.json({ data: rows, meta: { team: team[0], count: rows.length } });
}));

r.post('/teams/:id/members', requirePermission('administration.teams.manage', { anyOf: ['org.manage'] }), asyncH(async (req, res) => {
  const t = writeTenantId(req);
  const [team] = await pool.query('SELECT * FROM teams WHERE id = ? AND tenant_id = ?', [req.params.id, t]);
  if (!team[0]) throw new HttpError(404, 'Team not found');
  const { employee_id, member_role, allocation_pct, effective_from } = req.body || {};
  const employeeId = int(employee_id);
  if (!employeeId) throw new HttpError(400, 'employee_id is required');
  // The employee must belong to this company — membership is never cross-tenant.
  const [emp] = await pool.query('SELECT id, first_name, last_name FROM employees WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL', [employeeId, t]);
  if (!emp[0]) throw new HttpError(404, 'Employee not found in this company');
  const [dupe] = await pool.query("SELECT id FROM team_members WHERE team_id = ? AND employee_id = ? AND status = 'active'", [team[0].id, employeeId]);
  if (dupe[0]) throw new HttpError(409, 'That employee is already an active member of this team');
  const [ins] = await pool.query(
    `INSERT INTO team_members (tenant_id, team_id, employee_id, member_role, allocation_pct, effective_from, status)
     VALUES (?,?,?,?,?,?,'active')`,
    [t, team[0].id, employeeId, member_role || 'member', int(allocation_pct, 100), effective_from || null]
  );
  await audit(req, { action: 'team.member.add', entityType: 'team', entityId: team[0].id, after: { employeeId, member_role: member_role || 'member' } });
  res.status(201).json({ data: { id: ins.insertId, employeeId } });
}));

r.delete('/teams/members/:memberId', requirePermission('administration.teams.manage', { anyOf: ['org.manage'] }), asyncH(async (req, res) => {
  const t = writeTenantId(req);
  const [rows] = await pool.query('SELECT * FROM team_members WHERE id = ? AND tenant_id = ?', [req.params.memberId, t]);
  if (!rows[0]) throw new HttpError(404, 'Membership not found');
  await pool.query('UPDATE team_members SET status = ?, effective_to = CURDATE() WHERE id = ? AND tenant_id = ?', ['inactive', req.params.memberId, t]);
  await audit(req, { action: 'team.member.remove', entityType: 'team', entityId: rows[0].team_id, before: rows[0] });
  res.json({ ok: true });
}));

// ---------------------------------------------------------------- positions
crud(r, '/positions', {
  table: 'positions',
  fields: ['title', 'code', 'description', 'department_id', 'designation_id', 'grade_id', 'job_level_id',
    'location_id', 'employment_type', 'openings', 'filled', 'status', 'opened_on', 'closed_on'],
  perms: { read: 'administration.organization.view', write: 'administration.positions.manage', delete: 'administration.positions.manage', anyOf: ['org.manage'] },
  searchFields: ['title', 'code', 'description'],
  filterable: ['department_id', 'designation_id', 'grade_id', 'job_level_id', 'location_id', 'status', 'employment_type'],
  orderBy: 'title',
  stamps: ['created_by', 'updated_by'],
  uniqueKeys: [{ key: 'code', col: 'code' }],
});

/**
 * GET /positions/:id/pipeline
 * Who is in the position and who is expected next — recruitment and onboarding
 * read from this rather than re-deriving the chain.
 */
r.get('/positions/:id/pipeline', requirePermission('administration.organization.view', { anyOf: ['org.manage'] }), asyncH(async (req, res) => {
  const t = tenantId(req);
  const [pos] = await pool.query('SELECT * FROM positions WHERE id = ? AND tenant_id = ?', [req.params.id, t]);
  if (!pos[0]) throw new HttpError(404, 'Position not found');
  const [incumbent] = await pool.query(
    `SELECT e.id, e.employee_code, e.first_name, e.last_name, e.status, e.joined_on, e.email
     FROM employees e WHERE e.position_id = ? AND e.deleted_at IS NULL ORDER BY e.joined_on`, [pos[0].id]
  );
  const [candidates] = await pool.query(
    `SELECT c.id, c.name, c.email, c.stage, c.applied_at, c.source
     FROM candidates c
     WHERE c.tenant_id = ? AND c.position_id = ? AND c.stage NOT IN ('rejected','withdrawn','hired')
     ORDER BY c.applied_at DESC`, [t, pos[0].id]
  ).catch(() => [[]]);
  res.json({ data: { position: pos[0], incumbents: incumbent, candidates } });
}));

// --------------------------------------------------- employee relationships
const REL_FIELDS = ['employee_id', 'related_employee_id', 'relationship_type_id', 'effective_from', 'effective_to', 'is_primary', 'notes'];

r.get('/relationship-types', requirePermission('administration.organization.view', { anyOf: ['org.manage'] }), asyncH(async (req, res) => {
  const t = tenantId(req);
  const [rows] = await pool.query(
    'SELECT * FROM employee_relationship_types WHERE tenant_id = ? OR tenant_id IS NULL ORDER BY is_primary_type DESC, sort_order, name', [t]
  );
  res.json({ data: rows });
}));

crud(r, '/relationship-types', {
  table: 'employee_relationship_types',
  fields: ['code', 'name', 'description', 'is_primary_type', 'sort_order'],
  perms: { read: 'administration.organization.view', write: 'administration.organization.manage', delete: 'administration.organization.manage', anyOf: ['org.manage'] },
  searchFields: ['name', 'code'],
  orderBy: 'sort_order, name',
  uniqueKeys: [{ key: 'code', col: 'code' }],
});

crud(r, '/employee-relationships', {
  table: 'employee_relationships',
  fields: REL_FIELDS,
  perms: { read: 'administration.organization.view', write: 'administration.organization.manage', delete: 'administration.organization.manage', anyOf: ['org.manage'] },
  filterable: ['employee_id', 'relationship_type_id', 'is_primary'],
  orderBy: 'employee_id, is_primary DESC',
  stamps: ['created_by'],
});

/** GET /employees/:employeeId/relationships — the reporting/dotted-line view. */
r.get('/employee-relationships/by-employee/:employeeId', requirePermission('administration.organization.view', { anyOf: ['org.manage'] }), asyncH(async (req, res) => {
  const t = tenantId(req);
  const employeeId = int(req.params.employeeId);
  const [emp] = await pool.query('SELECT id, tenant_id FROM employees WHERE id = ?', [employeeId]);
  if (!emp[0] || (emp[0].tenant_id != null && String(emp[0].tenant_id) !== String(t))) {
    throw new HttpError(404, 'Employee not found');
  }
  const [rows] = await pool.query(
    `SELECT rel.*, rt.code AS type_code, rt.name AS type_name, rt.is_primary_type,
            e.employee_code, e.first_name, e.last_name, e.email, ds.name AS designation
     FROM employee_relationships rel
     JOIN employee_relationship_types rt ON rt.id = rel.relationship_type_id
     JOIN employees e ON e.id = rel.related_employee_id
     LEFT JOIN designations ds ON ds.id = e.designation_id
     WHERE rel.tenant_id = ? AND rel.employee_id = ? ORDER BY rt.is_primary_type DESC, rt.sort_order`,
    [t, employeeId]
  );
  res.json({ data: rows });
}));

// ------------------------------------------------------ org-wide assignments
/**
 * POST /organization/assignments
 * Move or copy people in bulk (department, position, designation, grade, level,
 * location, cost centre, team). Every affected employee is validated against
 * this company, and the whole operation is one audit entry with a count.
 */
r.post('/organization/assignments', requirePermission('administration.organization.manage', { anyOf: ['org.manage', 'employee.edit'] }), asyncH(async (req, res) => {
  const t = writeTenantId(req);
  const { employee_ids, department_id, position_id, designation_id, grade_id, job_level_id, location_id, cost_center_id, team_id, member_role, dry_run } = req.body || {};
  const ids = [...new Set((employee_ids || []).map((x) => int(x)).filter(Boolean))];
  if (!ids.length) throw new HttpError(400, 'employee_ids[] is required');
  if (ids.length > 500) throw new HttpError(400, 'Assign at most 500 employees at a time');

  // Everything referenced must live in this company.
  const ref = async (table, col, id, label) => {
    if (id === undefined || id === null || id === '') return;
    const [rows] = await pool.query(`SELECT id FROM ${table} WHERE id = ? AND tenant_id = ?`, [int(id), t]);
    if (!rows[0]) throw new HttpError(400, `${label} #${id} does not belong to this company`);
  };
  await ref('departments', 'department_id', department_id, 'Department');
  await ref('positions', 'position_id', position_id, 'Position');
  await ref('designations', 'designation_id', designation_id, 'Designation');
  await ref('grades', 'grade_id', grade_id, 'Grade');
  await ref('job_levels', 'job_level_id', job_level_id, 'Job level');
  await ref('locations', 'location_id', location_id, 'Location');
  await ref('cost_centers', 'cost_center_id', cost_center_id, 'Cost centre');
  await ref('teams', 'team_id', team_id, 'Team');

  const [owned] = await pool.query(
    `SELECT id, employee_code, first_name, last_name FROM employees
     WHERE tenant_id = ? AND id IN (?) AND deleted_at IS NULL`, [t, ids]
  );
  const ownedIds = owned.map((e) => e.id);
  const rejected = ids.filter((id) => !ownedIds.includes(id));

  const sets = []; const params = [];
  for (const [col, val] of [['department_id', department_id], ['position_id', position_id],
    ['designation_id', designation_id], ['grade_id', grade_id], ['job_level_id', job_level_id],
    ['location_id', location_id], ['cost_center_id', cost_center_id]]) {
    if (val !== undefined && val !== null && val !== '') { sets.push(`${col} = ?`); params.push(int(val)); }
  }
  if (!sets.length && !team_id) throw new HttpError(400, 'Nothing to assign');

  let updated = 0;
  if (ownedIds.length && sets.length) {
    if (dry_run) {
      const [est] = await pool.query(
        `SELECT COUNT(*) AS c FROM employees WHERE tenant_id = ? AND id IN (?)`, [t, ownedIds]
      );
      updated = Number(est[0].c);
    } else {
      const [res2] = await pool.query(
        `UPDATE employees SET ${sets.join(', ')} WHERE tenant_id = ? AND id IN (?)`, [...params, t, ownedIds]
      );
      updated = res2.affectedRows;
      if (team_id) {
        for (const eid of ownedIds) {
          const [dupe] = await pool.query("SELECT id FROM team_members WHERE team_id = ? AND employee_id = ? AND status = 'active'", [int(team_id), eid]);
          if (!dupe[0]) {
            await pool.query(
              `INSERT INTO team_members (tenant_id, team_id, employee_id, member_role, allocation_pct, status)
               VALUES (?,?,?,?,100,'active')`, [t, int(team_id), eid, member_role || 'member']
            );
          }
        }
      }
    }
  }

  await audit(req, {
    action: 'organization.assignment',
    entityType: 'employee',
    after: { employeeIds: ownedIds, rejected, department_id, position_id, team_id, dry_run: !!dry_run },
  });
  res.json({ data: { requested: ids.length, updated, applied: !dry_run, rejected, employees: owned.map((e) => ({ id: e.id, code: e.employee_code, name: `${e.first_name} ${e.last_name}` })) } });
}));

module.exports = r;
