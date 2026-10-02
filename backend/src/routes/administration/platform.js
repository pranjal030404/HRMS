/**
 * Module & Platform Configuration — what the company uses, how it is secured, and
 * what each configurable change looked like before.
 *
 * Disabling a module is real: `requirePermission(perm, { module })` denies the
 * module's routes while it is off, so a tenant can switch a feature off entirely
 * rather than merely hiding its menu entry.
 */
const express = require('express');
const { pool } = require('../../config/db');
const { asyncH, HttpError } = require('../../utils/helpers');
const { requirePermission } = require('../../middleware/auth');
const { tenantId, writeTenantId, audit, int, bool, decode, j, unj, paging } = require('./_shared');
const rbac = require('../../services/rbac');
const { MODULE_CATALOG, DEFAULT_SECURITY_POLICIES } = require('../../utils/permissions');

const r = express.Router();

const MODULES_READ = requirePermission('administration.modules.view', { anyOf: ['settings.view'] });
const MODULES_WRITE = requirePermission('administration.modules.manage', { anyOf: ['settings.manage'] });
const SECURITY_READ = requirePermission('administration.security.view', { anyOf: ['settings.view'] });
const SECURITY_WRITE = requirePermission('administration.security.manage', { anyOf: ['settings.manage'] });
const ONBOARDING_READ = requirePermission('administration.onboarding.view', { anyOf: ['settings.view'] });
const ONBOARDING_WRITE = requirePermission('administration.onboarding.manage', { anyOf: ['settings.manage'] });

// ---------------------------------------------------------------- modules
/** GET /modules — the catalog plus this company's on/off state and settings. */
r.get('/modules', MODULES_READ, asyncH(async (req, res) => {
  const t = tenantId(req);
  const [rows] = await pool.query(
    'SELECT * FROM module_configurations WHERE tenant_id = ? ORDER BY category, module_key', [t]
  );
  const byKey = new Map(rows.map((x) => [x.module_key, decode(x, ['settings'])]));
  const enabled = new Set(await rbac.enabledModules(t));
  const planRows = await pool.query(
    `SELECT plan_key, name FROM platform_plans p WHERE p.active = 1 AND (p.plan_key = 'enterprise' OR EXISTS (
       SELECT 1 FROM tenants tn WHERE tn.id = ? AND tn.plan = p.plan_key)) LIMIT 1`, [t]
  ).catch(() => [[]]);

  const data = MODULE_CATALOG.map((m) => {
    const row = byKey.get(m.key);
    return {
      key: m.key,
      name: m.name,
      category: row?.category || m.category || 'general',
      description: row?.description ?? m.description ?? null,
      enabled: enabled.has(m.key),
      defaultEnabled: !!m.defaultEnabled,
      settings: row?.settings || {},
      updatedAt: row?.updated_at || null,
    };
  });
  res.json({ data, meta: { total: data.length, enabled: data.filter((x) => x.enabled).length, plan: planRows[0]?.name || null } });
}));

/** PUT /modules/:key — enable, disable or configure one module. */
r.put('/modules/:key', MODULES_WRITE, asyncH(async (req, res) => {
  const t = writeTenantId(req);
  const key = String(req.params.key);
  if (!MODULE_CATALOG.some((m) => m.key === key)) throw new HttpError(404, 'Unknown module');
  const { enabled, settings, name, category, description } = req.body || {};
  const [rows] = await pool.query('SELECT * FROM module_configurations WHERE tenant_id = ? AND module_key = ?', [t, key]);
  const before = rows[0] ? decode(rows[0], ['settings']) : null;
  const values = {
    module_key: key,
    name: name ?? before?.name ?? MODULE_CATALOG.find((m) => m.key === key).name,
    category: category ?? before?.category ?? 'general',
    enabled: enabled === undefined ? (before ? before.enabled : 1) : bool(enabled),
    settings: j(settings ?? unj(before?.settings, {}) ?? {}),
  };

  if (rows[0]) {
    await pool.query(
      `UPDATE module_configurations SET name = ?, category = ?, enabled = ?, settings = ?, updated_by = ?, updated_at = NOW()
       WHERE tenant_id = ? AND module_key = ?`,
      [values.name, values.category, values.enabled, values.settings, req.user.id, t, key]
    );
  } else {
    await pool.query(
      `INSERT INTO module_configurations (tenant_id, module_key, name, category, enabled, settings, updated_by)
       VALUES (?,?,?,?,?,?,?)`,
      [t, key, values.name, values.category, values.enabled, values.settings, req.user.id]
    );
  }
  // Keep the cached enabled set honest immediately after the change.
  rbac.invalidateTenant(t);
  await audit(req, { action: 'module.update', entityType: 'module', entityId: key, before, after: values });
  res.json({ ok: true, data: values });
}));

