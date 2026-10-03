/**
 * Integrations & API platform (spec §9, §10).
 * - admin: API keys, webhook subscriptions/deliveries, integration connections
 * - publicV1: versioned REST API (/api/v1) with service API keys, idempotency keys,
 *   and the HRMS ↔ LMS sync contract endpoints.
 */
const express = require('express');
const crypto = require('crypto');
const dayjs = require('dayjs');
const { pool } = require('../config/db');
const { asyncH, HttpError } = require('../utils/helpers');
const { authenticate, requirePermission } = require('../middleware/auth');
const { logAudit } = require('../services/audit');
const { emitEvent, retryDue } = require('../services/webhooks');

const admin = express.Router();
admin.use(authenticate);

const SCOPES = [
  'employee.read', 'employee.write', 'attendance.read', 'leave.read',
  'payroll.read', 'lms.sync', 'webhooks.manage',
];

// ---- API keys ----
admin.get('/scopes', requirePermission('integration.manage'), (req, res) => res.json({ data: SCOPES }));

admin.get('/keys', requirePermission('integration.manage'), asyncH(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT id, name, key_prefix, scopes, last_used_at, expires_at, revoked_at, created_at FROM api_keys
     WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 100`,
    [req.user.tenant_id]
  );
  res.json({ data: rows });
}));

admin.post('/keys', requirePermission('integration.manage'), asyncH(async (req, res) => {
  const { name, scopes, expiresInDays } = req.body || {};
  if (!name) throw new HttpError(400, 'name required');
  const days = expiresInDays == null || expiresInDays === '' ? null : Number(expiresInDays);
  if (days !== null && (!Number.isInteger(days) || days < 1 || days > 3650)) throw new HttpError(400, 'expiresInDays must be between 1 and 3650');
  const allowed = Array.isArray(scopes) ? scopes.filter((s) => SCOPES.includes(s)) : ['employee.read'];
  if (!allowed.length) throw new HttpError(400, 'At least one valid scope required');
  // Enforced cap (spec §14): a tenant that bought N API keys cannot create N+1.
  await require('../services/limits').assertWithinLimit({
    tenantId: req.user.tenant_id, entitlementKey: 'api_keys.max', incoming: 1, action: 'api_key.create', req,
  });
  const secret = crypto.randomBytes(24).toString('base64url');
  const key = `akv1_${secret}`;
  const keyPrefix = key.slice(0, 12);
  const keyHash = sha256(key);
  const [ins] = await pool.query(
    'INSERT INTO api_keys (tenant_id, name, key_prefix, key_hash, scopes, created_by, expires_at) VALUES (?,?,?,?,?,?, ' + (days ? 'DATE_ADD(NOW(), INTERVAL ? DAY)' : 'NULL') + ')',
    [req.user.tenant_id, name, keyPrefix, keyHash, JSON.stringify(allowed), req.user.id, ...(days ? [days] : [])]
  );
  await logAudit({ tenantId: req.user.tenant_id, actor: req.user, action: 'api_key.create', entityType: 'api_key', entityId: ins.insertId, after: { name, scopes: allowed }, req });
  // full key is shown exactly once
  res.status(201).json({ data: { id: ins.insertId, key, name, scopes: allowed } });
}));

admin.delete('/keys/:id', requirePermission('integration.manage'), asyncH(async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM api_keys WHERE id = ? AND tenant_id = ?', [req.params.id, req.user.tenant_id]);
  if (!rows[0]) throw new HttpError(404, 'Key not found');
  await pool.query('UPDATE api_keys SET revoked_at = NOW() WHERE id = ?', [req.params.id]);
  await logAudit({ tenantId: req.user.tenant_id, actor: req.user, action: 'api_key.revoke', entityType: 'api_key', entityId: req.params.id, req });
  res.json({ ok: true });
}));

// ---- Webhook subscriptions ----
admin.get('/webhooks', requirePermission('integration.manage'), asyncH(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT ws.*, (SELECT COUNT(*) FROM webhook_deliveries d WHERE d.subscription_id = ws.id AND d.status = 'success') AS delivered,
            (SELECT COUNT(*) FROM webhook_deliveries d WHERE d.subscription_id = ws.id AND d.status IN ('pending','dead')) AS failing
     FROM webhook_subscriptions ws WHERE ws.tenant_id = ? ORDER BY ws.created_at DESC LIMIT 100`,
    [req.user.tenant_id]
  );
  res.json({ data: rows.map((x) => ({ ...x, events: typeof x.events === 'string' ? JSON.parse(x.events) : x.events })) });
}));

