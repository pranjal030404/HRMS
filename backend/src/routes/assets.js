const express = require('express');
const dayjs = require('dayjs');
const { pool } = require('../config/db');
const { asyncH, HttpError } = require('../utils/helpers');
const { authenticate, requirePermission } = require('../middleware/auth');
const { logAudit } = require('../services/audit');
const { crudRouter } = require('./_crud');

const r = express.Router();
r.use(authenticate);

r.use('/inventory', crudRouter({
  table: 'assets', perm: 'asset.manage',
  fields: ['asset_code', 'name', 'category', 'serial_no', 'brand', 'model', 'purchase_date', 'purchase_value', 'status', 'location_id', 'notes'],
  required: ['asset_code', 'name'], searchable: ['asset_code', 'name', 'serial_no'],
  numericFields: ['purchase_value', 'location_id'],
}));

r.get('/', requirePermission('asset.view'), asyncH(async (req, res) => {
  const params = [req.user.tenant_id];
  let where = 'a.tenant_id = ?';
  if (req.query.status) { where += ' AND a.status = ?'; params.push(req.query.status); }
  if (req.query.category) { where += ' AND a.category = ?'; params.push(req.query.category); }
  const [rows] = await pool.query(
    `SELECT a.*, l.name AS location_name,
      (SELECT ae.employee_id FROM asset_assignments ae WHERE ae.asset_id = a.id AND ae.status = 'assigned' LIMIT 1) AS current_holder_id,
      (SELECT CONCAT(e.first_name, ' ', e.last_name) FROM asset_assignments ae JOIN employees e ON e.id = ae.employee_id WHERE ae.asset_id = a.id AND ae.status = 'assigned' LIMIT 1) AS current_holder
     FROM assets a LEFT JOIN locations l ON l.id = a.location_id WHERE ${where} ORDER BY a.asset_code LIMIT 300`,
    params
  );
  res.json({ data: rows });
}));

r.get('/assignments', requirePermission('asset.view'), asyncH(async (req, res) => {
  const params = [req.user.tenant_id];
  let where = 'aa.tenant_id = ?';
  if (req.query.employee_id) { where += ' AND aa.employee_id = ?'; params.push(req.query.employee_id); }
  const [rows] = await pool.query(
    `SELECT aa.*, a.asset_code, a.name AS asset_name, a.category, e.employee_code, e.first_name, e.last_name
     FROM asset_assignments aa JOIN assets a ON a.id = aa.asset_id JOIN employees e ON e.id = aa.employee_id
     WHERE ${where} ORDER BY aa.assigned_on DESC LIMIT 300`,
    params
  );
  res.json({ data: rows });
}));

r.post('/assign', requirePermission('asset.manage'), asyncH(async (req, res) => {
  const { assetId, employeeId, assignedOn, dueReturnOn, conditionOnIssue } = req.body || {};
  if (!assetId || !employeeId) throw new HttpError(400, 'assetId and employeeId required');
  const [assets] = await pool.query('SELECT * FROM assets WHERE id = ? AND tenant_id = ?', [assetId, req.user.tenant_id]);
  if (!assets[0]) throw new HttpError(404, 'Asset not found');
  if (assets[0].status !== 'available') throw new HttpError(400, `Asset is ${assets[0].status}`);
  const [ins] = await pool.query(
    `INSERT INTO asset_assignments (tenant_id, asset_id, employee_id, assigned_on, due_return_on, condition_on_issue, assigned_by) VALUES (?,?,?,?,?,?,?)`,
    [req.user.tenant_id, assetId, employeeId, assignedOn || dayjs().format('YYYY-MM-DD'), dueReturnOn || null, conditionOnIssue || null, req.user.id]
  );
  await pool.query('UPDATE assets SET status = "assigned" WHERE id = ?', [assetId]);
  await logAudit({ tenantId: req.user.tenant_id, actor: req.user, action: 'asset.assign', entityType: 'asset_assignment', entityId: ins.insertId, after: { assetId, employeeId }, req });
  res.status(201).json({ data: { id: ins.insertId } });
}));

r.post('/assignments/:id/return', requirePermission('asset.manage'), asyncH(async (req, res) => {
  const { conditionOnReturn, notes } = req.body || {};
  const [rows] = await pool.query('SELECT * FROM asset_assignments WHERE id = ? AND tenant_id = ?', [req.params.id, req.user.tenant_id]);
  if (!rows[0]) throw new HttpError(404, 'Assignment not found');
  if (rows[0].status === 'returned') throw new HttpError(400, 'Already returned');
  await pool.query(
    'UPDATE asset_assignments SET returned_on = ?, condition_on_return = ?, status = "returned", notes = COALESCE(?, notes) WHERE id = ?',
    [dayjs().format('YYYY-MM-DD'), conditionOnReturn || null, notes || null, req.params.id]
  );
  await pool.query(`UPDATE assets SET status = ${conditionOnReturn === 'damaged' ? '"repair"' : '"available"'} WHERE id = ?`, [rows[0].asset_id]);
  await logAudit({ tenantId: req.user.tenant_id, actor: req.user, action: 'asset.return', entityType: 'asset_assignment', entityId: req.params.id, req });
  res.json({ ok: true });
}));

module.exports = r;