/** POST /modules/:key/reset — back to the product default. */
r.post('/modules/:key/reset', MODULES_WRITE, asyncH(async (req, res) => {
  const t = writeTenantId(req);
  const key = String(req.params.key);
  const catalog = MODULE_CATALOG.find((m) => m.key === key);
  if (!catalog) throw new HttpError(404, 'Unknown module');
  const [before] = await pool.query('SELECT * FROM module_configurations WHERE tenant_id = ? AND module_key = ?', [t, key]);
  await pool.query(
    `UPDATE module_configurations SET enabled = ?, settings = '{}', updated_by = ?, updated_at = NOW() WHERE tenant_id = ? AND module_key = ?`,
    [catalog.defaultEnabled ? 1 : 0, req.user.id, t, key]
  );
  rbac.invalidateTenant(t);
  await audit(req, { action: 'module.reset', entityType: 'module', entityId: key, before: before[0] || null, after: { enabled: !!catalog.defaultEnabled } });
  res.json({ ok: true });
}));

// ---------------------------------------------------------------- menus
/** GET /menus — effective navigation for this company, with the required permission. */
r.get('/menus', requirePermission('administration.modules.view', { anyOf: ['settings.view'] }), asyncH(async (req, res) => {
  const t = tenantId(req);
  const [rows] = await pool.query(
    'SELECT * FROM menu_items WHERE tenant_id = ? ORDER BY sort_order, label', [t]
  );
  const items = decode(rows, []).map((m) => ({
    ...m,
    accessible: m.required_permission
      ? (req.user.isPlatformAdmin || req.user.permissions.includes(m.required_permission))
      : true,
  }));
  const byParent = new Map();
  for (const item of items) {
    const key = item.parent_key || 'root';
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(item);
  }
  res.json({
    data: (byParent.get('root') || []).filter((x) => x.visible),
    meta: { tree: Object.fromEntries(byParent), total: items.length } });
}));

r.put('/menus/:id', MODULES_WRITE, asyncH(async (req, res) => {
  const t = writeTenantId(req);
  const [rows] = await pool.query('SELECT * FROM menu_items WHERE id = ? AND tenant_id = ?', [int(req.params.id), t]);
  if (!rows[0]) throw new HttpError(404, 'Menu item not found');
  if (rows[0].is_system && req.body.route === undefined && req.body.label === undefined) {
    throw new HttpError(400, 'System menu entries can only be reordered or renamed');
  }
  const { label, icon, route, sort_order: sortOrder, required_permission: permission, visible } = req.body || {};
  const sets = []; const params = [];
  if (label !== undefined) { sets.push('label = ?'); params.push(label); }
  if (icon !== undefined) { sets.push('icon = ?'); params.push(icon); }
  if (route !== undefined) { sets.push('route = ?'); params.push(route); }
  if (sortOrder !== undefined) { sets.push('sort_order = ?'); params.push(int(sortOrder, 0)); }
  if (permission !== undefined) { sets.push('required_permission = ?'); params.push(permission || null); }
  if (visible !== undefined) { sets.push('visible = ?'); params.push(bool(visible)); }
  if (!sets.length) throw new HttpError(400, 'Nothing to update');
  params.push(rows[0].id, t);
  await pool.query(`UPDATE menu_items SET ${sets.join(', ')}, updated_at = NOW() WHERE id = ? AND tenant_id = ?`, params);
  await audit(req, { action: 'menu.update', entityType: 'module', entityId: rows[0].id, before: rows[0], after: req.body });
  res.json({ ok: true });
}));

// ---------------------------------------------------------------- widgets
r.get('/dashboard-widgets', requirePermission('administration.dashboard.view', { anyOf: ['settings.view'] }), asyncH(async (req, res) => {
  const [rows] = await pool.query(
    'SELECT * FROM dashboard_widgets WHERE tenant_id = ? ORDER BY sort_order, title', [tenantId(req)]
  );
  const data = decode(rows, ['config']).map((w) => ({
    ...w,
    accessible: w.required_permission
      ? (req.user.isPlatformAdmin || req.user.permissions.includes(w.required_permission))
      : true,
  }));
  res.json({ data });
}));

