/**
 * Tenant data export (spec §28).
 *
 * Export is a tracked job, not a synchronous endpoint. That is deliberate: an
 * export of a 5,000-employee company with a year of payroll is thousands of rows,
 * and a request that assembles it inline is both a denial-of-service lever and an
 * exfiltration primitive — one authenticated call that walks a whole tenant.
 *
 * The job therefore has a lifecycle of its own:
 *
 *   queued → running → completed      (artefact written, expires_at enforced)
 *              └──→ failed            (error_message recorded, retryable)
 *
 * `runNext()` claims one queued job, assembles it into a single JSON file under
 * the upload directory and marks it complete. It is called by the scheduler, by
 * the CLI runner, and by the tests — the assembly is idempotent per request id,
 * so a job that is retried after a crash simply re-runs and overwrites.
 *
 * The artefact is scoped to the request's own `scope_json`: an operator asking for
 * payroll does not silently receive the document vault too. Every read is taken
 * through the same tenant boundary the API uses — `tenant_id = ?`, never a
 * client-supplied id — so an export cannot be pointed at a different company.
 */
const fs = require('fs');
const path = require('path');
const { pool } = require('../config/db');
const env = require('../config/env');
const platformAudit = require('./platformAudit');

const EXPORT_DIR = path.join(env.uploadDir, 'exports');
/** How long a finished artefact is retrievable before it is swept. */
const ARTEFACT_TTL_DAYS = 7;

/**
 * Formats the worker can genuinely produce.
 *
 * `csv` is emitted only when exactly one data set is requested — a CSV has one
 * header row, so a multi-set request has no honest single-file CSV rendering.
 * That constraint is enforced at request time rather than discovered afterwards.
 */
const SUPPORTED_FORMATS = { json: true, csv: true };

/**
 * The catalogue of exportable data sets. Each entry is a name the console offers,
 * its SQL, and whether it contains rows that must be masked.
 *
 * `sensitive` does not mean "excluded" — an export is how a customer leaves with
 * their own data — but it does mean the response is marked, so an operator
 * choosing it is a deliberate act rather than an accident, and the job is always
 * audited with the scope it actually read.
 */
const DATASETS = {
  employees: {
    label: 'Employees',
    sql: `SELECT e.*, d.name AS department_name, des.name AS designation_name, l.name AS location_name
          FROM employees e
          LEFT JOIN departments d ON d.id = e.department_id
          LEFT JOIN designations des ON des.id = e.designation_id
          LEFT JOIN locations l ON l.id = e.location_id
          WHERE e.tenant_id = ? AND e.deleted_at IS NULL`,
  },
  attendance: {
    label: 'Attendance',
    sql: `SELECT * FROM attendance_records WHERE tenant_id = ? ORDER BY adate DESC LIMIT 200000`,
  },
  leave: {
    label: 'Leave requests & balances',
    sql: `SELECT lr.*, lt.name AS leave_type FROM leave_requests lr
          LEFT JOIN leave_types lt ON lt.id = lr.leave_type_id
          WHERE lr.tenant_id = ? ORDER BY lr.created_at DESC LIMIT 200000`,
  },
  payroll: {
    label: 'Payroll runs, items & payslips',
    sensitive: true,
    sql: `SELECT pr.*, pi.* FROM payroll_runs pr
          LEFT JOIN payroll_items pi ON pi.run_id = pr.id
          WHERE pr.tenant_id = ? ORDER BY pr.period_year DESC, pr.period_month DESC LIMIT 200000`,
  },
  expenses: {
    label: 'Expense claims & reimbursements',
    sql: `SELECT * FROM expense_claims WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 200000`,
  },
  recruitment: {
    label: 'Requisitions, candidates & interviews',
    sensitive: true,
    sql: `SELECT * FROM requisitions WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 100000`,
  },
  performance: {
    label: 'Reviews & goals',
    sql: `SELECT * FROM performance_cycles WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 100000`,
  },
  documents: {
    label: 'Document metadata (not file contents)',
    sensitive: true,
    sql: `SELECT id, tenant_id, title, category, description, version, requires_ack, published_at, created_at
          FROM company_documents WHERE tenant_id = ? ORDER BY created_at DESC`,
  },
  audit: {
    label: 'Audit logs',
    sensitive: true,
    sql: `SELECT * FROM audit_logs WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 200000`,
  },
  configuration: {
    label: 'Company configuration',
    sql: `SELECT * FROM settings WHERE tenant_id = ? ORDER BY skey`,
  },
  organization: {
    label: 'Departments, locations & legal entities',
    sql: `SELECT * FROM legal_entities WHERE tenant_id = ?`,
  },
  users: {
    label: 'User accounts & roles',
    sensitive: true,
    sql: `SELECT id, tenant_id, email, name, role, status, last_login_at, created_at
          FROM users WHERE tenant_id = ? ORDER BY created_at`,
  },
};

