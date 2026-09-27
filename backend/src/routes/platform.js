const express = require('express');
const { pool } = require('../config/db');
const { asyncH, HttpError } = require('../utils/helpers');
const { authenticate, requirePermission } = require('../middleware/auth');
const { logAudit } = require('../services/audit');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const r = express.Router();
r.use(authenticate);
r.use(requirePermission('tenant.manage'));

r.get('/tenants', asyncH(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT t.*, (SELECT COUNT(*) FROM employees e WHERE e.tenant_id = t.id AND e.deleted_at IS NULL) AS employee_count
     FROM tenants t ORDER BY t.id`
  );
  res.json({ data: rows.map((x) => ({ ...x, branding: typeof x.branding === 'string' ? JSON.parse(x.branding || '{}') : x.branding, feature_flags: typeof x.feature_flags === 'string' ? JSON.parse(x.feature_flags || '{}') : x.feature_flags })) });
}));

r.post('/tenants', asyncH(async (req, res) => {
  const { name, slug, plan, branding, featureFlags, adminEmail, adminName } = req.body || {};
  if (!name || !slug || !adminEmail) throw new HttpError(400, 'name, slug, adminEmail required');
  if (!/^[a-z0-9-]+$/.test(slug)) throw new HttpError(400, 'slug must be lowercase alphanumeric/dash');
  const [dupe] = await pool.query('SELECT id FROM tenants WHERE slug = ?', [slug]);
  if (dupe[0]) throw new HttpError(409, 'Slug already in use');
  const tempPassword = `Av@${crypto.randomBytes(3).toString('hex')}`;
  await pool.query('START TRANSACTION');
  try {
    const [ins] = await pool.query(
      `INSERT INTO tenants (name, slug, plan, branding, feature_flags) VALUES (?,?,?,?,?)`,
      [name, slug, plan || 'standard', JSON.stringify(branding || { companyName: name }), JSON.stringify(featureFlags || {})]
    );
    const tenantId = ins.insertId;
    // seed roles from system defaults
    const { ROLE_DEFS, DEFAULT_ROLES } = require('../utils/permissions');
    for (const key of DEFAULT_ROLES) {
      await pool.query(
        'INSERT INTO roles (tenant_id, name, label, permissions, is_system) VALUES (?,?,?,?,1)',
        [tenantId, key, ROLE_DEFS[key].label, JSON.stringify(ROLE_DEFS[key].permissions)]
      );
    }
    // company owner user
    const [uIns] = await pool.query(
      `INSERT INTO users (tenant_id, email, password_hash, name, role, status, must_change_password) VALUES (?,?,?,?,?,'active',1)`,
      [tenantId, String(adminEmail).toLowerCase(), await bcrypt.hash(tempPassword, 10), adminName || name, 'company_owner']
    );
    await pool.query('COMMIT');
    await logAudit({ tenantId: null, actor: req.user, action: 'tenant.create', entityType: 'tenant', entityId: tenantId, after: { name, slug }, req });
    res.status(201).json({ data: { id: tenantId, slug }, adminEmail, tempPassword });
  } catch (e) {
    await pool.query('ROLLBACK');
    throw e;
  }
}));

r.put('/tenants/:id', asyncH(async (req, res) => {
  const { name, plan, status, branding, featureFlags, employeeLimit } = req.body || {};
  const sets = [];
  const params = [];
  for (const [k, v] of Object.entries({ name, plan, status, employeeLimit: employeeLimit ?? null })) {
    if (v !== undefined && v !== null) { sets.push(`${k === 'employeeLimit' ? 'employee_limit' : k} = ?`); params.push(v); }
  }
  if (branding) { sets.push('branding = ?'); params.push(JSON.stringify(branding)); }
  if (featureFlags) { sets.push('feature_flags = ?'); params.push(JSON.stringify(featureFlags)); }
  if (sets.length) {
    params.push(req.params.id);
    await pool.query(`UPDATE tenants SET ${sets.join(', ')} WHERE id = ?`, params);
  }
  await logAudit({ tenantId: null, actor: req.user, action: 'tenant.update', entityType: 'tenant', entityId: req.params.id, after: { name, plan, status }, req });
  res.json({ ok: true });
}));

module.exports = r;