admin.post('/webhooks', requirePermission('integration.manage'), asyncH(async (req, res) => {
  const { url, events } = req.body || {};
  if (!url || !/^https?:\/\//.test(url)) throw new HttpError(400, 'Valid http(s) url required');
  if (!Array.isArray(events) || !events.length) throw new HttpError(400, 'events required');
  // Enforced cap (spec §14). Re-enabling a deactivated webhook via PUT is not
  // charged again — it was already counted against the cap when it was created.
  await require('../services/limits').assertWithinLimit({
    tenantId: req.user.tenant_id, entitlementKey: 'webhooks.max', incoming: 1, action: 'webhook.create', req,
  });
  const secret = 'whsec_' + crypto.randomBytes(20).toString('hex');
  const [ins] = await pool.query(
    'INSERT INTO webhook_subscriptions (tenant_id, url, secret, events, created_by) VALUES (?,?,?,?,?)',
    [req.user.tenant_id, url, secret, JSON.stringify(events), req.user.id]
  );
  res.status(201).json({ data: { id: ins.insertId, secret } });
}));

admin.put('/webhooks/:id', requirePermission('integration.manage'), asyncH(async (req, res) => {
  const { url, events, active } = req.body || {};
  await pool.query(
    'UPDATE webhook_subscriptions SET url = COALESCE(?, url), events = COALESCE(?, events), active = COALESCE(?, active) WHERE id = ? AND tenant_id = ?',
    [url || null, events ? JSON.stringify(events) : null, active === undefined ? null : (active ? 1 : 0), req.params.id, req.user.tenant_id]
  );
  res.json({ ok: true });
}));

admin.delete('/webhooks/:id', requirePermission('integration.manage'), asyncH(async (req, res) => {
  await pool.query('DELETE FROM webhook_subscriptions WHERE id = ? AND tenant_id = ?', [req.params.id, req.user.tenant_id]);
  res.json({ ok: true });
}));

admin.post('/webhooks/:id/test', requirePermission('integration.manage'), asyncH(async (req, res) => {
  const result = await emitEvent({ tenantId: req.user.tenant_id, eventType: 'webhook.test', payload: { message: 'Test from Arthvex HRMS', at: new Date().toISOString() } });
  res.json({ data: result });
}));

admin.get('/webhooks/:id/deliveries', requirePermission('integration.manage'), asyncH(async (req, res) => {
  await retryDue(req.user.tenant_id);
  const [rows] = await pool.query(
    `SELECT * FROM webhook_deliveries WHERE subscription_id = ? AND tenant_id = ? ORDER BY created_at DESC LIMIT 100`,
    [req.params.id, req.user.tenant_id]
  );
  res.json({ data: rows.map((x) => ({ ...x, payload: typeof x.payload === 'string' ? JSON.parse(x.payload) : x.payload })) });
}));

admin.post('/deliveries/:id/retry', requirePermission('integration.manage'), asyncH(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT d.*, s.url, s.secret FROM webhook_deliveries d JOIN webhook_subscriptions s ON s.id = d.subscription_id
     WHERE d.id = ? AND d.tenant_id = ?`,
    [req.params.id, req.user.tenant_id]
  );
  if (!rows[0]) throw new HttpError(404, 'Delivery not found');
  const { deliver } = require('../services/webhooks');
  const status = await deliver({ ...rows[0], attempts: 0 }, { url: rows[0].url, secret: rows[0].secret });
  res.json({ data: { status } });
}));

// ---- Integration connections (biometric, banking, accounting, LMS, calendar…) ----
admin.get('/connections', requirePermission('integration.manage'), asyncH(async (req, res) => {
  const [rows] = await pool.query(
    'SELECT id, itype, name, status, last_sync_at, last_error, created_at FROM integration_connections WHERE tenant_id = ? ORDER BY itype, name LIMIT 100',
    [req.user.tenant_id]
  );
  res.json({ data: rows });
}));

admin.post('/connections', requirePermission('integration.manage'), asyncH(async (req, res) => {
  const { itype, name, config } = req.body || {};
  if (!itype || !name) throw new HttpError(400, 'itype and name required');
  const [ins] = await pool.query(
    'INSERT INTO integration_connections (tenant_id, itype, name, config, status, created_by) VALUES (?,?,?,?, "connected", ?)',
    [req.user.tenant_id, itype, name, config ? JSON.stringify(config) : null, req.user.id]
  );
  await logAudit({ tenantId: req.user.tenant_id, actor: req.user, action: 'integration.create', entityType: 'integration_connection', entityId: ins.insertId, after: { itype, name }, req });
  res.status(201).json({ data: { id: ins.insertId } });
}));

admin.put('/connections/:id', requirePermission('integration.manage'), asyncH(async (req, res) => {
  const { config, status } = req.body || {};
  await pool.query(
    'UPDATE integration_connections SET config = COALESCE(?, config), status = COALESCE(?, status) WHERE id = ? AND tenant_id = ?',
    [config ? JSON.stringify(config) : null, status || null, req.params.id, req.user.tenant_id]
  );
  res.json({ ok: true });
}));

admin.delete('/connections/:id', requirePermission('integration.manage'), asyncH(async (req, res) => {
  await pool.query('DELETE FROM integration_connections WHERE id = ? AND tenant_id = ?', [req.params.id, req.user.tenant_id]);
  res.json({ ok: true });
}));

// ---- LMS sync status (contract §10) ----
admin.get('/lms/status', requirePermission('integration.manage'), asyncH(async (req, res) => {
  const T = req.user.tenant_id;
  const [[{ learners }]] = await pool.query(`SELECT COUNT(*) AS learners FROM employees WHERE tenant_id = ? AND status IN ('active','on_probation')`, [T]);
  const [[{ completions }]] = await pool.query(`SELECT COUNT(*) AS completions FROM training_records WHERE tenant_id = ?`, [T]);
  const [[{ certificates }]] = await pool.query(`SELECT COUNT(*) AS certificates FROM certifications WHERE tenant_id = ?`, [T]);
  const [[{ learningHours }]] = await pool.query(`SELECT COALESCE(SUM(learning_hours),0) AS learningHours FROM training_records WHERE tenant_id = ?`, [T]);
  const [recent] = await pool.query(
    `SELECT course_name, provider, completed_on, learning_hours, source FROM training_records WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 10`, [T]);
  res.json({ data: { learners, completions, certificates, learningHours, recent } });
}));

// ================= Public /api/v1 (service API keys) =================
function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }

function errorEnvelope(res, status, code, message, extra) {
  return res.status(status).json({ error: { code, message, ...(extra || {}) } });
}

async function apiKeyAuth(req, res, next) {
  try {
    const hdr = req.headers.authorization || '';
    const key = hdr.startsWith('Bearer ') ? hdr.slice(7) : req.headers['x-api-key'];
    if (!key) return errorEnvelope(res, 401, 'unauthorized', 'API key required (Authorization: Bearer or X-Api-Key)');
    const [rows] = await pool.query('SELECT * FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL', [sha256(String(key))]);
    const k = rows[0];
    if (!k) return errorEnvelope(res, 401, 'unauthorized', 'Invalid or revoked API key');
    if (k.expires_at && new Date(k.expires_at) <= new Date()) return errorEnvelope(res, 401, 'key_expired', 'This API key has expired');
    const [tenants] = await pool.query('SELECT id, status FROM tenants WHERE id = ?', [k.tenant_id]);
    // Trial and billing-grace companies are legitimate customers; only states that
    // revoke access (suspended, cancelled, archived, deleted…) stop their keys.
    if (!tenants[0] || !['active', 'trial', 'past_due', 'grace_period'].includes(tenants[0].status)) return errorEnvelope(res, 403, 'tenant_suspended', 'Company account suspended');

    const maint = await require('../services/maintenance').blockingFor(k.tenant_id);
    if (maint) return errorEnvelope(res, 503, 'maintenance', maint.message, { endsAt: maint.ends_at });

    // Metering and the commercial cap are enforced here, at the one place every
    // public API call passes through (spec §13, §14). A tenant that bought the
    // Integrations module but not the API, or has run out of requests, is told
    // exactly that rather than getting a generic 403.
    const limits = require('../services/limits');
    let check;
    try {
      check = await limits.assertWithinLimit({ tenantId: k.tenant_id, entitlementKey: 'api.requests.month', incoming: 1, action: 'api.request' });
    } catch (e) {
      if (e.status === 402) {
        return errorEnvelope(res, 402, 'quota_exceeded', e.message, { ...(e.extra || {}), upgrade: 'Upgrade the plan or request a higher API quota from ARTHVEX' });
      }
      throw e;
    }

    req.apiKey = { id: k.id, tenantId: k.tenant_id, scopes: typeof k.scopes === 'string' ? JSON.parse(k.scopes) : (k.scopes || []) };
    await pool.query('UPDATE api_keys SET last_used_at = NOW() WHERE id = ?', [k.id]);
    // Fire-and-forget: metering must never add latency to, or fail, an API call.
    require('../services/usage').increment(k.tenant_id, 'api.requests.month', 1, {
      source: 'api', referenceType: 'api_key', referenceId: k.id, requestId: req.requestId,
      metadata: { method: req.method, path: req.originalUrl.slice(0, 200) },
    }).catch((e) => console.error('[usage] api metering failed:', e.message));
    // Surfaced so a client can watch its own consumption without polling.
    res.setHeader('X-RateLimit-Limit', String(check.limit ?? 'unlimited'));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, (check.limit || 0) - (check.projected || 0))));
    next();
  } catch (e) { next(e); }
}

function requireScope(scope) {
  return (req, res, next) => {
    if (req.apiKey.scopes.includes(scope) || req.apiKey.scopes.includes('*')) return next();
    return errorEnvelope(res, 403, 'insufficient_scope', `This key lacks the "${scope}" scope`);
  };
}

/** Idempotency (spec §9): replay-safe mutations keyed on Idempotency-Key header.
 * Wraps a handler: if the key was seen before, the stored response is replayed. */
function withIdempotency(handler) {
  return async (req, res, next) => {
    const key = req.headers['idempotency-key'];
    if (!key) return handler(req, res, next);
    const endpoint = req.baseUrl + req.route.path;
    try {
      const [rows] = await pool.query(
        'SELECT response_json FROM idempotency_keys WHERE tenant_id = ? AND idem_key = ? AND endpoint = ?',
        [req.apiKey.tenantId, String(key).slice(0, 120), endpoint]
      );
      if (rows[0]) {
        const saved = typeof rows[0].response_json === 'string' ? JSON.parse(rows[0].response_json) : rows[0].response_json;
        return res.status(200).json({ ...saved, idempotent_replay: true });
      }
      const orig = res.json.bind(res);
      res.json = (body) => {
        if (res.statusCode < 400) {
          pool.query(
            'INSERT IGNORE INTO idempotency_keys (tenant_id, idem_key, endpoint, response_json) VALUES (?,?,?,?)',
            [req.apiKey.tenantId, String(key).slice(0, 120), endpoint, JSON.stringify(body)]
          ).catch(() => {});
        }
        return orig(body);
      };
      return handler(req, res, next);
    } catch (e) { next(e); }
  };
}

const publicV1 = express.Router();
publicV1.use(apiKeyAuth);

const EMPLOYEE_COLUMNS = `e.id, e.employee_code, e.external_employee_id, CONCAT(e.first_name, ' ', e.last_name) AS name,
  e.email, e.status, e.employment_type, e.joined_on, e.exit_date,
  d.name AS department, des.name AS designation, l.name AS location,
  e.manager_id, CONCAT(m.first_name, ' ', m.last_name) AS manager_name`;

// --- Employee directory (read) ---
publicV1.get('/employees', requireScope('employee.read'), asyncH(async (req, res) => {
  const params = [req.apiKey.tenantId];
  let where = 'e.tenant_id = ? AND e.deleted_at IS NULL';
  if (req.query.status) { where += ' AND e.status = ?'; params.push(req.query.status); }
  if (req.query.updated_since) { where += ' AND e.updated_at >= ?'; params.push(req.query.updated_since); }
  const page = Math.max(1, Number(req.query.page) || 1);
  const perPage = Math.min(200, Math.max(1, Number(req.query.per_page) || 50));
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM employees e WHERE ${where}`, params);
  const [rows] = await pool.query(
    `SELECT ${EMPLOYEE_COLUMNS} FROM employees e
     LEFT JOIN departments d ON d.id = e.department_id
     LEFT JOIN designations des ON des.id = e.designation_id
     LEFT JOIN locations l ON l.id = e.location_id
     LEFT JOIN employees m ON m.id = e.manager_id
     WHERE ${where} ORDER BY e.id LIMIT ? OFFSET ?`,
    [...params, perPage, (page - 1) * perPage]
  );
  res.json({
    data: rows,
    pagination: { page, per_page: perPage, total, total_pages: Math.ceil(total / perPage) },
  });
}));

