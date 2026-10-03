const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const dayjs = require('dayjs');
const { pool } = require('../config/db');
const { asyncH, HttpError, pick } = require('../utils/helpers');
const { authenticate, requirePermission, employeeScopeCondition, scopeFor } = require('../middleware/auth');
const { encrypt, decrypt, maskPan, maskAadhaar, maskBank } = require('../utils/crypto');
const { logAudit } = require('../services/audit');
const { notifyEvent } = require('../services/notify');
const { emitEvent } = require('../services/webhooks');
const { upload, relPath } = require('../middleware/upload');
const { parseCsv, toCsv } = require('../utils/csv');
const limits = require('../services/limits');
const usage = require('../services/usage');

const r = express.Router();
r.use(authenticate);

const EMP_FIELDS = [
  'first_name', 'last_name', 'email', 'personal_email', 'phone', 'dob', 'gender', 'marital_status', 'blood_group',
  'father_name', 'spouse_name', 'address', 'city', 'state', 'pincode',
  'emergency_name', 'emergency_relation', 'emergency_phone',
  'joined_on', 'confirmation_date', 'probation_months', 'employment_type', 'status',
  'department_id', 'designation_id', 'grade_id', 'location_id', 'cost_center_id', 'shift_id', 'manager_id',
  'work_mode', 'uan', 'esic_no', 'bank_name', 'ifsc', 'tax_regime', 'pan_plain',
];

const LIST_SELECT = `
  e.id, e.tenant_id, e.employee_code, e.first_name, e.last_name, e.email, e.phone, e.dob, e.gender,
  e.joined_on, e.confirmation_date, e.status, e.employment_type, e.work_mode, e.probation_months,
  e.department_id, e.designation_id, e.grade_id, e.location_id, e.manager_id, e.reporting_head_id,
  e.cost_center_id, e.shift_id, e.tax_regime, e.profile_photo, e.exit_date, e.created_at,
  d.name AS department_name, ds.name AS designation_name, g.name AS grade_name,
  l.name AS location_name, m.first_name AS manager_first_name, m.last_name AS manager_last_name,
  s.name AS shift_name`;

const LIST_JOINS = `
  FROM employees e
  LEFT JOIN departments d ON d.id = e.department_id
  LEFT JOIN designations ds ON ds.id = e.designation_id
  LEFT JOIN grades g ON g.id = e.grade_id
  LEFT JOIN locations l ON l.id = e.location_id
  LEFT JOIN employees m ON m.id = e.manager_id
  LEFT JOIN shifts s ON s.id = e.shift_id`;