r.put('/dashboard-widgets/:id', MODULES_WRITE, asyncH(async (req, res) => {
  const t = writeTenantId(req);
  const [rows] = await pool.query('SELECT * FROM dashboard_widgets WHERE id = ? AND tenant_id = ?', [int(req.params.id), t]);
  if (!rows[0]) throw new HttpError(404, 'Widget not found');
  const { title, config, sort_order: sortOrder, visible, required_permission: permission } = req.body || {};
  const sets = []; const params = [];
  if (title !== undefined) { sets.push('title = ?'); params.push(title); }
  if (config !== undefined) { sets.push('config = ?'); params.push(j(config)); }
  if (sortOrder !== undefined) { sets.push('sort_order = ?'); params.push(int(sortOrder, 0)); }
  if (visible !== undefined) { sets.push('visible = ?'); params.push(bool(visible)); }
  if (permission !== undefined) { sets.push('required_permission = ?'); params.push(permission || null); }
  if (!sets.length) throw new HttpError(400, 'Nothing to update');
  params.push(rows[0].id, t);
  await pool.query(`UPDATE dashboard_widgets SET ${sets.join(', ')}, updated_at = NOW() WHERE id = ? AND tenant_id = ?`, params);
  await audit(req, { action: 'dashboard_widget.update', entityType: 'module', entityId: rows[0].id, before: decode(rows[0], ['config']), after: req.body });
  res.json({ ok: true });
}));

// ---------------------------------------------------------------- security
/**
 * GET /security/policies
 * Effective values: a tenant override when present, otherwise the platform
 * default. Each policy carries its own description and bounds so the UI can
 * render the right control without a second source of truth.
 */
r.get('/security/policies', SECURITY_READ, asyncH(async (req, res) => {
  const t = tenantId(req);
  const [rows] = await pool.query(
    'SELECT * FROM security_policies WHERE tenant_id = ? OR tenant_id IS NULL', [t]
  );
  const overrides = new Map();
  const defaults = new Map();
  for (const row of rows) {
    const parsed = unj(row.policy_value, {}) || {};
    const entry = { ...parsed, value: parsed.value !== undefined ? parsed.value : row.policy_value, __desc: parsed.__desc || row.description || null };
    if (row.tenant_id === null) defaults.set(row.policy_key, entry);
    else overrides.set(row.policy_key, entry);
  }
  const data = [...new Set([...Object.keys(DEFAULT_SECURITY_POLICIES || {}), ...defaults.keys(), ...overrides.keys()])]
    .sort()
    .map((key) => {
      const meta = (DEFAULT_SECURITY_POLICIES || {})[key] || {};
      const effective = overrides.get(key) || defaults.get(key) || meta;
      return {
        key,
        description: meta.__desc || effective.__desc || null,
        value: effective.value !== undefined ? effective.value : (meta.value ?? null),
        default: meta.value ?? null,
        overridden: overrides.has(key),
        type: typeof (effective.value !== undefined ? effective.value : meta.value),
        min: meta.min ?? null,
        max: meta.max ?? null,
      };
    });
  res.json({ data, meta: { total: data.length, overridden: data.filter((x) => x.overridden).length } });
}));

/** PUT /security/policies/:key — set this company's override. */
r.put('/security/policies/:key', SECURITY_WRITE, asyncH(async (req, res) => {
  const t = writeTenantId(req);
  const key = String(req.params.key);
  const [known] = await pool.query(
    'SELECT * FROM security_policies WHERE policy_key = ? AND (tenant_id = ? OR tenant_id IS NULL) LIMIT 1', [key, t]
  );
  if (!known[0]) throw new HttpError(404, 'Unknown policy');
  if (req.body?.value === undefined) throw new HttpError(400, 'value is required');

  const current = unj(known[0].policy_value, {}) || {};
  let value = req.body.value;
  const meta = (DEFAULT_SECURITY_POLICIES || {})[key] || {};
  if (typeof (current.value ?? meta.value) === 'boolean') {
    if (typeof value !== 'boolean') throw new HttpError(400, `"${key}" expects true or false`);
  } else if (typeof (current.value ?? meta.value) === 'number') {
    const n = Number(value);
    if (Number.isNaN(n)) throw new HttpError(400, `"${key}" expects a number`);
    if (meta.min !== undefined && n < meta.min) throw new HttpError(400, `"${key}" must be at least ${meta.min}`);
    if (meta.max !== undefined && n > meta.max) throw new HttpError(400, `"${key}" must be at most ${meta.max}`);
    value = n;
  }

  const payload = { __desc: current.__desc ?? meta.__desc ?? null, value };
  const [existing] = await pool.query('SELECT * FROM security_policies WHERE tenant_id = ? AND policy_key = ?', [t, key]);
  if (existing[0]) {
    await pool.query('UPDATE security_policies SET policy_value = ?, description = ?, updated_by = ?, updated_at = NOW() WHERE id = ? AND tenant_id = ?',
      [j(payload), payload.__desc, req.user.id, existing[0].id, t]);
  } else {
    await pool.query('INSERT INTO security_policies (tenant_id, policy_key, policy_value, description, updated_by) VALUES (?,?,?,?,?)',
      [t, key, j(payload), payload.__desc, req.user.id]);
  }
  await audit(req, { action: 'security.policy.update', entityType: 'security', entityId: key, before: known[0], after: payload });
  res.json({ ok: true, data: { key, value, overridden: true } });
}));

