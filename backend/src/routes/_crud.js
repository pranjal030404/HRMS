const express = require('express');
const { pool } = require('../config/db');
const { asyncH, HttpError, pick } = require('../utils/helpers');
const { logAudit } = require('../services/audit');

/**
 * Generic tenant-scoped CRUD for master tables.
 * cfg: {
 *   table, perm, fields: [string...], required: [string...], searchable: [string...],
 *   orderBy: 'name', numericFields: [string...], boolFields: [string...], jsonFields: [string...],
 *   listWhere: (tenantId, req) => [sql, params] (extra WHERE)
 * }
 */
function crudRouter(cfg) {
  const r = express.Router();
  const allCols = () => cfg.fields.join(', ');

  const coerce = (body) => {
    const data = pick(body, cfg.fields);
    for (const k of cfg.numericFields || []) if (data[k] !== undefined && data[k] !== null) data[k] = Number(data[k]);
    for (const k of cfg.boolFields || []) if (data[k] !== undefined) data[k] = data[k] === true || data[k] === 'true' || data[k] === 1 ? 1 : 0;
    for (const k of cfg.jsonFields || []) if (data[k] !== undefined && data[k] !== null) data[k] = JSON.stringify(data[k]);
    return data;
  };

  r.get('/', asyncH(async (req, res) => {
    const params = [req.user.tenant_id];
    let where = 'tenant_id = ?';
    if (cfg.listWhere) {
      const [w, p] = cfg.listWhere(req.user.tenant_id, req);
      where += ` AND (${w})`;
      params.push(...p);
    }
    if (req.query.q && cfg.searchable) {
      where += ' AND (' + cfg.searchable.map((s) => `${s} LIKE ?`).join(' OR ') + ')';
      for (const _ of cfg.searchable) params.push(`%${req.query.q}%`);
    }
    if (req.query.status) { where += ' AND status = ?'; params.push(req.query.status); }
    const [rows] = await pool.query(
      `SELECT id, ${allCols()} FROM ${cfg.table} WHERE ${where} ORDER BY ${cfg.orderBy || 'id'} LIMIT 500`,
      params
    );
    res.json({ data: rows });
  }));

  r.get('/:id', asyncH(async (req, res) => {
    const [rows] = await pool.query(
      `SELECT id, ${allCols()} FROM ${cfg.table} WHERE id = ? AND tenant_id = ?`,
      [req.params.id, req.user.tenant_id]
    );
    if (!rows[0]) throw new HttpError(404, 'Record not found');
    res.json({ data: rows[0] });
  }));

  r.post('/', asyncH(async (req, res) => {
    const data = coerce(req.body);
    for (const f of cfg.required || []) {
      if (data[f] === undefined || data[f] === null) throw new HttpError(400, `${f} is required`);
    }
    const cols = ['tenant_id', ...cfg.fields];
    const vals = [req.user.tenant_id, ...cfg.fields.map((f) => data[f] ?? null)];
    const [ins] = await pool.query(
      `INSERT INTO ${cfg.table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
      vals
    );
    await logAudit({ tenantId: req.user.tenant_id, actor: req.user, action: `${cfg.table}.create`, entityType: cfg.table, entityId: ins.insertId, after: data, req });
    res.status(201).json({ data: { id: ins.insertId, ...data } });
  }));

  r.put('/:id', asyncH(async (req, res) => {
    const [before] = await pool.query(`SELECT id, ${allCols()} FROM ${cfg.table} WHERE id = ? AND tenant_id = ?`, [req.params.id, req.user.tenant_id]);
    if (!before[0]) throw new HttpError(404, 'Record not found');
    const data = coerce(req.body);
    const sets = cfg.fields.filter((f) => data[f] !== undefined).map((f) => `${f} = ?`);
    if (!sets.length) throw new HttpError(400, 'No fields to update');
    const params = cfg.fields.filter((f) => data[f] !== undefined).map((f) => data[f] ?? null);
    params.push(req.params.id, req.user.tenant_id);
    await pool.query(`UPDATE ${cfg.table} SET ${sets.join(', ')} WHERE id = ? AND tenant_id = ?`, params);
    await logAudit({ tenantId: req.user.tenant_id, actor: req.user, action: `${cfg.table}.update`, entityType: cfg.table, entityId: req.params.id, before: before[0], after: data, req });
    res.json({ data: { id: Number(req.params.id), ...before[0], ...data } });
  }));

  r.delete('/:id', asyncH(async (req, res) => {
    const [before] = await pool.query(`SELECT id, ${allCols()} FROM ${cfg.table} WHERE id = ? AND tenant_id = ?`, [req.params.id, req.user.tenant_id]);
    if (!before[0]) throw new HttpError(404, 'Record not found');
    await pool.query(`DELETE FROM ${cfg.table} WHERE id = ? AND tenant_id = ?`, [req.params.id, req.user.tenant_id]);
    await logAudit({ tenantId: req.user.tenant_id, actor: req.user, action: `${cfg.table}.delete`, entityType: cfg.table, entityId: req.params.id, before: before[0], req });
    res.json({ ok: true });
  }));

  return r;
}

module.exports = { crudRouter };