// ---------- Directory ----------
r.get('/', requirePermission('employee.view'), asyncH(async (req, res) => {
  const scope = employeeScopeCondition(req.user, 'employee.view', 'e');
  const params = [req.user.tenant_id, ...scope.params];
  let where = `e.tenant_id = ? AND e.deleted_at IS NULL AND (${scope.sql})`;
  if (req.query.q) {
    where += ` AND (e.first_name LIKE ? OR e.last_name LIKE ? OR e.email LIKE ? OR e.employee_code LIKE ?)`;
    const like = `%${req.query.q}%`;
    params.push(like, like, like, like);
  }
  if (req.query.status) { where += ' AND e.status = ?'; params.push(req.query.status); }
  if (req.query.department_id) { where += ' AND e.department_id = ?'; params.push(req.query.department_id); }
  if (req.query.location_id) { where += ' AND e.location_id = ?'; params.push(req.query.location_id); }
  const page = Math.max(1, parseInt(req.query.page || '1', 10));
  const limit = Math.min(100, Math.max(5, parseInt(req.query.limit || '25', 10)));
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total ${LIST_JOINS} WHERE ${where}`, params);
  const [rows] = await pool.query(
    `SELECT ${LIST_SELECT} ${LIST_JOINS} WHERE ${where} ORDER BY e.employee_code LIMIT ? OFFSET ?`,
    [...params, limit, (page - 1) * limit]
  );
  res.json({ data: rows, meta: { total, page, limit, pages: Math.ceil(total / limit) } });
}));

// ---------- Org chart ----------
r.get('/org-chart', requirePermission('employee.view'), asyncH(async (req, res) => {
  const scope = employeeScopeCondition(req.user, 'employee.view', 'e');
  const [rows] = await pool.query(
    `SELECT e.id, e.first_name, e.last_name, e.employee_code, e.manager_id, e.status, ds.name AS designation_name, e.profile_photo
     FROM employees e LEFT JOIN designations ds ON ds.id = e.designation_id
     WHERE e.tenant_id = ? AND e.deleted_at IS NULL AND e.status IN ('active','on_probation','on_notice') AND (${scope.sql})`,
    [req.user.tenant_id, ...scope.params]
  );
  const byId = Object.fromEntries(rows.map((e) => [e.id, { ...e, children: [] }]));
  const roots = [];
  for (const e of Object.values(byId)) {
    if (e.manager_id && byId[e.manager_id]) byId[e.manager_id].children.push(e);
    else roots.push(e);
  }
  res.json({ data: roots });
}));

// ---------- Create employee ----------
async function createEmployee(req, res) {
   const data = pick(req.body, EMP_FIELDS);
   for (const f of ['first_name', 'last_name', 'email', 'joined_on']) {
     if (!data[f]) throw new HttpError(400, `${f} is required`);
   }
   // The employee cap is a commercial limit, so it is enforced here, on the
   // server, from the tenant's plan/override — never from a disabled button
   // (spec §14). Reaching it blocks employee #501 and nothing else: existing
   // staff keep their payroll, payslips and history (spec §15).
   await limits.assertWithinLimit({
     tenantId: req.user.tenant_id, entitlementKey: 'employees.max', incoming: 1,
     action: 'employee.create', req,
   });
   const [dupe] = await pool.query('SELECT id FROM employees WHERE tenant_id = ? AND email = ?', [req.user.tenant_id, data.email]);
   if (dupe[0]) throw new HttpError(409, 'An employee with this email already exists');

  // employee code auto
  let code = req.body.employee_code;
  if (!code) {
    const [[{ maxId }]] = await pool.query('SELECT COALESCE(MAX(id),0)+1 AS maxId FROM employees WHERE tenant_id = ?', [req.user.tenant_id]);
    code = `EMP${String(maxId).padStart(4, '0')}`;
  }
  const sensitive = {
    pan: encrypt(req.body.pan_plain || null),
    aadhaar: encrypt(req.body.aadhaar || null),
    bank: encrypt(req.body.bank_account || null),
  };
  const status = data.status || (dayjs().diff(dayjs(data.joined_on), 'month') < (data.probation_months || 6) ? 'on_probation' : 'active');
  const [ins] = await pool.query(
    `INSERT INTO employees (tenant_id, employee_code, ${EMP_FIELDS.join(', ')}, pan_enc, aadhaar_enc, bank_account_enc, created_by)
     VALUES (?, ?, ${EMP_FIELDS.map(() => '?').join(', ')}, ?, ?, ?, ?)`,
    [req.user.tenant_id, code, ...EMP_FIELDS.map((f) => data[f] ?? null), sensitive.pan, sensitive.aadhaar, sensitive.bank, req.user.id]
  );

  // auto-create portal account
  let tempPassword = null;
  if (req.body.createLogin !== false) {
    tempPassword = `Av@${crypto.randomBytes(3).toString('hex')}`;
    await pool.query(
      `INSERT INTO users (tenant_id, employee_id, email, password_hash, name, role, status, must_change_password)
       VALUES (?,?,?,?,?,?, 'active', 1)
       ON DUPLICATE KEY UPDATE employee_id = VALUES(employee_id)`,
      [req.user.tenant_id, ins.insertId, data.email.toLowerCase(), await bcrypt.hash(tempPassword, 10), `${data.first_name} ${data.last_name}`, req.body.portalRole || 'employee']
    );
    await notifyEvent({ tenantId: req.user.tenant_id, eventKey: 'account.welcome', vars: { name: data.first_name, companyName: 'HRMS' }, recipients: [{ userId: null, email: data.email }] });
  }

  await pool.query(
    `INSERT INTO employee_timeline (tenant_id, employee_id, event_type, title, event_date, created_by)
     VALUES (?,?,?,?,?,?)`,
    [req.user.tenant_id, ins.insertId, 'joined', `Joined as ${data.designation_id ? '' : 'employee'}`, data.joined_on, req.user.id]
  );
  // seed onboarding checklist
  const defaults = [
    ['Collect signed offer letter', 'document', 'hr'], ['Collect ID proof (Aadhaar/PAN)', 'document', 'hr'],
    ['Bank account & statutory details', 'payroll', 'hr'], ['Laptop/asset assignment', 'asset', 'it'],
    ['Email & system access setup', 'it_setup', 'it'], ['Policy acknowledgement', 'policy', 'employee'],
    ['Induction & team introduction', 'induction', 'manager'],
  ];
  for (const [title, category, assignee] of defaults) {
    await pool.query(
      `INSERT INTO onboarding_tasks (tenant_id, employee_id, title, category, assignee_role, status) VALUES (?,?,?,?,?, 'pending')`,
      [req.user.tenant_id, ins.insertId, title, category, assignee]
    );
  }
  await logAudit({ tenantId: req.user.tenant_id, actor: req.user, action: 'employee.create', entityType: 'employee', entityId: ins.insertId, after: { code, email: data.email, status }, req });
  await emitEvent({ tenantId: req.user.tenant_id, eventType: 'employee.created', payload: { employeeId: ins.insertId, code, email: data.email, status } });
  const [rows] = await pool.query('SELECT id, employee_code, first_name, last_name, email, status FROM employees WHERE id = ?', [ins.insertId]);
  // Keep the derived counter fresh so the next limit check sees this row.
  await usage.recompute(req.user.tenant_id, { source: 'employee_create', actorUserId: req.user.id, requestId: req.requestId });
  res.status(201).json({ data: rows[0], tempPassword, portalCreated: !!tempPassword });
}
// The employee cap and the generated employee code are both "read, then insert", so the
// whole creation runs under a per-company lock; see limits.withTenantLock.
r.post('/', requirePermission('employee.create'), asyncH((req, res) =>
  limits.withTenantLock(req.user.tenant_id, 'employee.create', () => createEmployee(req, res))));

// ---------- Profile ----------
r.get('/:id', requirePermission('employee.view'), asyncH(async (req, res) => {
  const scope = employeeScopeCondition(req.user, 'employee.view', 'e');
  const [rows] = await pool.query(
    `SELECT e.*, d.name AS department_name, ds.name AS designation_name, g.name AS grade_name,
            l.name AS location_name, s.name AS shift_name
     ${LIST_JOINS} WHERE e.id = ? AND e.tenant_id = ? AND e.deleted_at IS NULL AND (${scope.sql})`,
    [req.params.id, req.user.tenant_id, ...scope.params]
  );
  const emp = rows[0];
  if (!emp) throw new HttpError(404, 'Employee not found');

  const canSeeSensitive = scopeFor(req.user, 'employee.view') === 'company' && req.user.permissions.includes('employee.view_sensitive');
  const out = {
    ...emp,
    pan_plain: canSeeSensitive ? emp.pan_plain : emp.pan_plain ? maskPan(emp.pan_plain) : null,
    pan_enc: undefined, aadhaar_enc: undefined, bank_account_enc: undefined,
    aadhaar: canSeeSensitive ? decrypt(emp.aadhaar_enc) : emp.aadhaar_enc ? maskAadhaar(decrypt(emp.aadhaar_enc)) : null,
    bank_account: canSeeSensitive ? decrypt(emp.bank_account_enc) : emp.bank_account_enc ? maskBank(decrypt(emp.bank_account_enc)) : null,
    pan_enc: canSeeSensitive ? emp.pan_plain : undefined,
  };
  if (!canSeeSensitive) out.pan_plain_masked = emp.pan_plain ? maskPan(emp.pan_plain) : null;

  const [timeline] = await pool.query(
    'SELECT * FROM employee_timeline WHERE employee_id = ? ORDER BY event_date DESC LIMIT 50', [emp.id]
  );
  const [docs] = await pool.query(
    'SELECT id, doc_type, name, file_path, issued_on, expires_on, verification_status, created_at FROM employee_documents WHERE employee_id = ?', [emp.id]
  );
  const [salaries] = await pool.query(
    'SELECT id, ctc_annual, gross_monthly, items, effective_from, effective_to, revision_reason, created_at FROM employee_salaries WHERE employee_id = ? ORDER BY effective_from DESC', [emp.id]
  );
  const [tasks] = await pool.query(
    'SELECT * FROM onboarding_tasks WHERE employee_id = ? ORDER BY id', [emp.id]
  );
  res.json({ data: out, timeline, documents: docs, salaries, onboardingTasks: tasks });
}));

// ---------- Update ----------
r.put('/:id', requirePermission('employee.edit'), asyncH(async (req, res) => {
  const editScope = employeeScopeCondition(req.user, 'employee.edit', 'e');
  const [target] = await pool.query(
    `SELECT e.id FROM employees e WHERE e.id = ? AND e.tenant_id = ? AND e.deleted_at IS NULL AND (${editScope.sql})`,
    [req.params.id, req.user.tenant_id, ...editScope.params]
  );
  if (!target[0]) throw new HttpError(403, 'Employee is outside your edit scope');
  const [before] = await pool.query('SELECT * FROM employees WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL', [req.params.id, req.user.tenant_id]);
  if (!before[0]) throw new HttpError(404, 'Employee not found');
  const data = pick(req.body, EMP_FIELDS.filter((f) => f !== 'email'));
  const sets = Object.keys(data).map((k) => `${k} = ?`);
  const params = Object.values(data);
  const canEditSensitive = req.user.permissions.includes('employee.edit_sensitive');
  if (req.body.pan_plain !== undefined && canEditSensitive) { sets.push('pan_plain = ?'); params.push(req.body.pan_plain || null); }
  if (req.body.aadhaar !== undefined && canEditSensitive) { sets.push('aadhaar_enc = ?'); params.push(encrypt(req.body.aadhaar)); }
  if (req.body.bank_account !== undefined && canEditSensitive) { sets.push('bank_account_enc = ?'); params.push(encrypt(req.body.bank_account)); }
  if (req.body.employee_code !== undefined && req.body.employee_code) { sets.push('employee_code = ?'); params.push(req.body.employee_code); }
  if (!sets.length) throw new HttpError(400, 'No fields to update');
  params.push(req.params.id, req.user.tenant_id);
  await pool.query(`UPDATE employees SET ${sets.join(', ')} WHERE id = ? AND tenant_id = ?`, params);

  // timeline entries for meaningful changes
  if (data.department_id && Number(data.department_id) !== Number(before[0].department_id)) {
    await pool.query('INSERT INTO employee_timeline (tenant_id, employee_id, event_type, title, event_date, created_by) VALUES (?,?,?,?,CURDATE(),?)',
      [req.user.tenant_id, req.params.id, 'transfer', 'Department changed', req.user.id]);
  }
  if (data.manager_id && Number(data.manager_id) !== Number(before[0].manager_id)) {
    await pool.query('INSERT INTO employee_timeline (tenant_id, employee_id, event_type, title, event_date, created_by) VALUES (?,?,?,?,CURDATE(),?)',
      [req.user.tenant_id, req.params.id, 'manager_change', 'Reporting manager changed', req.user.id]);
  }
  if (data.status && data.status !== before[0].status) {
    await pool.query('INSERT INTO employee_timeline (tenant_id, employee_id, event_type, title, event_date, created_by) VALUES (?,?,?,?,CURDATE(),?)',
      [req.user.tenant_id, req.params.id, 'status_change', `Status: ${before[0].status} → ${data.status}`, req.user.id]);
  }
  await logAudit({ tenantId: req.user.tenant_id, actor: req.user, action: 'employee.update', entityType: 'employee', entityId: req.params.id, before: { status: before[0].status }, after: data, req });
  res.json({ ok: true });
}));

// ---------- Soft delete / archive ----------
r.delete('/:id', requirePermission('employee.delete'), asyncH(async (req, res) => {
  const [before] = await pool.query('SELECT * FROM employees WHERE id = ? AND tenant_id = ?', [req.params.id, req.user.tenant_id]);
  if (!before[0]) throw new HttpError(404, 'Employee not found');
  await pool.query('UPDATE employees SET deleted_at = NOW(), status = "exited" WHERE id = ?', [req.params.id]);
  await pool.query('UPDATE users SET status = "disabled" WHERE employee_id = ?', [req.params.id]);
  await logAudit({ tenantId: req.user.tenant_id, actor: req.user, action: 'employee.archive', entityType: 'employee', entityId: req.params.id, before: { status: before[0].status }, req });
  res.json({ ok: true });
}));

// ---------- Bulk import (CSV) ----------
async function importEmployees(req, res) {
  if (!req.file) throw new HttpError(400, 'CSV file required');
  const fs = require('fs');
  const content = fs.readFileSync(req.file.path, 'utf8');
  fs.unlinkSync(req.file.path);
  const rows = parseCsv(content);
  if (rows.length < 2) throw new HttpError(400, 'CSV has no data rows');
  const header = rows[0].map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
  const errors = [];
  let success = 0;
  const seen = new Set();

  // A bulk import is the easiest way to blow past a commercial cap, so the whole
  // file is checked against the remaining headroom before a single row is written.
  const headroom = await limits.assertWithinLimit({
    tenantId: req.user.tenant_id, entitlementKey: 'employees.max',
    incoming: rows.length - 1, onExhausted: 'warn', action: 'employee.import', req,
  });
  if (headroom.warning && Number(headroom.projected) > Number(headroom.limit)) {
    throw new HttpError(402,
      `This import would take the company to ${headroom.projected} employees, over the limit of ${headroom.limit}. Split the file, or ask ARTHVEX to raise the limit.`,
      { current: headroom.current, limit: headroom.limit, requested: rows.length - 1, limitSource: headroom.entitlement.source });
  }

  for (let i = 1; i < rows.length; i++) {
    const lineNo = i + 1;
    const cells = rows[i];
    if (cells.every((c) => !c.trim())) continue;
    const rec = Object.fromEntries(header.map((h, idx) => [h, (cells[idx] || '').trim()]));
    const rowNum = { row: lineNo, employeeCode: rec.employee_code || '' };
    for (const f of ['first_name', 'last_name', 'email', 'joined_on']) {
      if (!rec[f]) { errors.push({ ...rowNum, error: `${f} is required` }); }
    }
    if (errors.some((e) => e.row === lineNo)) continue;
    if (!dayjs(rec.joined_on, 'YYYY-MM-DD').isValid() && !dayjs(rec.joined_on, 'DD/MM/YYYY').isValid()) {
      errors.push({ ...rowNum, error: `invalid joined_on date (use YYYY-MM-DD)` });
      continue;
    }
    const email = rec.email.toLowerCase();
    if (seen.has(email)) { errors.push({ ...rowNum, error: `duplicate email in file` }); continue; }
    seen.add(email);
    const [dupe] = await pool.query('SELECT id FROM employees WHERE tenant_id = ? AND email = ?', [req.user.tenant_id, email]);
    if (dupe[0]) { errors.push({ ...rowNum, error: `email already exists` }); continue; }
    // resolve lookups
    const look = async (table, val) => {
      if (!val) return null;
      const [rows2] = await pool.query(`SELECT id FROM ${table} WHERE tenant_id = ? AND name = ? LIMIT 1`, [req.user.tenant_id, val]);
      return rows2[0]?.id || null;
    };
    const joinedOn = dayjs(rec.joined_on, 'YYYY-MM-DD').isValid() ? rec.joined_on : dayjs(rec.joined_on, 'DD/MM/YYYY').format('YYYY-MM-DD');
    const [ins] = await pool.query(
      `INSERT INTO employees (tenant_id, employee_code, first_name, last_name, email, phone, dob, gender, joined_on, employment_type, status, department_id, designation_id, location_id, manager_id, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        req.user.tenant_id, rec.employee_code || null, rec.first_name, rec.last_name, email,
        rec.phone || null, rec.dob || null, rec.gender || null, joinedOn,
        rec.employment_type || 'full_time', 'onboarding',
        await look('departments', rec.department), await look('designations', rec.designation),
        await look('locations', rec.location), rec.manager_email ? await look('employees', rec.manager_email) : null, req.user.id,
      ]
    );
    // login
    const tempPassword = `Av@${crypto.randomBytes(3).toString('hex')}`;
    await pool.query(
      `INSERT IGNORE INTO users (tenant_id, employee_id, email, password_hash, name, role, status, must_change_password)
       VALUES (?,?,?,?,?,?, 'active', 1)`,
      [req.user.tenant_id, ins.insertId, email, await bcrypt.hash(tempPassword, 10), `${rec.first_name} ${rec.last_name}`, 'employee']
    );
    success++;
  }

  const [logIns] = await pool.query(
    'INSERT INTO attendance_imports (tenant_id, file_name, imported_by, total_rows, success_rows, error_rows, error_report) VALUES (?,?,?,?,?,?,?)',
    [req.user.tenant_id, req.file.originalname, req.user.id, rows.length - 1, success, errors.length, JSON.stringify(errors)]
  );
  await logAudit({ tenantId: req.user.tenant_id, actor: req.user, action: 'employee.import', entityType: 'import', entityId: logIns.insertId, after: { success, errors: errors.length }, req });
  await usage.recompute(req.user.tenant_id, { source: 'employee_import', actorUserId: req.user.id, requestId: req.requestId });
  res.json({ data: { total: rows.length - 1, success, errors } });
}
// Cap check + inserts must not interleave with another creation in the same company.
r.post('/import', requirePermission('employee.import'), upload('documents', { fieldName: 'file', maxSizeMb: 10 }), asyncH((req, res) =>
  limits.withTenantLock(req.user.tenant_id, 'employee.create', () => importEmployees(req, res))));