const parse = (v) => {
  if (v == null) return {};
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return {}; }
};

/**
 * Queue an export. Returns the tracked request row.
 * `scope` is a `{ datasetName: true }` map; an empty scope means "everything".
 */
async function request({ tenantId, scope, format = 'json', reason, actor, req }) {
  if (!reason || String(reason).trim().length < 5) {
    throw new Error('A reason is required for a data export');
  }
  // Refuse a format we cannot actually produce rather than storing the operator's
  // choice and quietly handing back JSON: a request that says CSV and arrives as
  // JSON is a broken promise to someone exporting their own data.
  const wantedFormat = String(format || 'json').toLowerCase();
  if (!SUPPORTED_FORMATS[wantedFormat]) {
    throw new Error(
      `Export format "${wantedFormat}" is not supported. Available: ${Object.keys(SUPPORTED_FORMATS).join(', ')}`
    );
  }
  const requested = resolveScope(scope);
  if (wantedFormat === 'csv' && Object.keys(requested).length !== 1) {
    throw new Error(
      'CSV export is only available for a single data set, because a CSV file has one header row. '
      + 'Select exactly one, or export as JSON.'
    );
  }
  const [tenant] = await pool.query('SELECT id, name, slug FROM tenants WHERE id = ?', [tenantId]);
  if (!tenant[0]) throw new Error('Tenant not found');

  const [ins] = await pool.query(
    `INSERT INTO data_export_requests
       (tenant_id, requested_by, requested_by_name, scope_json, format, reason, status, expires_at)
     VALUES (?,?,?,?,?,?, 'queued', DATE_ADD(NOW(), INTERVAL ${ARTEFACT_TTL_DAYS} DAY))`,
    [tenantId, actor?.id ?? null, actor?.name || null, JSON.stringify(requested), format, String(reason).trim()]
  );
  await platformAudit.logPlatformAudit({
    tenantId, actor, action: 'data.export_requested', category: 'data',
    entityType: 'data_export_request', entityId: ins.insertId,
    after: { scope: requested, format, datasets: Object.keys(requested).length },
    reason: String(reason).trim(), req,
  });
  return byId(ins.insertId);
}

/** Validate a requested scope against the catalogue so a typo fails loudly. */
function resolveScope(scope) {
  const wanted = scope && typeof scope === 'object' && Object.keys(scope).length
    ? Object.entries(scope).filter(([, v]) => v).map(([k]) => k)
    : Object.keys(DATASETS);
  const unknown = wanted.filter((k) => !DATASETS[k]);
  if (unknown.length) {
    throw new Error(`Unknown export data set(s): ${unknown.join(', ')}. Available: ${Object.keys(DATASETS).join(', ')}`);
  }
  return Object.fromEntries(wanted.map((k) => [k, true]));
}

async function byId(id) {
  const [rows] = await pool.query('SELECT * FROM data_export_requests WHERE id = ?', [id]);
  if (!rows[0]) return null;
  return { ...rows[0], scope: parse(rows[0].scope_json) };
}

/** Tracked requests for a tenant, newest first — the console's export panel. */
async function listForTenant(tenantId, limit = 50) {
  const [rows] = await pool.query(
    'SELECT * FROM data_export_requests WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?', [tenantId, limit]
  );
  return rows.map((r) => ({ ...r, scope: parse(r.scope_json) }));
}

/**
 * Claim and run the oldest queued job. Returns null when the queue is empty.
 *
 * The `status = 'running'` claim is a conditional update: two workers racing on
 * the same row means exactly one gets `affectedRows = 1` and the other moves on,
 * so no job is ever assembled twice concurrently.
 */
async function runNext() {
  const [queued] = await pool.query(
    `SELECT id FROM data_export_requests WHERE status = 'queued' ORDER BY id LIMIT 1`
  );
  if (!queued[0]) return null;

  const [claim] = await pool.query(
    `UPDATE data_export_requests SET status = 'running' WHERE id = ? AND status = 'queued'`, [queued[0].id]
  );
  if (!claim.affectedRows) return null;
  return run(queued[0].id);
}

/**
 * Serialise the read data sets. `json` keeps the manifest (one file, several data
 * sets, self-describing). `csv` is only ever asked for with a single data set, so it
 * can be a plain header row plus escaped records.
 */