/** POST /security/policies/:key/reset — drop the override, fall back to the default. */
r.post('/security/policies/:key/reset', SECURITY_WRITE, asyncH(async (req, res) => {
  const t = writeTenantId(req);
  const key = String(req.params.key);
  const [rows] = await pool.query('SELECT * FROM security_policies WHERE tenant_id = ? AND policy_key = ?', [t, key]);
  if (!rows[0]) throw new HttpError(404, 'This policy has no company override');
  await pool.query('DELETE FROM security_policies WHERE id = ? AND tenant_id = ?', [rows[0].id, t]);
  const meta = (DEFAULT_SECURITY_POLICIES || {})[key] || {};
  await audit(req, { action: 'security.policy.reset', entityType: 'security', entityId: key, before: rows[0], after: { value: meta.value ?? null } });
  res.json({ ok: true, data: { key, value: meta.value ?? null, overridden: false } });
}));

/** GET /security/overview — posture summary: logins, MFA, sessions, restrictions. */
r.get('/security/overview', SECURITY_READ, asyncH(async (req, res) => {
  const t = tenantId(req);
  const one = async (sql, params = [t]) => Number((await pool.query(sql, params))[0][0].c);
  const [users] = await pool.query(
    `SELECT COUNT(*) AS total,
            SUM(status = 'active') AS active,
            SUM(status = 'suspended') AS suspended,
            SUM(status = 'disabled') AS disabled,
            SUM(status = 'invited') AS invited,
            SUM(locked_until IS NOT NULL AND locked_until > NOW()) AS locked,
            SUM(must_change_password = 1) AS must_change
     FROM users WHERE tenant_id = ?`, [t]
  );
  const [sessions] = await pool.query(
    `SELECT COUNT(*) AS active_sessions, COUNT(DISTINCT user_id) AS users_with_sessions
     FROM refresh_tokens WHERE revoked_at IS NULL AND expires_at > NOW()
       AND user_id IN (SELECT id FROM users WHERE tenant_id = ?)`, [t]
  );
  const [ips] = await pool.query('SELECT COUNT(*) AS c FROM ip_restrictions WHERE tenant_id = ? AND active = 1', [t]);
  const [delegations] = await pool.query('SELECT COUNT(*) AS c FROM approval_delegations WHERE tenant_id = ? AND active = 1', [t]);
  const [stale] = await pool.query(
    `SELECT COUNT(*) AS c FROM users WHERE tenant_id = ? AND last_login_at IS NOT NULL AND last_login_at < DATE_SUB(NOW(), INTERVAL 90 DAY)`, [t]
  );
  res.json({
    data: {
      users: users[0],
      sessions: sessions[0],
      activeIpRestrictions: Number(ips[0].c),
      activeDelegations: Number(delegations[0].c),
      dormantAccounts: Number(stale[0].c),
      recentFailures: await one(
        `SELECT COUNT(*) AS c FROM audit_logs WHERE tenant_id = ? AND action LIKE 'auth.%failed%' AND created_at > DATE_SUB(NOW(), INTERVAL 7 DAY)`, [t]
      ),
    },
  });
}));

/** IP allow/deny lists — applied at the edge; stored here so admins can manage them. */
r.get('/security/ip-restrictions', SECURITY_READ, asyncH(async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM ip_restrictions WHERE tenant_id = ? ORDER BY active DESC, created_at DESC', [tenantId(req)]);
  res.json({ data: rows });
}));

r.post('/security/ip-restrictions', SECURITY_WRITE, asyncH(async (req, res) => {
  const t = writeTenantId(req);
  const { cidr, scope, applies_to: appliesTo, note } = req.body || {};
  if (!cidr) throw new HttpError(400, 'cidr is required (e.g. 203.0.113.0/24 or 10.0.0.5)');
  const normalised = normaliseCidr(String(cidr));
  if (!normalised) throw new HttpError(400, 'That is not a valid IPv4 address or CIDR block');
  const [dupe] = await pool.query('SELECT id FROM ip_restrictions WHERE tenant_id = ? AND cidr = ?', [t, normalised]);
  if (dupe[0]) throw new HttpError(409, 'That range is already on the list');
  const [ins] = await pool.query(
    'INSERT INTO ip_restrictions (tenant_id, cidr, scope, applies_to, note, active, created_by) VALUES (?,?,?,?,?,1,?)',
    [t, normalised, scope || 'allow', appliesTo || 'admin', note || null, req.user.id]
  );
  await audit(req, { action: 'security.ip.add', entityType: 'security', entityId: ins.insertId, after: { cidr: normalised, scope: scope || 'allow' } });
  res.status(201).json({ data: { id: ins.insertId, cidr: normalised } });
}));

