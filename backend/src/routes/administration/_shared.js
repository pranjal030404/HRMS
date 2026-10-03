/**
 * Shared plumbing for the Administration Center routers.
 *
 * Everything here exists to make tenant isolation and audit unavoidable rather
 * than something each endpoint has to remember:
 *   - `tenantId(req)` is derived from the session, never from request input;
 *   - `audit()` stamps every write with actor, module, outcome and request id;
 *   - `crud()` builds the list/read/create/update/delete set for a config table
 *     with column whitelisting, tenant scoping and audit already wired in.
 */
const { pool } = require('../../config/db');
const { asyncH, HttpError } = require('../../utils/helpers');
const { logAudit } = require('../../services/audit');
const { requirePermission } = require('../../middleware/auth');

/**
 * The tenant a read may address. Derived from the session; a platform operator
 * may look across companies, but only when it names one explicitly.
 *
 * Naming a company other than the caller's own requires a live support-access
 * session; the check is asynchronous, so cross-tenant reads use `resolveTenantId`.
 */
function tenantId(req) {
  if (req.user.isPlatformAdmin) {
    const asked = req.query.tenant_id ?? req.body?.tenant_id;
    if (asked !== undefined && asked !== null && asked !== '') return Number(asked);
    return req.user.tenant_id ?? null;
  }
  if (req.user.tenant_id == null) throw new HttpError(403, 'Your account is not bound to a company');
  assertOwnTenant(req);
  return req.user.tenant_id;
}

/**
 * Async form of `tenantId` that also enforces Support Access (spec §21).
 * Every route that can address another company uses this instead.
 */
async function resolveTenantId(req, { required = false } = {}) {
  const asked = req.query?.tenant_id ?? req.body?.tenant_id;
  if (req.user.isPlatformAdmin) {
    if (asked === undefined || asked === null || asked === '') {
      if (required && req.user.tenant_id == null) {
        throw new HttpError(400, 'tenant_id is required when acting as the platform administrator');
      }
      return req.user.tenant_id ?? null;
    }
    if (req.user.tenant_id != null && Number(asked) === Number(req.user.tenant_id)) return Number(asked);
    const supportAccess = require('../../services/supportAccess');
    const reach = await supportAccess.assertTenantReach(req.user, Number(asked));
    req.supportSession = reach.session || null;
    return Number(asked);
  }
  if (req.user.tenant_id == null) throw new HttpError(403, 'Your account is not bound to a company');
  assertOwnTenant(req);
  return req.user.tenant_id;
}

/**
 * A tenant user may only ever address their own company. Silently ignoring a
 * foreign `tenant_id` would hide a client's bug, so it is refused outright.
 */
function assertOwnTenant(req) {
  const asked = req.query?.tenant_id ?? req.body?.tenant_id;
  if (asked === undefined || asked === null || asked === '') return;
  if (Number(asked) !== Number(req.user.tenant_id)) {
    throw new HttpError(403, 'You cannot address another company');
  }
}

/**
 * The tenant a write may touch. A platform admin must name the company — a
 * missing tenant can never silently become "the platform's own null tenant".
 */
function writeTenantId(req) {
  if (req.user.isPlatformAdmin && (req.user.tenant_id == null)) {
    const asked = req.body?.tenant_id ?? req.query.tenant_id;
    if (asked === undefined || asked === null || asked === '') {
      throw new HttpError(400, 'tenant_id is required when acting as the platform administrator');
    }
    return Number(asked);
  }
  if (req.user.tenant_id == null) throw new HttpError(403, 'Your account is not bound to a company');
  assertOwnTenant(req);
  return req.user.tenant_id;
}

/** Write form of `resolveTenantId` — a platform operator must name the company. */
async function resolveWriteTenantId(req) {
  const asked = req.body?.tenant_id ?? req.query?.tenant_id;
  if (req.user.isPlatformAdmin && asked !== undefined && asked !== null && asked !== '') {
    if (req.user.tenant_id != null && Number(asked) === Number(req.user.tenant_id)) return Number(asked);
    const supportAccess = require('../../services/supportAccess');
    const reach = await supportAccess.assertTenantReach(req.user, Number(asked));
    req.supportSession = reach.session || null;
    return Number(asked);
  }
  return writeTenantId(req);
}

const MODULE = 'administration';

