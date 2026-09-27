const express = require('express');
const dayjs = require('dayjs');
const { pool } = require('../config/db');
const { asyncH, HttpError } = require('../utils/helpers');
const { authenticate, requirePermission } = require('../middleware/auth');
const { crudRouter } = require('./_crud');
const { logAudit } = require('../services/audit');
const { INDIAN_STATES } = require('../utils/helpers');

const r = express.Router();
r.use(authenticate);

r.get('/states', (req, res) => res.json({ data: INDIAN_STATES }));

r.use('/departments', crudRouter({
  table: 'departments', perm: 'org.manage', fields: ['name', 'code', 'parent_id', 'head_employee_id', 'status'],
  required: ['name'], searchable: ['name', 'code'], numericFields: ['parent_id', 'head_employee_id'],
}));
r.use('/designations', crudRouter({
  table: 'designations', perm: 'org.manage', fields: ['name', 'code', 'grade_id', 'status'],
  required: ['name'], searchable: ['name', 'code'], numericFields: ['grade_id'],
}));
r.use('/grades', crudRouter({
  table: 'grades', perm: 'org.manage', fields: ['name', 'level', 'status'],
  required: ['name'], searchable: ['name'], numericFields: ['level'],
}));
r.use('/locations', crudRouter({
  table: 'locations', perm: 'org.manage', fields: ['name', 'code', 'address', 'city', 'state', 'timezone', 'status'],
  required: ['name'], searchable: ['name', 'city', 'state'],
}));
r.use('/cost-centers', crudRouter({
  table: 'cost_centers', perm: 'org.manage', fields: ['name', 'code', 'status'],
  required: ['name'], searchable: ['name', 'code'],
}));
r.use('/shifts', crudRouter({
  table: 'shifts', perm: 'org.manage', fields: ['name', 'code', 'start_time', 'end_time', 'grace_minutes', 'half_day_hours', 'full_day_hours', 'break_minutes', 'weekly_offs', 'cross_midnight', 'overtime_enabled', 'min_overtime_minutes', 'status'],
  required: ['name'], searchable: ['name'], numericFields: ['grace_minutes', 'break_minutes', 'min_overtime_minutes'],
  boolFields: ['cross_midnight', 'overtime_enabled'], jsonFields: ['weekly_offs'],
}));
r.use('/leave-types', crudRouter({
  table: 'leave_types', perm: 'org.manage', fields: ['name', 'code', 'unit', 'is_paid', 'accrual_method', 'accrual_count', 'annual_quota', 'max_carry_forward', 'carry_forward_expiry_months', 'encashable', 'negative_balance_allowed', 'min_notice_days', 'max_consecutive_days', 'applicable_gender', 'proof_required_after_days', 'sandwich_rule', 'requires_approval', 'active'],
  required: ['name', 'code'], searchable: ['name', 'code'],
  numericFields: ['accrual_count', 'annual_quota', 'max_carry_forward', 'carry_forward_expiry_months', 'min_notice_days', 'max_consecutive_days', 'proof_required_after_days'],
  boolFields: ['is_paid', 'encashable', 'negative_balance_allowed', 'active', 'requires_approval'],
}));
r.use('/expense-categories', crudRouter({
  table: 'expense_categories', perm: 'org.manage', fields: ['name', 'monthly_limit', 'receipt_required_above', 'active'],
  required: ['name'], searchable: ['name'], numericFields: ['monthly_limit', 'receipt_required_above'], boolFields: ['active'],
}));
r.use('/letter-templates', crudRouter({
  table: 'letter_templates', perm: 'org.manage', fields: ['name', 'ltype', 'subject', 'body', 'active'],
  required: ['name', 'body'], searchable: ['name', 'ltype'], boolFields: ['active'],
}));
r.use('/customers', crudRouter({
  table: 'customers', perm: 'billing.manage', fields: ['name', 'gstin', 'address', 'city', 'state', 'state_code', 'pincode', 'contact_name', 'email', 'phone', 'payment_terms_days', 'status'],
  required: ['name'], searchable: ['name', 'gstin', 'email'], numericFields: ['payment_terms_days'],
}));

// Holidays: date-based list (year view)
r.get('/holidays', requirePermission('org.view'), asyncH(async (req, res) => {
  const year = parseInt(req.query.year || dayjs().year(), 10);
  const [rows] = await pool.query(
    `SELECT h.*, l.name AS location_name FROM holidays h LEFT JOIN locations l ON l.id = h.location_id
     WHERE h.tenant_id = ? AND YEAR(h.hdate) = ? ORDER BY h.hdate`,
    [req.user.tenant_id, year]
  );
  res.json({ data: rows });
}));

r.post('/holidays', requirePermission('org.manage'), asyncH(async (req, res) => {
  const { hdate, name, htype, location_id } = req.body || {};
  if (!hdate || !name) throw new HttpError(400, 'Date and name required');
  const [ins] = await pool.query(
    `INSERT INTO holidays (tenant_id, location_id, hdate, name, htype) VALUES (?,?,?,?,?)
     ON DUPLICATE KEY UPDATE name = VALUES(name), htype = VALUES(htype)`,
    [req.user.tenant_id, location_id || null, hdate, name, htype || 'public']
  );
  await logAudit({ tenantId: req.user.tenant_id, actor: req.user, action: 'holidays.upsert', entityType: 'holiday', entityId: hdate, after: { name }, req });
  res.status(201).json({ data: { id: ins.insertId } });
}));

r.delete('/holidays/:id', requirePermission('org.manage'), asyncH(async (req, res) => {
  await pool.query('DELETE FROM holidays WHERE id = ? AND tenant_id = ?', [req.params.id, req.user.tenant_id]);
  res.json({ ok: true });
}));

// Lookups (for dropdowns)
r.get('/lookups', asyncH(async (req, res) => {
  const t = req.user.tenant_id;
  const [departments] = await pool.query('SELECT id, name FROM departments WHERE tenant_id = ? AND status = "active"', [t]);
  const [designations] = await pool.query('SELECT id, name, grade_id FROM designations WHERE tenant_id = ? AND status = "active"', [t]);
  const [grades] = await pool.query('SELECT id, name FROM grades WHERE tenant_id = ? AND status = "active"', [t]);
  const [locations] = await pool.query('SELECT id, name, state FROM locations WHERE tenant_id = ? AND status = "active"', [t]);
  const [shifts] = await pool.query('SELECT id, name, start_time, end_time FROM shifts WHERE tenant_id = ? AND status = "active"', [t]);
  const [costCenters] = await pool.query('SELECT id, name FROM cost_centers WHERE tenant_id = ? AND status = "active"', [t]);
  const [leaveTypes] = await pool.query('SELECT id, name, code, unit, is_paid FROM leave_types WHERE tenant_id = ? AND active = 1', [t]);
  const [expenseCategories] = await pool.query('SELECT id, name FROM expense_categories WHERE tenant_id = ? AND active = 1', [t]);
  res.json({ data: { departments, designations, grades, locations, shifts, costCenters, leaveTypes, expenseCategories } });
}));

module.exports = r;