r.delete('/security/ip-restrictions/:id', SECURITY_WRITE, asyncH(async (req, res) => {
  const t = writeTenantId(req);
  const [rows] = await pool.query('SELECT * FROM ip_restrictions WHERE id = ? AND tenant_id = ?', [int(req.params.id), t]);
  if (!rows[0]) throw new HttpError(404, 'Restriction not found');
  await pool.query('DELETE FROM ip_restrictions WHERE id = ? AND tenant_id = ?', [rows[0].id, t]);
  await audit(req, { action: 'security.ip.remove', entityType: 'security', entityId: rows[0].id, before: rows[0] });
  res.json({ ok: true });
}));

/** Validate and normalise an IPv4 address or CIDR block (stored in /32 or /24 form). */
function normaliseCidr(value) {
  const v = String(value).trim();
  const [addr, bitsRaw] = v.split('/');
  const octets = addr.split('.');
  if (octets.length !== 4 || !octets.every((o) => /^\d{1,3}$/.test(o) && Number(o) <= 255)) return null;
  const bits = bitsRaw === undefined ? 32 : Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return null;
  return `${octets.map((o) => Number(o)).join('.')}/${bits}`;
}

// ---------------------------------------------------------------- onboarding
/** GET /onboarding — the company's setup progress, step by step. */
r.get('/onboarding', ONBOARDING_READ, asyncH(async (req, res) => {
  const t = tenantId(req);
  const [[row]] = await pool.query('SELECT * FROM company_onboarding WHERE tenant_id = ? ORDER BY id DESC LIMIT 1', [t]);
  const steps = await buildChecklist(t, row);
  res.json({
    data: {
      ...decode(row || {}, ['completed_steps', 'skipped_steps', 'data']),
      currentStep: row?.current_step ?? 1,
      checklist: steps,
      progress: {
        total: steps.length,
        complete: steps.filter((s) => s.done || s.skipped).length,
        percent: steps.length ? Math.round((steps.filter((s) => s.done || s.skipped).length / steps.length) * 100) : 0,
      },
    },
  });
}));

/** Each onboarding step is a real query against live data — never a hard-coded flag. */
async function buildChecklist(tenant, row) {
  const completed = new Set((row && unj(row.completed_steps, [])) || []);
  const skipped = new Set((row && unj(row.skipped_steps, [])) || []);
  const count = async (sql) => Number((await pool.query(sql, [tenant]))[0][0].c);
  const definitions = [
    { key: 'company_profile', title: 'Company profile', description: 'Legal name, tax identifiers and address', done: await count('SELECT COUNT(*) AS c FROM companies WHERE tenant_id = ?') > 0 },
    { key: 'org_structure', title: 'Organization structure', description: 'At least one business unit or department', done: await count('SELECT COUNT(*) AS c FROM departments WHERE tenant_id = ? AND archived_at IS NULL') > 0 },
    { key: 'locations', title: 'Work locations', description: 'Where people work', done: await count('SELECT COUNT(*) AS c FROM locations WHERE tenant_id = ?') > 0 },
    { key: 'owner', title: 'Company owner', description: 'An active login with the Company Owner role', done: await count(`SELECT COUNT(*) AS c FROM users u WHERE u.tenant_id = ? AND u.status = 'active' AND (u.role = 'company_owner' OR u.id IN (SELECT user_id FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE r.name = 'company_owner'))`) > 0 },
    { key: 'employees', title: 'Employee records', description: 'People imported or created', done: await count('SELECT COUNT(*) AS c FROM employees WHERE tenant_id = ? AND deleted_at IS NULL') > 0 },
    { key: 'leave_types', title: 'Leave policies', description: 'Leave types and balances configured', done: await count('SELECT COUNT(*) AS c FROM leave_types WHERE tenant_id = ?') > 0 },
    { key: 'payroll', title: 'Payroll setup', description: 'Salary structures ready for the first run', done: await count('SELECT COUNT(*) AS c FROM salary_structures WHERE tenant_id = ?') > 0 },
    { key: 'expense_categories', title: 'Expense categories', description: 'Categories available for expense claims', done: await count('SELECT COUNT(*) AS c FROM expense_categories WHERE tenant_id = ?') > 0 },
    { key: 'workflows', title: 'Approval workflows', description: 'Leave and expense approvals configured', done: await count('SELECT COUNT(*) AS c FROM workflows WHERE tenant_id = ?') > 0 },
    { key: 'security', title: 'Security policies', description: 'Reviewed the security baseline', done: await count('SELECT COUNT(*) AS c FROM security_policies WHERE tenant_id = ?') > 0 },
  ];
  return definitions.map((d, i) => ({
    ...d,
    step: i + 1,
    done: d.done || completed.has(d.key),
    skipped: skipped.has(d.key),
  }));
}

