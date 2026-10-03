const express = require('express');
const { pool } = require('../config/db');
const { asyncH, HttpError, pick } = require('../utils/helpers');
const { logAudit } = require('../services/audit');
const { requirePermission } = require('../middleware/auth');
const limits = require('../services/limits');
const usage = require('../services/usage');

/**
 * Generic tenant-scoped CRUD for master tables.
 * cfg: {
 *   table, perm, fields: [string...], required: [string...], searchable: [string...],
 *   orderBy: 'name', numericFields: [string...], boolFields: [string...], jsonFields: [string...],
 *   readPerm: [string...] (defaults to perm with '.manage' → '.view' when applicable)
 *   listWhere: (tenantId, req) => [sql, params] (extra WHERE)
 *   limit: 'employees.max' — entitlement that caps how many rows of this table the
 *     tenant may hold (spec §14). Declared as data so a new metered resource gets
 *     enforcement by adding one line, not by remembering to add a check.
 * }
 * Reads require the read permission; create/update/delete require cfg.perm.
 */
function crudRouter(cfg) {
  const r = express.Router();
  const allCols = () => cfg.fields.join(', ');
  const readPerm = cfg.readPerm || (cfg.perm.endsWith('.manage') ? cfg.perm.replace(/\.manage$/, '.view') : cfg.perm);
  const gateRead = requirePermission(readPerm);
  const gateWrite = requirePermission(cfg.perm);

  const coerce = (body) => {
    const data = pick(body, cfg.fields);
    for (const k of cfg.numericFields || []) if (data[k] !== undefined && data[k] !== null) data[k] = Number(data[k]);
    for (const k of cfg.boolFields || []) if (data[k] !== undefined) data[k] = data[k] === true || data[k] === 'true' || data[k] === 1 ? 1 : 0;
    for (const k of cfg.jsonFields || []) if (data[k] !== undefined && data[k] !== null) data[k] = JSON.stringify(data[k]);
    return data;
  };

  r.get('/', gateRead, asyncH(async (req, res) => {
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

  r.get('/:id', gateRead, asyncH(async (req, res) => {
    const [rows] = await pool.query(
      `SELECT id, ${allCols()} FROM ${cfg.table} WHERE id = ? AND tenant_id = ?`,
      [req.params.id, req.user.tenant_id]
    );
    if (!rows[0]) throw new HttpError(404, 'Record not found');
    res.json({ data: rows[0] });
  }));

  const createRow = async (req, res) => {
    const data = coerce(req.body);
    for (const f of cfg.required || []) {
      if (data[f] === undefined || data[f] === null) throw new HttpError(400, `${f} is required`);
    }
    // Server-side commercial limit (spec §14). The value comes from the tenant's
    // plan or override — nothing about it is hard-coded here.
    if (cfg.limit) {
      await limits.assertWithinLimit({
        tenantId: req.user.tenant_id, entitlementKey: cfg.limit, incoming: 1,
        action: `${cfg.table}.create`, req,
      });
    }
    const cols = ['tenant_id', ...cfg.fields];
    const vals = [req.user.tenant_id, ...cfg.fields.map((f) => data[f] ?? null)];
    const [ins] = await pool.query(
      `INSERT INTO ${cfg.table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
      vals
    );
    await logAudit({ tenantId: req.user.tenant_id, actor: req.user, action: `${cfg.table}.create`, entityType: cfg.table, entityId: ins.insertId, after: data, req });
    if (cfg.limit) await usage.recompute(req.user.tenant_id, { source: `${cfg.table}_create`, actorUserId: req.user.id, requestId: req.requestId });
    res.status(201).json({ data: { id: ins.insertId, ...data } });
  };
  // Capped tables check-then-insert, so they run under a per-company lock (see limits.withTenantLock).
  r.post('/', gateWrite, asyncH((req, res) => (cfg.limit
    ? limits.withTenantLock(req.user.tenant_id, `${cfg.table}.create`, () => createRow(req, res))
    : createRow(req, res))));

  r.put('/:id', gateWrite, asyncH(async (req, res) => {
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

  r.delete('/:id', gateWrite, asyncH(async (req, res) => {
    const [before] = await pool.query(`SELECT id, ${allCols()} FROM ${cfg.table} WHERE id = ? AND tenant_id = ?`, [req.params.id, req.user.tenant_id]);
    if (!before[0]) throw new HttpError(404, 'Record not found');
    await pool.query(`DELETE FROM ${cfg.table} WHERE id = ? AND tenant_id = ?`, [req.params.id, req.user.tenant_id]);
    await logAudit({ tenantId: req.user.tenant_id, actor: req.user, action: `${cfg.table}.delete`, entityType: cfg.table, entityId: req.params.id, before: before[0], req });
    res.json({ ok: true });
  }));

  return r;
}

module.exports = { crudRouter };