publicV1.get('/employees/:id', requireScope('employee.read'), asyncH(async (req, res) => {
  const idOrCode = req.params.id;
  const [rows] = await pool.query(
    `SELECT ${EMPLOYEE_COLUMNS} FROM employees e
     LEFT JOIN departments d ON d.id = e.department_id
     LEFT JOIN designations des ON des.id = e.designation_id
     LEFT JOIN locations l ON l.id = e.location_id
     LEFT JOIN employees m ON m.id = e.manager_id
     WHERE e.tenant_id = ? AND (e.id = ? OR e.employee_code = ? OR e.external_employee_id = ?) AND e.deleted_at IS NULL`,
    [req.apiKey.tenantId, /^\d+$/.test(idOrCode) ? idOrCode : 0, idOrCode, idOrCode]
  );
  if (!rows[0]) return errorEnvelope(res, 404, 'not_found', 'Employee not found');
  res.json({ data: rows[0] });
}));

// --- Employee create (service provisioning, idempotent) ---
publicV1.post('/employees', requireScope('employee.write'), withIdempotency(async (req, res) => {
  const { employeeCode, firstName, lastName, email, joinedOn, employmentType, department, designation } = req.body || {};
  if (!firstName || !email) return errorEnvelope(res, 422, 'validation_error', 'firstName and email are required');
  const code = employeeCode || `EXT${Date.now()}`;
  const [dupe] = await pool.query('SELECT id FROM employees WHERE tenant_id = ? AND (email = ? OR employee_code = ?)', [req.apiKey.tenantId, email, code]);
  if (dupe[0]) return errorEnvelope(res, 409, 'conflict', 'An employee with this email/code already exists');
  let deptId = null;
  if (department) {
    const [d] = await pool.query('SELECT id FROM departments WHERE tenant_id = ? AND name = ?', [req.apiKey.tenantId, department]);
    deptId = d[0]?.id || null;
  }
  let desigId = null;
  if (designation) {
    const [dd] = await pool.query('SELECT id FROM designations WHERE tenant_id = ? AND name = ?', [req.apiKey.tenantId, designation]);
    desigId = dd[0]?.id || null;
  }
  const [ins] = await pool.query(
    `INSERT INTO employees (tenant_id, employee_code, first_name, last_name, email, joined_on, employment_type, status, department_id, designation_id)
     VALUES (?,?,?,?,?,?,?, 'onboarding', ?, ?)`,
    [req.apiKey.tenantId, code, firstName, lastName || '', email, joinedOn || dayjs().format('YYYY-MM-DD'), employmentType || 'full_time', deptId, desigId]
  );
  await emitEvent({ tenantId: req.apiKey.tenantId, eventType: 'employee.created', payload: { employeeId: ins.insertId, code, email, source: 'api' } });
  res.status(201).json({ data: { id: ins.insertId, employee_code: code, status: 'onboarding' } });
}));