/** PUT /onboarding/step/:key — mark a step done or explicitly skipped. */
r.put('/onboarding/step/:key', ONBOARDING_WRITE, asyncH(async (req, res) => {
  const t = writeTenantId(req);
  const key = String(req.params.key);
  const { skipped, current_step: currentStep } = req.body || {};
  const [[row]] = await pool.query('SELECT * FROM company_onboarding WHERE tenant_id = ? ORDER BY id DESC LIMIT 1', [t]);
  const steps = await buildChecklist(t, row);
  if (!steps.some((s) => s.key === key)) throw new HttpError(404, 'Unknown onboarding step');

  const completed = new Set((row && unj(row.completed_steps, [])) || []);
  const skipSet = new Set((row && unj(row.skipped_steps, [])) || []);
  if (skipped) { skipSet.add(key); completed.delete(key); } else { completed.add(key); skipSet.delete(key); }

  const payload = [Array.from(completed), Array.from(skipSet)];
  if (row) {
    await pool.query(
      'UPDATE company_onboarding SET completed_steps = ?, skipped_steps = ?, current_step = ?, updated_at = NOW() WHERE id = ? AND tenant_id = ?',
      [j(payload[0]), j(payload[1]), int(currentStep, row.current_step ?? 1), row.id, t]
    );
  } else {
    await pool.query(
      'INSERT INTO company_onboarding (tenant_id, current_step, completed_steps, skipped_steps, status, started_by) VALUES (?,?,?,?,?,?)',
      [t, int(currentStep, 1), j(payload[0]), j(payload[1]), 'in_progress', req.user.id]
    );
  }
  const after = await buildChecklist(t, row);
  const outstanding = after.filter((s) => !s.done && !s.skipped);
  const status = outstanding.length === 0 ? 'completed' : 'in_progress';
  await pool.query('UPDATE company_onboarding SET status = ?, updated_at = NOW() WHERE tenant_id = ?', [status, t]);
  if (status === 'completed') {
    await pool.query('UPDATE company_onboarding SET completed_at = NOW() WHERE tenant_id = ? AND completed_at IS NULL', [t]);
  }
  await audit(req, { action: 'onboarding.step', entityType: 'config', entityId: key, after: { skipped: !!skipped, status } });
  res.json({ ok: true, data: { key, skipped: !!skipped, outstanding: outstanding.map((s) => s.key), status } });
}));

// ---------------------------------------------------------------- config versions
/** GET /config/versions — every tracked configuration change. */
r.get('/config/versions', requirePermission('administration.config.view', { anyOf: ['settings.view'] }), asyncH(async (req, res) => {
  const t = tenantId(req);
  const where = ['tenant_id = ?']; const params = [t];
  if (req.query.module) { where.push('module = ?'); params.push(req.query.module); }
  if (req.query.status) { where.push('status = ?'); params.push(req.query.status); }
  const [rows] = await pool.query(
    `SELECT id, config_key, module, version, status, notes, effective_from, effective_to, created_at, published_at
     FROM config_versions WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT 200`, params
  );
  res.json({ data: decode(rows, []) });
}));

r.get('/config/versions/:id', requirePermission('administration.config.view', { anyOf: ['settings.view'] }), asyncH(async (req, res) => {
  const t = tenantId(req);
  const [rows] = await pool.query('SELECT * FROM config_versions WHERE id = ? AND tenant_id = ?', [int(req.params.id), t]);
  if (!rows[0]) throw new HttpError(404, 'Configuration version not found');
  res.json({ data: decode(rows[0], ['config']) });
}));

