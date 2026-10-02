/**
 * Master Data — company-defined reference lists (cost categories, exit reasons,
 * shift patterns, asset classes, …) reused across modules instead of being
 * hard-coded in each feature.
 */
const express = require('express');
const { pool } = require('../../config/db');
const { asyncH, HttpError } = require('../../utils/helpers');
const { requirePermission } = require('../../middleware/auth');
const { tenantId, writeTenantId, audit, int, decode } = require('./_shared');

const r = express.Router();

const READ = requirePermission('administration.master_data.view', { anyOf: ['settings.view'] });
const WRITE = requirePermission('administration.master_data.manage', { anyOf: ['settings.manage'] });

r.get('/master-data/categories', READ, asyncH(async (req, res) => {
  const t = tenantId(req);
  const [rows] = await pool.query(
    `SELECT c.*, (SELECT COUNT(*) FROM master_data_items i WHERE i.category_id = c.id AND (i.status IS NULL OR i.status = 'active')) AS item_count
     FROM master_data_categories c WHERE c.tenant_id = ? ORDER BY c.is_system DESC, c.name`, [t]
  );
  res.json({ data: decode(rows, []) });
}));

r.post('/master-data/categories', WRITE, asyncH(async (req, res) => {
  const t = writeTenantId(req);
  const { code, name, description, entity_binding: entityBinding } = req.body || {};
  if (!name) throw new HttpError(400, 'A category name is required');
  const key = String(code || name).trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_');
  const [dupe] = await pool.query('SELECT id FROM master_data_categories WHERE tenant_id = ? AND code = ?', [t, key]);
  if (dupe[0]) throw new HttpError(409, 'That category code already exists');
  const [ins] = await pool.query(
    `INSERT INTO master_data_categories (tenant_id, code, name, description, entity_binding, is_system, status, created_by)
     VALUES (?,?,?,?,?,0,'active',?)`,
    [t, key, name, description || null, entityBinding || null, req.user.id]
  );
  await audit(req, { action: 'master_data.category.create', entityType: 'master_data', entityId: ins.insertId, after: { code: key, name } });
  res.status(201).json({ data: { id: ins.insertId, code: key } });
}));

r.put('/master-data/categories/:id', WRITE, asyncH(async (req, res) => {
  const t = writeTenantId(req);
  const [rows] = await pool.query('SELECT * FROM master_data_categories WHERE id = ? AND tenant_id = ?', [int(req.params.id), t]);
  if (!rows[0]) throw new HttpError(404, 'Category not found');
  if (rows[0].is_system) throw new HttpError(403, 'System categories cannot be edited');
  const { name, description, entity_binding: entityBinding, status } = req.body || {};
  const sets = []; const params = [];
  if (name) { sets.push('name = ?'); params.push(name); }
  if (description !== undefined) { sets.push('description = ?'); params.push(description); }
  if (entity_binding !== undefined) { sets.push('entity_binding = ?'); params.push(entityBinding); }
  if (status) { sets.push('status = ?'); params.push(status); }
  if (!sets.length) throw new HttpError(400, 'Nothing to update');
  params.push(rows[0].id, t);
  await pool.query(`UPDATE master_data_categories SET ${sets.join(', ')}, updated_at = NOW() WHERE id = ? AND tenant_id = ?`, params);
  await audit(req, { action: 'master_data.category.update', entityType: 'master_data', entityId: rows[0].id, before: rows[0], after: req.body });
  res.json({ ok: true });
}));

r.delete('/master-data/categories/:id', WRITE, asyncH(async (req, res) => {
  const t = writeTenantId(req);
  const [rows] = await pool.query('SELECT * FROM master_data_categories WHERE id = ? AND tenant_id = ?', [int(req.params.id), t]);
  if (!rows[0]) throw new HttpError(404, 'Category not found');
  if (rows[0].is_system) throw new HttpError(403, 'System categories cannot be deleted');
  await pool.query('DELETE FROM master_data_items WHERE category_id = ?', [rows[0].id]);
  await pool.query('DELETE FROM master_data_categories WHERE id = ? AND tenant_id = ?', [rows[0].id, t]);
  await audit(req, { action: 'master_data.category.delete', entityType: 'master_data', entityId: rows[0].id, before: rows[0] });
  res.json({ ok: true });
}));