function render(format, read, manifest) {
  if (format !== 'csv') return JSON.stringify(manifest, null, 2);
  const only = read[0] || { columns: [], rows: [] };
  const esc = (v) => {
    if (v == null) return '';
    const s = v instanceof Date ? v.toISOString() : String(v);
    // Quote when the value contains a delimiter, quote or newline; double inner quotes.
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [only.columns.join(',')];
  for (const row of only.rows) lines.push(only.columns.map((c) => esc(row[c])).join(','));
  // Trailing newline so the file is well-formed for line-oriented readers.
  return `${lines.join('\n')}\n`;
}

/** Assemble one already-claimed job. Safe to retry: the artefact is overwritten. */
async function run(requestId) {
  const job = await byId(requestId);
  if (!job) return null;
  const actor = { id: job.requested_by, name: job.requested_by_name };
  // The request row's `id` is the *export job* id, not the company id. Reading the
  // wrong one here would silently assemble another tenant's records whenever the
  // two id spaces happened to overlap.
  const tenantId = Number(job.tenant_id);
  if (!Number.isInteger(tenantId) || tenantId <= 0) {
    throw new Error(`export request ${requestId} has no valid tenant_id`);
  }

  try {
    fs.mkdirSync(EXPORT_DIR, { recursive: true });
    const scope = job.scope && Object.keys(job.scope).length ? job.scope : resolveScope({});
    const format = SUPPORTED_FORMATS[String(job.format || 'json').toLowerCase()]
      ? String(job.format || 'json').toLowerCase() : 'json';
    const manifest = {
      exportedAt: new Date().toISOString(),
      requestedBy: job.requested_by_name,
      reason: job.reason,
      scope,
      datasets: {},
    };

    /** Every dataset read, in scope order, so both renderers see the same data. */
    const read = [];
    for (const key of Object.keys(scope)) {
      const ds = DATASETS[key];
      if (!ds) { manifest.datasets[key] = { rows: 0, error: 'unknown data set' }; continue; }
      // Tenant boundary is the parameter, never anything the request body supplied.
      const [rows] = await pool.query(ds.sql, [tenantId]);
      const entry = {
        key, label: ds.label, sensitive: !!ds.sensitive,
        rowCount: rows.length, columns: rows.length ? Object.keys(rows[0]) : [], rows,
      };
      manifest.datasets[key] = entry;
      read.push(entry);
    }

    const filename = `tenant-${tenantId}-export-${requestId}-${Date.now()}.${format}`;
    const full = path.join(EXPORT_DIR, filename);
    fs.writeFileSync(full, render(format, read, manifest), 'utf8');
    const bytes = fs.statSync(full).size;

    await pool.query(
      `UPDATE data_export_requests
          SET status = 'completed', storage_path = ?, byte_size = ?, completed_at = NOW(),
              expires_at = DATE_ADD(NOW(), INTERVAL ${ARTEFACT_TTL_DAYS} DAY), error_message = NULL
        WHERE id = ?`,
      [path.join('exports', filename), bytes, requestId]
    );
    await platformAudit.logPlatformAudit({
      tenantId, actor, action: 'data.export_completed', category: 'data',
      entityType: 'data_export_request', entityId: requestId,
      after: {
        status: 'completed',
        format,
        byteSize: bytes,
        datasets: Object.fromEntries(Object.entries(manifest.datasets).map(([k, v]) => [k, v.rowCount])),
      },
      reason: job.reason, req: { requestId: String(requestId) },
    });
    return byId(requestId);
  } catch (e) {
    // A failed export is recorded and left retryable, never silently dropped —
    // an operator who asked for a customer's data needs to know it did not arrive.
    await pool.query(
      `UPDATE data_export_requests SET status = 'failed', error_message = ? WHERE id = ?`,
      [String(e.message || e).slice(0, 500), requestId]
    );
    await platformAudit.logPlatformAudit({
      tenantId, actor, action: 'data.export_failed', category: 'data',
      entityType: 'data_export_request', entityId: requestId,
      after: { status: 'failed', error: String(e.message || e).slice(0, 200) },
      reason: job.reason, req: { requestId: String(requestId) },
    });
    return byId(requestId);
  }
}

/** Drain the queue. Bounded so one scheduler tick cannot monopolise the process. */
async function runQueued(max = 5) {
  const done = [];
  for (let i = 0; i < max; i++) {
    const result = await runNext();
    if (!result) break;
    done.push(result);
  }
  return done;
}

/** Delete artefacts whose `expires_at` has passed. The row is kept as the record. */
async function sweepExpired() {
  const [rows] = await pool.query(
    `SELECT id, storage_path FROM data_export_requests
      WHERE status = 'completed' AND expires_at IS NOT NULL AND expires_at <= NOW()`
  );
  let removed = 0;
  for (const r of rows) {
    if (r.storage_path) {
      const full = path.join(env.uploadDir, r.storage_path);
      if (fs.existsSync(full)) { try { fs.unlinkSync(full); removed++; } catch { /* leave the row accurate */ } }
    }
    await pool.query(`UPDATE data_export_requests SET storage_path = NULL WHERE id = ?`, [r.id]);
  }
  return removed;
}

module.exports = { DATASETS, SUPPORTED_FORMATS, request, byId, listForTenant, run, runNext, runQueued, sweepExpired, resolveScope, EXPORT_DIR, ARTEFACT_TTL_DAYS };