r.get('/import/template', requirePermission('employee.import'), asyncH(async (req, res) => {
  const csv = toCsv(
    [{ first_name: 'Asha', last_name: 'Verma', email: 'asha@example.com', phone: '9876543210', dob: '1995-04-12', gender: 'female', joined_on: '2026-07-01', employment_type: 'full_time', department: 'Engineering', designation: 'Engineer', location: 'Bengaluru', manager_email: 'manager@example.com', employee_code: 'EMP0101' }],
    ['first_name', 'last_name', 'email', 'phone', 'dob', 'gender', 'joined_on', 'employment_type', 'department', 'designation', 'location', 'manager_email', 'employee_code'].map((k) => ({ key: k, header: k }))
  );
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=employee_import_template.csv');
  res.send(csv);
}));

// ---------- Employee self/profile update request ----------
r.post('/:id/profile-request', asyncH(async (req, res) => {
  const target = Number(req.params.id);
  if (Number(req.user.employee_id) !== target) throw new HttpError(403, 'You can only request changes to your own profile');
  const [hrUsers] = await pool.query(
    `SELECT u.id, u.email FROM users u WHERE u.tenant_id = ? AND u.role IN ('hr_admin','company_owner') AND u.status = 'active'`,
    [req.user.tenant_id]
  );
  const changes = req.body || {};
  await notifyEvent({
    tenantId: req.user.tenant_id, eventKey: 'announcement.published',
    vars: { title: 'Profile update request', body: `${req.user.name} requested profile changes: ${JSON.stringify(changes).slice(0, 300)}` },
    recipients: hrUsers.map((u) => ({ userId: u.id, email: u.email })), link: `/employees/${target}`,
  });
  await logAudit({ tenantId: req.user.tenant_id, actor: req.user, action: 'employee.profile_update_request', entityType: 'employee', entityId: target, after: changes, req });
  res.json({ ok: true, message: 'Request sent to HR' });
}));

module.exports = r;