/** Items for one category, or for every category when `?category_code=` is absent. */
r.get('/master-data/items', READ, asyncH(async (req, res) => {
  const t = tenantId(req);
  const params = [t];
  let where = 'i.tenant_id = ?';
  if (req.query.category_id) { where += ' AND i.category_id = ?'; params.push(int(req.query.category_id)); }
  if (req.query.category_code) { where += ' AND i.category_id = (SELECT id FROM master_data_categories WHERE tenant_id = ? AND code = ?)'; params.push(t, req.query.category_code); }
  if (req.query.status) { where += ' AND i.status = ?'; params.push(req.query.status); }
  if (req.query.q) { where += ' AND (i.name LIKE ? OR i.code LIKE ?)'; params.push(`%${req.query.q}%`, `%${req.query.q}%`); }
  const [rows] = await pool.query(
    `SELECT i.*, c.code AS category_code, c.name AS category_name
     FROM master_data_items i JOIN master_data_categories c ON c.id = i.category_id
     WHERE ${where} ORDER BY c.name, i.sort_order, i.name`, params
  );
  res.json({ data: decode(rows, ['metadata']) });
}));

r.post('/master-data/items', WRITE, asyncH(async (req, res) => {
  const t = writeTenantId(req);
  const { category_id: categoryId, code, name, description, metadata, sort_order: sortOrder } = req.body || {};
  if (!categoryId || !name) throw new HttpError(400, 'category_id and name are required');
  const [cats] = await pool.query('SELECT id FROM master_data_categories WHERE id = ? AND tenant_id = ?', [int(categoryId), t]);
  if (!cats[0]) throw new HttpError(400, 'That category does not belong to this company');
  const [dupe] = await pool.query(
    'SELECT id FROM master_data_items WHERE category_id = ? AND code = ?', [int(categoryId), code ? String(code) : name]
  );
  if (dupe[0]) throw new HttpError(409, 'That item already exists in this category');
  const [ins] = await pool.query(
    `INSERT INTO master_data_items (tenant_id, category_id, code, name, description, metadata, status, sort_order, created_by)
     VALUES (?,?,?,?,?,?,'active',?,?)`,
    [t, int(categoryId), code || null, name, description || null, metadata ? JSON.stringify(metadata) : null,
      int(sortOrder, 0), req.user.id]
  );
  await audit(req, { action: 'master_data.item.create', entityType: 'master_data', entityId: ins.insertId, after: { name, categoryId } });
  res.status(201).json({ data: { id: ins.insertId, name } });
}));

r.put('/master-data/items/:id', WRITE, asyncH(async (req, res) => {
  const t = writeTenantId(req);
  const [rows] = await pool.query('SELECT * FROM master_data_items WHERE id = ? AND tenant_id = ?', [int(req.params.id), t]);
  if (!rows[0]) throw new HttpError(404, 'Item not found');
  const { name, description, metadata, status, sort_order: sortOrder, effective_from: from, effective_to: to } = req.body || {};
  const sets = []; const params = [];
  if (name) { sets.push('name = ?'); params.push(name); }
  if (description !== undefined) { sets.push('description = ?'); params.push(description); }
  if (metadata !== undefined) { sets.push('metadata = ?'); params.push(metadata ? JSON.stringify(metadata) : null); }
  if (status) { sets.push('status = ?'); params.push(status); }
  if (sortOrder !== undefined) { sets.push('sort_order = ?'); params.push(int(sortOrder, 0)); }
  if (from !== undefined) { sets.push('effective_from = ?'); params.push(from); }
  if (to !== undefined) { sets.push('effective_to = ?'); params.push(to); }
  if (!sets.length) throw new HttpError(400, 'Nothing to update');
  params.push(rows[0].id, t);
  await pool.query(`UPDATE master_data_items SET ${sets.join(', ')}, updated_at = NOW() WHERE id = ? AND tenant_id = ?`, params);
  await audit(req, { action: 'master_data.item.update', entityType: 'master_data', entityId: rows[0].id, before: decode(rows[0], ['metadata']), after: req.body });
  res.json({ ok: true });
}));

r.delete('/master-data/items/:id', WRITE, asyncH(async (req, res) => {
  const t = writeTenantId(req);
  const [rows] = await pool.query('SELECT * FROM master_data_items WHERE id = ? AND tenant_id = ?', [int(req.params.id), t]);
  if (!rows[0]) throw new HttpError(404, 'Item not found');
  // Retire rather than delete: historical records keep a valid reference.
  await pool.query("UPDATE master_data_items SET status = 'inactive', effective_to = CURDATE() WHERE id = ? AND tenant_id = ?", [rows[0].id, t]);
  await audit(req, { action: 'master_data.item.retire', entityType: 'master_data', entityId: rows[0].id, before: rows[0] });
  res.json({ ok: true });
}));

module.exports = r;