/** POST /config/versions — snapshot the current state of a config key. */
r.post('/config/versions', requirePermission('administration.config.manage', { anyOf: ['settings.manage'] }), asyncH(async (req, res) => {
  const t = writeTenantId(req);
  const { config_key: configKey, module, config, notes } = req.body || {};
  if (!configKey || config === undefined) throw new HttpError(400, 'config_key and config are required');
  const [[{ v }]] = await pool.query(
    'SELECT MAX(version) AS v FROM config_versions WHERE tenant_id = ? AND config_key = ?', [t, configKey]
  );
  const version = Number(v || 0) + 1;
  const [ins] = await pool.query(
    `INSERT INTO config_versions (tenant_id, config_key, module, version, status, config, notes, created_by)
     VALUES (?,?,?,?, 'draft', ?, ?, ?)`,
    [t, configKey, module || 'general', version, j(config), notes || null, req.user.id]
  );
  await audit(req, { action: 'config.version.create', entityType: 'config', entityId: ins.insertId, after: { configKey, version } });
  res.status(201).json({ data: { id: ins.insertId, version } });
}));

/** POST /config/versions/:id/rollback */
r.post('/config/versions/:id/rollback', requirePermission('administration.config.manage', { anyOf: ['settings.manage'] }), asyncH(async (req, res) => {
  const t = writeTenantId(req);
  const [rows] = await pool.query('SELECT * FROM config_versions WHERE id = ? AND tenant_id = ?', [int(req.params.id), t]);
  if (!rows[0]) throw new HttpError(404, 'Configuration version not found');
  const snapshot = unj(rows[0].config, {});
  const [[{ v }]] = await pool.query(
    'SELECT MAX(version) AS v FROM config_versions WHERE tenant_id = ? AND config_key = ?', [t, rows[0].config_key]
  );
  const version = Number(v || 0) + 1;
  const [ins] = await pool.query(
    `INSERT INTO config_versions (tenant_id, config_key, module, version, status, config, notes, effective_from, created_by)
     VALUES (?,?,?,?, 'published', ?, ?, NOW(), ?)`,
    [t, rows[0].config_key, rows[0].module, version, j(snapshot), `Rollback to version ${rows[0].version}`, req.user.id]
  );
  await pool.query("UPDATE config_versions SET status = 'superseded' WHERE tenant_id = ? AND config_key = ? AND status = 'published'", [t, rows[0].config_key]);
  await audit(req, { action: 'config.version.rollback', entityType: 'config', entityId: ins.insertId, before: rows[0], after: { rolledBackTo: rows[0].version, version } });
  res.json({ ok: true, data: { version, config: snapshot } });
}));

// ---------------------------------------------------------------- tenants
// Cross-tenant data. No `anyOf` fallback on purpose: nothing a tenant admin holds
// may open a list of other companies.
const PLATFORM_READ = requirePermission('platform.tenants.view');
const PLATFORM_WRITE = requirePermission('platform.tenants.manage');

/**
 * GET /tenants — the platform roster. Cross-tenant by definition, so it is
 * restricted to roles that explicitly hold platform.tenants.view.
 */