// --- LMS contract (§10): identity export for the standalone LMS ---
publicV1.get('/lms/employees', requireScope('lms.sync'), asyncH(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT e.id AS employee_id, COALESCE(e.external_employee_id, e.employee_code) AS external_employee_id,
            CONCAT(e.first_name, ' ', e.last_name) AS name, e.email, e.status,
            d.name AS department, des.name AS designation, l.name AS location,
            e.manager_id, e.employment_type
     FROM employees e
     LEFT JOIN departments d ON d.id = e.department_id
     LEFT JOIN designations des ON des.id = e.designation_id
     LEFT JOIN locations l ON l.id = e.location_id
     WHERE e.tenant_id = ? AND e.deleted_at IS NULL
     ORDER BY e.id LIMIT 2000`,
    [req.apiKey.tenantId]
  );
  res.json({ data: rows, synced_at: new Date().toISOString() });
}));

// --- LMS contract: course completions (LMS → HRMS) ---
publicV1.post('/lms/completions', requireScope('lms.sync'), withIdempotency(async (req, res) => {
  const { externalEmployeeId, courseName, provider, completedOn, score, learningHours, skills } = req.body || {};
  if (!externalEmployeeId || !courseName) return errorEnvelope(res, 422, 'validation_error', 'externalEmployeeId and courseName are required');
  const [emps] = await pool.query(
    `SELECT id, external_employee_id, employee_code FROM employees
     WHERE tenant_id = ? AND (external_employee_id = ? OR employee_code = ? OR id = ?)`,
    [req.apiKey.tenantId, externalEmployeeId, externalEmployeeId, /^\d+$/.test(externalEmployeeId) ? externalEmployeeId : 0]
  );
  if (!emps[0]) return errorEnvelope(res, 404, 'not_found', 'Employee not found for externalEmployeeId');
  const [ins] = await pool.query(
    `INSERT INTO training_records (tenant_id, employee_id, external_employee_id, course_name, provider, completed_on, score, learning_hours, skills, source)
     VALUES (?,?,?,?,?,?,?,?,?, 'lms')`,
    [req.apiKey.tenantId, emps[0].id, emps[0].external_employee_id || emps[0].employee_code, courseName, provider || 'Arthvex LMS', completedOn || dayjs().format('YYYY-MM-DD'), score || null, learningHours || 0, skills ? JSON.stringify(skills) : null]
  );
  await emitEvent({ tenantId: req.apiKey.tenantId, eventType: 'lms.course_completed', payload: { trainingRecordId: ins.insertId, employeeId: emps[0].id, courseName } });
  res.status(201).json({ data: { id: ins.insertId, employee_id: emps[0].id } });
}));

// --- LMS contract: certificate metadata (LMS → HRMS) ---
publicV1.post('/lms/certifications', requireScope('lms.sync'), withIdempotency(async (req, res) => {
  const { externalEmployeeId, name, issuedBy, issuedOn, expiresOn, credentialId } = req.body || {};
  if (!externalEmployeeId || !name) return errorEnvelope(res, 422, 'validation_error', 'externalEmployeeId and name are required');
  const [emps] = await pool.query(
    `SELECT id FROM employees WHERE tenant_id = ? AND (external_employee_id = ? OR employee_code = ? OR id = ?)`,
    [req.apiKey.tenantId, externalEmployeeId, externalEmployeeId, /^\d+$/.test(externalEmployeeId) ? externalEmployeeId : 0]
  );
  if (!emps[0]) return errorEnvelope(res, 404, 'not_found', 'Employee not found for externalEmployeeId');
  const [ins] = await pool.query(
    `INSERT INTO certifications (tenant_id, employee_id, name, issued_by, issued_on, expires_on, credential_id, verified)
     VALUES (?,?,?,?,?,?,?,1)`,
    [req.apiKey.tenantId, emps[0].id, name, issuedBy || 'Arthvex LMS', issuedOn || null, expiresOn || null, credentialId || null]
  );
  res.status(201).json({ data: { id: ins.insertId, employee_id: emps[0].id } });
}));

// --- LMS contract: aggregated learning hours / skills evidence (LMS → HRMS) ---
publicV1.post('/lms/learning-evidence', requireScope('lms.sync'), asyncH(async (req, res) => {
  const { externalEmployeeId, periodFrom, periodTo, learningHours, skills } = req.body || {};
  if (!externalEmployeeId) return errorEnvelope(res, 422, 'validation_error', 'externalEmployeeId is required');
  const [emps] = await pool.query(
    `SELECT id FROM employees WHERE tenant_id = ? AND (external_employee_id = ? OR employee_code = ?)`,
    [req.apiKey.tenantId, externalEmployeeId, externalEmployeeId]
  );
  if (!emps[0]) return errorEnvelope(res, 404, 'not_found', 'Employee not found');
  const [ins] = await pool.query(
    `INSERT INTO training_records (tenant_id, employee_id, external_employee_id, course_name, provider, completed_on, learning_hours, skills, source)
     VALUES (?,?,?,?,?,?,?,?,'lms')`,
    [req.apiKey.tenantId, emps[0].id, externalEmployeeId,
      `Learning evidence ${periodFrom || ''}→${periodTo || ''}`.trim(), 'Arthvex LMS', periodTo || dayjs().format('YYYY-MM-DD'), learningHours || 0, skills ? JSON.stringify(skills) : null]
  );
  res.status(201).json({ data: { id: ins.insertId } });
}));

publicV1.use((req, res) => errorEnvelope(res, 404, 'not_found', `No such endpoint: ${req.method} ${req.path}`));

module.exports = { admin, publicV1 };