async function audit(req, { action, entityType, entityId, before, after, outcome = 'success' }) {
  // A platform-wide action (listing tenants, comparing plans) is not scoped to one
  // company; audit_logs.tenant_id is nullable so it can be recorded as platform-wide.
  const tenant = req.user.isPlatformAdmin && req.user.tenant_id == null
    ? (req.query?.tenant_id ?? req.body?.tenant_id ?? null)
    : writeTenantId(req);
  await logAudit({
    tenantId: tenant === null || tenant === '' ? null : Number(tenant),
    actor: req.user,
    action: `${MODULE}.${action}`,
    entityType,
    entityId,
    before,
    after,
    req,
    module: MODULE,
    outcome,
  });
}

const int = (v, d = null) => (v === undefined || v === null || v === '' || Number.isNaN(Number(v)) ? d : parseInt(v, 10));
const bool = (v) => (v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0);
const j = (v) => (v === undefined || v === null ? v : JSON.stringify(v));
const unj = (v, d) => {
  if (v === null || v === undefined) return d;
  if (typeof v !== 'string') return v;
  try { const p = JSON.parse(v); return p === null ? d : p; } catch { return d; }
};
const now = () => new Date().toISOString().slice(0, 19).replace('T', ' ');

/**
 * Insert many rows at once. Built with explicit placeholders because mysql2 does
 * not expand an array of arrays for a bare `VALUES ?` placeholder.
 */
async function insertRows(table, columns, rows) {
  if (!rows.length) return { affectedRows: 0 };
  const placeholders = rows.map(() => `(${columns.map(() => '?').join(',')})`).join(', ');
  const [result] = await pool.query(
    `INSERT INTO ${table} (${columns.join(',')}) VALUES ${placeholders}`, rows.flat()
  );
  return result;
}

function paging(query, defaultLimit = 25) {
  const limit = Math.min(200, Math.max(1, int(query.limit, defaultLimit)));
  const page = Math.max(1, int(query.page, 1));
  return { limit, offset: (page - 1) * limit, page };
}

/** Parse a list of JSON columns; accepts a single row or an array of rows. */
const decode = (rowsOrRow, jsonFields = []) => {
  if (Array.isArray(rowsOrRow)) return rowsOrRow.map((row) => decode(row, jsonFields));
  const out = { ...rowsOrRow };
  for (const f of jsonFields) out[f] = unj(rowsOrRow[f], null);
  return out;
};

async function assertUnique(table, tenant, keys, body, ignoreId) {
  const present = keys.filter((k) => body[k.key] !== undefined && body[k.key] !== null && body[k.key] !== '');
  if (!present.length) return;
  const cols = present.map((k) => `${k.col || k.key} = ?`);
  const [rows] = await pool.query(
    `SELECT id FROM ${table} WHERE tenant_id = ? AND ${cols.join(' AND ')}${ignoreId ? ' AND id <> ?' : ''} LIMIT 1`,
    [tenant, ...present.map((k) => body[k.key]), ...(ignoreId ? [ignoreId] : [])]
  );
  if (rows[0]) throw new HttpError(409, `That ${present[0].key.replace(/_/g, ' ')} is already in use`);
}

/**
 * Build list / read / create / update / delete endpoints for a configuration
 * table. Column whitelisting keeps callers from reaching columns the UI does not
 * own, and every mutation lands in the audit trail.
 *
 * spec = {
 *   table, fields, perms: { read, write, delete }, searchFields, filterable,
 *   jsonFields, orderBy, softDelete, stamps, uniqueKeys, onChange
 * }
 */