r.get('/tenants', PLATFORM_READ, asyncH(async (req, res) => {
  const { limit, offset, page } = paging(req.query, 25);
  const where = []; const params = [];
  if (req.query.q) { where.push('(t.name LIKE ? OR t.slug LIKE ?)'); params.push(`%${req.query.q}%`, `%${req.query.q}%`); }
  if (req.query.status) { where.push('t.status = ?'); params.push(req.query.status); }
  const base = `FROM tenants t ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`;
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total ${base}`, params);
  const [rows] = await pool.query(
    `SELECT t.id, t.name, t.slug, t.plan, t.status, t.employee_limit, t.onboarded_at, t.suspended_at,
            t.archived_at, t.limits, t.branding, t.created_at,
            (SELECT COUNT(*) FROM users u WHERE u.tenant_id = t.id AND u.status = 'active') AS active_users,
            (SELECT COUNT(*) FROM employees e WHERE e.tenant_id = t.id AND e.deleted_at IS NULL) AS employees
     ${base} ORDER BY t.id LIMIT ${limit} OFFSET ${offset}`, params
  );
  await audit(req, { action: 'platform.tenants.list', entityType: 'tenant' });
  res.json({
    data: rows.map((row) => ({ ...row, limits: unj(row.limits, {}), branding: unj(row.branding, {}) })),
    meta: { total: Number(total), page, pages: Math.ceil(Number(total) / limit), limit },
  });
}));

/**
 * POST /tenants — provision a company: tenant row, system roles, first owner.
 *
 * Kept in step with POST /api/platform/tenants by sharing provisionTenantRoles().
 * Both paths must give the new tenant its role copies or nobody inside it can
 * administer anything (every permission resolves empty).
 */
r.post('/tenants', PLATFORM_WRITE, asyncH(async (req, res) => {
  const { name, slug, plan, branding, featureFlags, adminEmail, adminName } = req.body || {};
  if (!name || !slug || !adminEmail) throw new HttpError(400, 'name, slug and adminEmail are required');
  if (!/^[a-z0-9-]+$/.test(String(slug))) throw new HttpError(400, 'slug must be lowercase letters, numbers and dashes');
  const [dupe] = await pool.query('SELECT id FROM tenants WHERE slug = ?', [slug]);
  if (dupe[0]) throw new HttpError(409, 'That slug is already in use');

  const crypto = require('crypto');
  const bcrypt = require('bcryptjs');
  const tempPassword = `Av@${crypto.randomBytes(3).toString('hex')}`;

  let newTenantId;
  await pool.query('START TRANSACTION');
  try {
    const [ins] = await pool.query(
      'INSERT INTO tenants (name, slug, plan, branding, feature_flags) VALUES (?,?,?,?,?)',
      [name, slug, plan || 'standard',
        JSON.stringify(branding || { companyName: name }),
        JSON.stringify(featureFlags || {})]
    );
    newTenantId = ins.insertId;
    await rbac.provisionTenantRoles(newTenantId);
    await pool.query(
      `INSERT INTO users (tenant_id, email, password_hash, name, role, status, must_change_password)
       VALUES (?,?,?,?,'company_owner','active',1)`,
      [newTenantId, String(adminEmail).toLowerCase().trim(), await bcrypt.hash(tempPassword, 10), adminName || name]
    );
    await pool.query('COMMIT');
  } catch (e) {
    await pool.query('ROLLBACK');
    throw e;
  }

  await audit(req, {
    action: 'tenant.create', entityType: 'tenant', entityId: newTenantId,
    after: { name, slug, plan: plan || 'standard', adminEmail },
  });
  res.status(201).json({
    data: { id: newTenantId, slug }, adminEmail: String(adminEmail).toLowerCase().trim(), tempPassword,
  });
}));

/** GET /tenants/:id — one company with its configuration snapshot. */
r.get('/tenants/:id', PLATFORM_READ, asyncH(async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM tenants WHERE id = ?', [int(req.params.id)]);
  if (!rows[0]) throw new HttpError(404, 'Tenant not found');
  const [users] = await pool.query(
    `SELECT id, name, email, role, status, last_login_at FROM users
     WHERE tenant_id = ? ORDER BY status, name LIMIT 200`, [rows[0].id]
  );
  const [modules] = await pool.query(
    `SELECT mc.module_key, mc.enabled, mc.settings FROM module_configurations mc
     WHERE mc.tenant_id = ? ORDER BY mc.module_key`, [rows[0].id]
  );
  await audit(req, { action: 'platform.tenants.read', entityType: 'tenant', entityId: rows[0].id });
  res.json({
    data: {
      ...rows[0], branding: unj(rows[0].branding, {}), feature_flags: unj(rows[0].feature_flags, {}),
      limits: unj(rows[0].limits, {}), users, modules,
    },
  });
}));

/**
 * PUT /tenants/:id — plan, limits and status. A status other than `active` is
 * exactly what makes the suspension check in authentication bite.
 */
r.put('/tenants/:id', PLATFORM_WRITE, asyncH(async (req, res) => {
  const id = int(req.params.id);
  const [rows] = await pool.query('SELECT * FROM tenants WHERE id = ?', [id]);
  if (!rows[0]) throw new HttpError(404, 'Tenant not found');
  const before = rows[0];
  const allowed = ['name', 'plan', 'status', 'employee_limit', 'limits', 'branding', 'feature_flags'];
  const updates = []; const params = [];
  for (const f of allowed) {
    if (req.body[f] === undefined) continue;
    updates.push(`${f} = ?`);
    params.push(['limits', 'branding', 'feature_flags'].includes(f) ? j(req.body[f]) : req.body[f]);
  }
  if (!updates.length) throw new HttpError(400, 'Nothing to save');
  await pool.query(`UPDATE tenants SET ${updates.join(', ')} WHERE id = ?`, [...params, id]);
  const [after] = await pool.query('SELECT * FROM tenants WHERE id = ?', [id]);
  await audit(req, {
    action: 'platform.tenant.update', entityType: 'tenant', entityId: id,
    before: { plan: before.plan, status: before.status }, after: { plan: after[0].plan, status: after[0].status },
  });
  res.json({ data: after[0] });
}));

// ---------------------------------------------------------------- plans
r.get('/plans', requirePermission('administration.modules.view', { anyOf: ['settings.view'] }), asyncH(async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM platform_plans WHERE active = 1 ORDER BY sort_order', []);
  res.json({ data: decode(rows, ['module_keys', 'feature_limits']) });
}));

module.exports = r;