function crud(router, path, spec) {
  const {
    table, fields, perms, searchFields = [], filterable = [], jsonFields = [],
    orderBy = 'id DESC', softDelete = null, stamps = [], uniqueKeys = [], onChange = null,
  } = spec;

  const readGate = requirePermission(perms.read, { anyOf: [perms.read].concat(perms.anyOf || []) });
  const writeGate = requirePermission(perms.write, { anyOf: [perms.write].concat(perms.anyOf || []) });
  const deleteGate = requirePermission(perms.delete || perms.write, { anyOf: [perms.delete || perms.write].concat(perms.anyOf || []) });

  router.get(path, readGate, asyncH(async (req, res) => {
    const t = tenantId(req);
    const { limit, offset, page } = paging(req.query);
    const where = ['tenant_id = ?'];
    const params = [t];
    if (req.query.q && searchFields.length) {
      where.push(`(${searchFields.map((f) => `${f} LIKE ?`).join(' OR ')})`);
      searchFields.forEach(() => params.push(`%${req.query.q}%`));
    }
    for (const f of filterable) {
      if (req.query[f] === undefined || req.query[f] === '') continue;
      where.push(`${f} = ?`);
      params.push(req.query[f]);
    }
    const base = `FROM ${table} WHERE ${where.join(' AND ')}`;
    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total ${base}`, params);
    const [rows] = await pool.query(`SELECT * ${base} ORDER BY ${orderBy} LIMIT ${limit} OFFSET ${offset}`, params);
    res.json({ data: rows.map((r) => decode(r, jsonFields)), meta: { total, page, pages: Math.ceil(total / limit), limit } });
  }));

  router.get(`${path}/:id`, readGate, asyncH(async (req, res) => {
    const [rows] = await pool.query(`SELECT * FROM ${table} WHERE id = ? AND tenant_id = ?`, [req.params.id, tenantId(req)]);
    if (!rows[0]) throw new HttpError(404, 'Not found');
    res.json({ data: decode(rows[0], jsonFields) });
  }));

  router.post(path, writeGate, asyncH(async (req, res) => {
    const t = writeTenantId(req);
    const body = { ...(req.body || {}) };
    delete body.tenant_id;
    const cols = ['tenant_id']; const vals = [t];
    for (const f of fields) {
      if (body[f] === undefined) continue;
      cols.push(f); vals.push(jsonFields.includes(f) ? j(body[f]) : body[f]);
    }
    for (const s of stamps) { cols.push(s); vals.push(req.user.id); }
    if (!cols.length) throw new HttpError(400, 'Nothing to save');
    await assertUnique(table, t, uniqueKeys, body, null);
    const [ins] = await pool.query(
      `INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, vals
    );
    onChange?.(t, ins.insertId);
    await audit(req, { action: `${table}.create`, entityType: table, entityId: ins.insertId, after: body });
    res.status(201).json({ data: { id: ins.insertId, ...body } });
  }));

  router.put(`${path}/:id`, writeGate, asyncH(async (req, res) => {
    const t = writeTenantId(req);
    const [before] = await pool.query(`SELECT * FROM ${table} WHERE id = ? AND tenant_id = ?`, [req.params.id, t]);
    if (!before[0]) throw new HttpError(404, 'Not found');
    const body = { ...(req.body || {}) };
    delete body.tenant_id;
    const sets = []; const vals = [];
    for (const f of fields) {
      if (body[f] === undefined) continue;
      sets.push(`${f} = ?`);
      vals.push(jsonFields.includes(f) ? j(body[f]) : body[f]);
    }
    for (const s of stamps.filter((x) => x === 'updated_by')) { sets.push(`${s} = ?`); vals.push(req.user.id); }
    if (!sets.length) throw new HttpError(400, 'Nothing to update');
    await assertUnique(table, t, uniqueKeys, body, req.params.id);
    vals.push(req.params.id, t);
    await pool.query(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = ? AND tenant_id = ?`, vals);
    onChange?.(t, req.params.id);
    await audit(req, { action: `${table}.update`, entityType: table, entityId: req.params.id, before: before[0], after: body });
    res.json({ ok: true });
  }));

  router.delete(`${path}/:id`, deleteGate, asyncH(async (req, res) => {
    const t = writeTenantId(req);
    const [before] = await pool.query(`SELECT * FROM ${table} WHERE id = ? AND tenant_id = ?`, [req.params.id, t]);
    if (!before[0]) throw new HttpError(404, 'Not found');
    if (softDelete) {
      const sets = [`status = 'inactive'`];
      if (softDateExists(table, softDelete)) sets.push(`${softDelete} = ?`);
      const params = softDateExists(table, softDelete) ? [now(), req.params.id, t] : [req.params.id, t];
      await pool.query(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = ? AND tenant_id = ?`, params);
    } else {
      await pool.query(`DELETE FROM ${table} WHERE id = ? AND tenant_id = ?`, [req.params.id, t]);
    }
    onChange?.(t, req.params.id);
    await audit(req, { action: `${table}.delete`, entityType: table, entityId: req.params.id, before: before[0] });
    res.json({ ok: true });
  }));

  return router;
}

const softDateCache = new Map();
function softDateExists(table, column) {
  const key = `${table}.${column}`;
  if (!softDateCache.has(key)) {
    softDateCache.set(key, SOFT_DATE_COLUMNS.has(`${table}.${column}`));
  }
  return softDateCache.get(key);
}
// Columns that hold a "when did this stop being current" timestamp.
const SOFT_DATE_COLUMNS = new Set(['departments.archived_at', 'custom_forms.published_at']);

module.exports = {
  insertRows,
  tenantId, writeTenantId, resolveTenantId, resolveWriteTenantId, audit, int, bool, j, unj, paging, crud, decode,
  assertUnique, MODULE, now,
};
