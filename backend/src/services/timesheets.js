const dayjs = require('dayjs');
const { pool, withTransaction } = require('../config/db');
const { HttpError, round2 } = require('../utils/helpers');
const { getSetting } = require('./settings');
const { logAudit } = require('./audit');

const HARD_MAX_DAY_HOURS = 24; // physical ceiling; cannot be configured away
const DEFAULT_TIMESHEET_SETTINGS = {
  maxDailyHours: 12,
  maxWeeklyHours: 60,
  requireProject: false,
  warnOnWeeklyOff: true,
  allowFutureEntries: false,
};

const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Monday of the week containing `d` (dayjs startOf('week') is Sunday-based). */
function mondayOf(d) {
  const dt = dayjs(d);
  const dow = dt.day();
  return dt.subtract(dow === 0 ? 6 : dow - 1, 'day').format('YYYY-MM-DD');
}

/** Monday..Sunday window for a given week_start. */
function weekRange(weekStart) {
  const start = mondayOf(weekStart);
  return { start, end: dayjs(start).add(6, 'day').format('YYYY-MM-DD') };
}

function weekDays(weekStart) {
  const { start } = weekRange(weekStart);
  return Array.from({ length: 7 }, (_, i) => dayjs(start).add(i, 'day').format('YYYY-MM-DD'));
}

/**
 * Dates the employee is not expected to work (shift weekly-offs + location holidays),
 * used to raise warnings rather than block entries.
 */
async function nonWorkingDays(tenantId, employeeId, weekStart) {
  const { start, end } = weekRange(weekStart);
  const [emp] = await pool.query(
    `SELECT e.location_id, s.weekly_offs FROM employees e
     LEFT JOIN shifts s ON s.id = e.shift_id
     WHERE e.tenant_id = ? AND e.id = ?`,
    [tenantId, employeeId]
  );
  const map = new Map();
  if (!emp[0]) return map;

  let offs = [];
  if (emp[0].weekly_offs) {
    offs = typeof emp[0].weekly_offs === 'string' ? JSON.parse(emp[0].weekly_offs || '[]') : emp[0].weekly_offs;
  }
  for (const d of weekDays(weekStart)) {
    const label = DAY_SHORT[dayjs(d).day()];
    if (offs.map((x) => String(x).slice(0, 3)).includes(label)) map.set(d, `weekly off (${label})`);
  }

  if (emp[0].location_id) {
    const [hol] = await pool.query(
      `SELECT hdate, name FROM holidays
       WHERE tenant_id = ? AND hdate BETWEEN ? AND ?
         AND (location_id = ? OR location_id IS NULL)`,
      [tenantId, start, end, emp[0].location_id]
    );
    for (const h of hol) {
      const d = dayjs(h.hdate).format('YYYY-MM-DD');
      if (!map.has(d)) map.set(d, `holiday: ${h.name}`);
    }
  }
  return map;
}

/** Totals + split for a set of entry rows. */
function computeTotals(entries) {
  let total = 0;
  let billable = 0;
  for (const e of entries) {
    const h = Number(e.hours || 0);
    total += h;
    if (Number(e.billable)) billable += h;
  }
  return {
    totalHours: round2(total),
    billableHours: round2(billable),
    nonBillableHours: round2(total - billable),
  };
}

/**
 * Clean, validate and normalise raw weekly entries.
 * Returns { entries, totals, issues } — `issues` are surfaced to the UI so the employee can
 * see exactly why something was rejected or nudged, rather than silently losing time.
 */
async function validateEntries(tenantId, employeeId, weekStart, raw) {
  const settings = { ...DEFAULT_TIMESHEET_SETTINGS, ...(await getSetting(tenantId, 'timesheets', {})) };
  const { start, end } = weekRange(weekStart);
  const today = dayjs().format('YYYY-MM-DD');
  const nonWorking = await nonWorkingDays(tenantId, employeeId, start);

  const [projRows] = await pool.query(
    `SELECT p.id, p.name, p.code, p.billable, p.status, p.bill_rate,
            pm.employee_id IS NOT NULL AS is_member
     FROM projects p
     LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.employee_id = ? AND pm.active = 1
     WHERE p.tenant_id = ?`,
    [employeeId, tenantId]
  );
  const projects = new Map(projRows.map((p) => [String(p.id), p]));

  const issues = [];
  const entries = [];
  const perDay = new Map();

  for (const [i, r] of (Array.isArray(raw) ? raw : []).entries()) {
    if (!r || typeof r !== 'object') continue;
    const date = String(r.date || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      issues.push({ severity: 'error', row: i, code: 'INVALID_DATE', message: `Row ${i + 1}: invalid or missing date` });
      continue;
    }
    if (date < start || date > end) {
      issues.push({ severity: 'error', row: i, code: 'OUTSIDE_WEEK', message: `${date} is outside the week ${start} → ${end}` });
      continue;
    }
    if (!settings.allowFutureEntries && date > today) {
      issues.push({ severity: 'error', row: i, code: 'FUTURE_DATE', message: `${date} is in the future` });
      continue;
    }

    const hours = round2(Number(r.hours));
    if (!(hours > 0)) {
      issues.push({ severity: 'error', row: i, code: 'INVALID_HOURS', message: `${date}: hours must be greater than 0` });
      continue;
    }
    if (hours > HARD_MAX_DAY_HOURS) {
      issues.push({ severity: 'error', row: i, code: 'DAILY_HARD_LIMIT', message: `${date}: ${hours}h exceeds the 24h daily ceiling` });
      continue;
    }

    const projectId = r.project_id ? Number(r.project_id) : null;
    let billable = r.billable ? 1 : 0;
    if (projectId) {
      const p = projects.get(String(projectId));
      if (!p) {
        issues.push({ severity: 'error', row: i, code: 'UNKNOWN_PROJECT', message: `${date}: project not found` });
        continue;
      }
      if (p.status !== 'active') {
        issues.push({ severity: 'error', row: i, code: 'INACTIVE_PROJECT', message: `${date}: project "${p.name}" is inactive` });
        continue;
      }
      if (!p.billable && billable) {
        billable = 0;
        issues.push({ severity: 'warning', row: i, code: 'NOT_BILLABLE_PROJECT', message: `${date}: "${p.name}" is non-billable — cleared the billable flag` });
      }
      if (!Number(p.is_member)) {
        issues.push({ severity: 'warning', row: i, code: 'NOT_PROJECT_MEMBER', message: `${date}: you are not listed on project "${p.name}"` });
      }
    } else {
      if (settings.requireProject) {
        issues.push({ severity: 'error', row: i, code: 'PROJECT_REQUIRED', message: `${date}: a project is required for every entry` });
        continue;
      }
      if (billable) {
        billable = 0;
        issues.push({ severity: 'warning', row: i, code: 'BILLABLE_WITHOUT_PROJECT', message: `${date}: billable time needs a billable project — cleared the billable flag` });
      }
    }

    if (nonWorking.has(date)) {
      issues.push({
        severity: settings.warnOnWeeklyOff ? 'warning' : 'error',
        row: i, code: 'NON_WORKING_DAY',
        message: `${date} looks like a ${nonWorking.get(date)} — please confirm`,
      });
      if (!settings.warnOnWeeklyOff) continue;
    }

    perDay.set(date, (perDay.get(date) || 0) + hours);
    entries.push({
      entryDate: date,
      projectId,
      hours,
      task: String(r.task || '').slice(0, 255),
      billable,
      source: r.source || 'manual',
    });
  }

  // Daily ceiling (configurable, on top of the hard 24h cap enforced above)
  for (const [date, hrs] of perDay) {
    const cap = Number(settings.maxDailyHours) || DEFAULT_TIMESHEET_SETTINGS.maxDailyHours;
    if (hrs > cap) {
      issues.push({ severity: 'error', row: null, code: 'DAILY_LIMIT', date, message: `${date}: ${hrs}h logged exceeds the ${cap}h daily limit` });
    }
  }

  const totals = computeTotals(entries);
  const weekCap = Number(settings.maxWeeklyHours) || DEFAULT_TIMESHEET_SETTINGS.maxWeeklyHours;
  if (totals.totalHours > weekCap) {
    issues.push({ severity: 'error', row: null, code: 'WEEKLY_LIMIT', message: `Week total ${totals.totalHours}h exceeds the ${weekCap}h weekly limit` });
  }

  entries.sort((a, b) => (a.entryDate === b.entryDate ? (a.projectId || 0) - (b.projectId || 0) : a.entryDate < b.entryDate ? -1 : 1));
  return { entries, totals, issues, settings };
}

const errorsOf = (issues) => issues.filter((i) => i.severity === 'error');

/** Load a weekly sheet with its normalised entries and derived totals. */
async function getWeekly(tenantId, employeeId, weekStart) {
  const start = mondayOf(weekStart);
  const { end } = weekRange(start);
  const [rows] = await pool.query(
    'SELECT * FROM timesheets WHERE tenant_id = ? AND employee_id = ? AND week_start = ?',
    [tenantId, employeeId, start]
  );
  const sheet = rows[0];
  if (!sheet) {
    return {
      id: null, employeeId, weekStart: start, weekEnd: end, status: 'draft', locked: 0,
      entries: [], totalHours: 0, billableHours: 0, nonBillableHours: 0, issues: [],
    };
  }
  const [entries] = await pool.query(
    `SELECT te.id, te.entry_date, te.project_id, te.hours, te.task, te.billable, te.source,
            p.name AS project_name, p.code AS project_code, p.bill_rate
     FROM timesheet_entries te
     LEFT JOIN projects p ON p.id = te.project_id
     WHERE te.tenant_id = ? AND te.timesheet_id = ?
     ORDER BY te.entry_date, p.name`,
    [tenantId, sheet.id]
  );
  return {
    id: sheet.id,
    employeeId: sheet.employee_id,
    weekStart: sheet.week_start,
    weekEnd: end,
    status: sheet.status,
    locked: Number(sheet.locked || 0),
    approverId: sheet.approver_id,
    approverComment: sheet.approver_comment,
    submittedAt: sheet.submitted_at,
    actionedAt: sheet.actioned_at,
    totalHours: Number(sheet.total_hours || 0),
    billableHours: Number(sheet.billable_hours || 0),
    nonBillableHours: Number(sheet.non_billable_hours || 0),
    entries: entries.map((e) => ({
      id: e.id,
      date: dayjs(e.entry_date).format('YYYY-MM-DD'),
      projectId: e.project_id,
      projectName: e.project_name,
      projectCode: e.project_code,
      hours: Number(e.hours),
      task: e.task,
      billable: Number(e.billable || 0),
      billRate: e.bill_rate === null ? null : Number(e.bill_rate),
      source: e.source,
    })),
  };
}

/**
 * Persist a weekly sheet and replace its entries atomically.
 * Only draft/rejected sheets may be edited, and never once the period is locked.
 */
async function saveWeekly(tenantId, employeeId, weekStart, rawEntries, actor, { source = 'manual' } = {}) {
  const start = mondayOf(weekStart);
  const { entries, totals, issues, settings } = await validateEntries(tenantId, employeeId, start, rawEntries);
  const errs = errorsOf(issues);
  if (errs.length) throw new HttpError(400, 'Timesheet has validation errors', errs);

  const [existing] = await pool.query(
    'SELECT id, status, locked FROM timesheets WHERE tenant_id = ? AND employee_id = ? AND week_start = ?',
    [tenantId, employeeId, start]
  );
  if (existing[0] && Number(existing[0].locked)) throw new HttpError(409, 'This timesheet week is locked and can no longer be edited');
  if (existing[0] && !['draft', 'rejected'].includes(existing[0].status)) {
    throw new HttpError(409, `Timesheet is ${existing[0].status} — withdraw it before editing`);
  }

  await withTransaction(async (conn) => {
    let timesheetId = existing[0]?.id;
    if (timesheetId) {
      await conn.query(
        `UPDATE timesheets SET total_hours = ?, billable_hours = ?, non_billable_hours = ?,
                status = IF(status = 'rejected', 'draft', status), approver_comment = NULL
         WHERE id = ?`,
        [totals.totalHours, totals.billableHours, totals.nonBillableHours, timesheetId]
      );
      await conn.query('DELETE FROM timesheet_entries WHERE timesheet_id = ?', [timesheetId]);
    } else {
      const [ins] = await conn.query(
        `INSERT INTO timesheets (tenant_id, employee_id, week_start, entries, total_hours, billable_hours, non_billable_hours, status)
         VALUES (?,?,?,'[]',?,?,?, 'draft')`,
        [tenantId, employeeId, start, totals.totalHours, totals.billableHours, totals.nonBillableHours]
      );
      timesheetId = ins.insertId;
    }
    for (const e of entries) {
      await conn.query(
        `INSERT INTO timesheet_entries (tenant_id, timesheet_id, employee_id, entry_date, project_id, hours, task, billable, source)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [tenantId, timesheetId, employeeId, e.entryDate, e.projectId, e.hours, e.task || null, e.billable, source]
      );
    }
  });

  await logAudit({
    tenantId, actor, action: 'timesheet.save', entityType: 'timesheet', entityId: existing[0]?.id || null,
    after: { weekStart: start, ...totals }, req: null,
  });

  const saved = await getWeekly(tenantId, employeeId, start);
  return { ...saved, issues, settings };
}

/** draft → submitted. Enforces that the week actually has time on it. */
async function submitWeekly(tenantId, employeeId, weekStart, actor) {
  const start = mondayOf(weekStart);
  const sheet = await getWeekly(tenantId, employeeId, start);
  if (!sheet.id) throw new HttpError(404, 'Save the timesheet before submitting');
  if (sheet.status === 'submitted') throw new HttpError(409, 'Timesheet is already submitted');
  if (sheet.status === 'approved') throw new HttpError(409, 'Timesheet is already approved');
  if (Number(sheet.locked)) throw new HttpError(409, 'This timesheet week is locked');
  if (!(sheet.totalHours > 0)) throw new HttpError(400, 'Cannot submit an empty timesheet');

  await pool.query(
    `UPDATE timesheets SET status = 'submitted', submitted_at = NOW(), submitted_by = ?,
            approver_comment = NULL, approver_id = NULL, actioned_at = NULL
     WHERE id = ?`,
    [actor.id, sheet.id]
  );
  await logAudit({ tenantId, actor, action: 'timesheet.submit', entityType: 'timesheet', entityId: sheet.id, after: { totalHours: sheet.totalHours }, req: null });
  return { id: sheet.id, status: 'submitted', totalHours: sheet.totalHours };
}

/** Approve / reject a submitted sheet (guards and notifications live in the route). */
async function actionTimesheet(tenantId, timesheetId, action, comment, actor) {
  const [rows] = await pool.query('SELECT * FROM timesheets WHERE id = ? AND tenant_id = ?', [timesheetId, tenantId]);
  const sheet = rows[0];
  if (!sheet) throw new HttpError(404, 'Timesheet not found');
  if (Number(sheet.locked)) throw new HttpError(409, 'This timesheet is locked and can no longer be actioned');
  if (sheet.status !== 'submitted') throw new HttpError(409, `Timesheet is ${sheet.status} — only submitted sheets can be actioned`);
  if (sheet.submitted_by && Number(sheet.submitted_by) === Number(actor.id)) {
    throw new HttpError(403, 'Maker-checker: you cannot action a timesheet you submitted yourself');
  }
  await pool.query(
    'UPDATE timesheets SET status = ?, approver_id = ?, approver_comment = ?, actioned_at = NOW() WHERE id = ?',
    [action, actor.id, comment || null, timesheetId]
  );
  await logAudit({
    tenantId, actor, action: `timesheet.${action}`, entityType: 'timesheet', entityId: timesheetId,
    before: { status: sheet.status }, after: { status: action, comment: comment || null }, req: null,
  });
  return { id: timesheetId, status: action };
}

/**
 * Aggregations for the analytics screen.
 * `employeeIds` restricts the result to the caller's employee scope (pass null for company-wide).
 * `groupBy` supports employee | project | department | week.
 */
async function analytics(tenantId, { from, to, employeeId, employeeIds = null, projectId, groupBy = 'employee', includeDraft = false } = {}) {
  const start = from || dayjs().subtract(89, 'day').format('YYYY-MM-DD');
  const end = to || dayjs().format('YYYY-MM-DD');
  const statuses = includeDraft ? "('draft','submitted','approved','rejected')" : "('approved')";

  // Scope restriction shared by every query below.
  let scopeSql = '';
  const scopeParams = [];
  if (employeeId) { scopeSql += ' AND {a}employee_id = ?'; scopeParams.push(employeeId); }
  if (Array.isArray(employeeIds)) {
    if (employeeIds.length) {
      scopeSql += ` AND {a}employee_id IN (${employeeIds.map(() => '?').join(',')})`;
      scopeParams.push(...employeeIds.map(Number));
    } else {
      scopeSql += ' AND 1=0';
    }
  }
  const scopeFor_ = (alias) => scopeSql.replace(/\{a\}/g, `${alias}.`);

  const params = [tenantId, start, end];
  let where = `t.tenant_id = ? AND t.week_start >= ? AND t.week_start <= ? AND t.status IN ${statuses}`;
  if (employeeId) { where += ' AND t.employee_id = ?'; params.push(employeeId); }
  if (Array.isArray(employeeIds)) {
    if (employeeIds.length) { where += ` AND t.employee_id IN (${employeeIds.map(() => '?').join(',')})`; params.push(...employeeIds.map(Number)); }
    else where += ' AND 1=0';
  }
  if (projectId) { where += ' AND EXISTS (SELECT 1 FROM timesheet_entries x WHERE x.timesheet_id = t.id AND x.project_id = ?)'; params.push(projectId); }

  const [rows] = await pool.query(
    `SELECT t.week_start, t.status, t.total_hours, t.billable_hours, t.non_billable_hours,
            t.employee_id, e.employee_code,
            CONCAT(e.first_name, ' ', e.last_name) AS employee_name,
            e.department_id, d.name AS department,
            SUM(te.hours) AS entry_hours,
            SUM(IF(te.billable = 1, te.hours, 0)) AS billable_entry_hours,
            SUM(IF(te.billable = 1, te.hours * IFNULL(p.bill_rate, 0), 0)) AS billable_value,
            SUM(te.hours * IFNULL(p.cost_rate, 0)) AS cost_value
     FROM timesheets t
     JOIN employees e ON e.id = t.employee_id
     LEFT JOIN departments d ON d.id = e.department_id
     LEFT JOIN timesheet_entries te ON te.timesheet_id = t.id
     LEFT JOIN projects p ON p.id = te.project_id
     WHERE ${where}
     GROUP BY t.id, te.project_id, p.name
     ORDER BY t.week_start DESC`,
    params
  );

  // Bucket into the requested grouping.
  const buckets = new Map();
  const ensure = (key, label, extra = {}) => {
    if (!buckets.has(key)) {
      buckets.set(key, {
        key, label, hours: 0, billableHours: 0, nonBillableHours: 0,
        billableValue: 0, costValue: 0, margin: 0, entries: 0, ...extra,
      });
    }
    return buckets.get(key);
  };

  // Per-project rows are folded in separately from the sheet-level totals so we don't
  // double count when an employee logs several projects in a week.
  const projectWhere = scopeFor_('te');
  const [projectRows] = await pool.query(
    `SELECT te.project_id, p.name AS project_name, p.client, p.billable,
            SUM(te.hours) AS hours,
            SUM(IF(te.billable = 1, te.hours, 0)) AS billable_hours,
            SUM(IF(te.billable = 1, te.hours * IFNULL(p.bill_rate, 0), 0)) AS billable_value,
            SUM(te.hours * IFNULL(p.cost_rate, 0)) AS cost_value,
            COUNT(DISTINCT te.employee_id) AS people
     FROM timesheet_entries te
     JOIN timesheets t ON t.id = te.timesheet_id AND t.status IN ${statuses}
     LEFT JOIN projects p ON p.id = te.project_id
     WHERE te.tenant_id = ? AND te.entry_date BETWEEN ? AND ?${projectWhere}
     ${projectId ? 'AND te.project_id = ?' : ''}
     GROUP BY te.project_id, p.name, p.client, p.billable
     ORDER BY hours DESC`,
    [tenantId, start, end, ...scopeParams, ...(projectId ? [projectId] : [])]
  );

  const [sheetTotals] = await pool.query(
    `SELECT COUNT(DISTINCT t.id) AS sheets, COUNT(DISTINCT t.employee_id) AS employees,
            COALESCE(SUM(t.total_hours), 0) AS total_hours,
            COALESCE(SUM(t.billable_hours), 0) AS billable_hours,
            COALESCE(SUM(t.non_billable_hours), 0) AS non_billable_hours
     FROM timesheets t
     WHERE ${where}`,
    params
  );

  const sheetKeyOf = (x) => `${x.employee_id}|${x.week_start}`;

  if (groupBy === 'week') {
    const [w] = await pool.query(
      `SELECT t.week_start AS k, MIN(t.week_start) AS label,
              COALESCE(SUM(t.total_hours),0) AS total_hours,
              COALESCE(SUM(t.billable_hours),0) AS billable_hours,
              COALESCE(SUM(t.non_billable_hours),0) AS non_billable_hours
       FROM timesheets t WHERE ${where} GROUP BY t.week_start ORDER BY t.week_start`,
      params
    );
    for (const x of w) {
      const b = ensure(x.k, x.label, { weekStart: x.label });
      b.hours += Number(x.total_hours || 0);
      b.billableHours += Number(x.billable_hours || 0);
      b.nonBillableHours += Number(x.non_billable_hours || 0);
      b.totalHours = round2(b.hours);
    }
  }

  // Employee and department rollups come from the sheet rows (one row per sheet here).
  const seenSheets = new Set();
  for (const x of rows) {
    const sk = sheetKeyOf(x);
    if (groupBy === 'employee' || groupBy === 'department') {
      const isFirstForSheet = !seenSheets.has(sk);
      seenSheets.add(sk);
      if (!isFirstForSheet) continue; // sheet totals already counted on the first project row
      if (groupBy === 'employee') {
        const b = ensure(`emp_${x.employee_id}`, `${x.employee_name} (${x.employee_code})`, { employeeId: x.employee_id });
        b.hours += Number(x.total_hours || 0);
        b.billableHours += Number(x.billable_hours || 0);
        b.nonBillableHours += Number(x.non_billable_hours || 0);
        b.entries += 1;
      } else {
        const b = ensure(`dept_${x.department_id || 0}`, x.department || 'Unassigned');
        b.hours += Number(x.total_hours || 0);
        b.billableHours += Number(x.billable_hours || 0);
        b.nonBillableHours += Number(x.non_billable_hours || 0);
        b.entries += 1;
      }
    }
  }

  const projects = projectRows.map((p) => ({
    projectId: p.project_id,
    name: p.project_name || 'Internal / no project',
    client: p.client,
    billable: !!Number(p.billable),
    hours: round2(p.hours),
    billableHours: round2(p.billable_hours),
    billableValue: round2(p.billable_value),
    costValue: round2(p.cost_value),
    margin: round2(Number(p.billable_value) - Number(p.cost_value)),
    people: p.people,
  }));

  // Project grouping is served from the same project rollup so `buckets` is never empty.
  if (groupBy === 'project') {
    for (const p of projects) {
      const b = ensure(`proj_${p.projectId || 0}`, p.name, { projectId: p.projectId });
      b.hours += p.hours;
      b.billableHours += p.billableHours;
      b.nonBillableHours += round2(p.hours - p.billableHours);
      b.billableValue += p.billableValue;
      b.costValue += p.costValue;
      b.billablePct = b.hours ? Math.round((b.billableHours / b.hours) * 100) : 0;
      b.margin = round2(b.billableValue - b.costValue);
      b.entries += 1;
    }
  }

  const bucketsArr = [...buckets.values()].map((b) => ({
    ...b,
    hours: round2(b.hours),
    billableHours: round2(b.billableHours),
    nonBillableHours: round2(b.nonBillableHours),
    billableValue: round2(b.billableValue),
    costValue: round2(b.costValue),
    margin: round2(b.margin),
    billablePct: b.hours ? Math.round((b.billableHours / b.hours) * 100) : 0,
  })).sort((a, b) => b.hours - a.hours);

  const totals = {
    sheets: Number(sheetTotals[0].sheets || 0),
    employees: Number(sheetTotals[0].employees || 0),
    totalHours: round2(sheetTotals[0].total_hours),
    billableHours: round2(sheetTotals[0].billable_hours),
    nonBillableHours: round2(sheetTotals[0].non_billable_hours),
    billableValue: round2(projects.reduce((s, p) => s + p.billableValue, 0)),
    costValue: round2(projects.reduce((s, p) => s + p.costValue, 0)),
  };
  totals.billablePct = totals.totalHours ? Math.round((totals.billableHours / totals.totalHours) * 100) : 0;
  totals.margin = round2(totals.billableValue - totals.costValue);

  // Utilisation vs planned allocation.
  const [alloc] = await pool.query(
    `SELECT pm.employee_id, COALESCE(SUM(pm.allocation_pct), 0) AS planned_pct
     FROM project_members pm
     WHERE pm.tenant_id = ? AND pm.active = 1
     GROUP BY pm.employee_id`,
    [tenantId]
  );
  const plannedByEmp = new Map(alloc.map((a) => [a.employee_id, Number(a.planned_pct)]));

  return { range: { from: start, to: end }, groupBy, totals, buckets: bucketsArr, projects, plannedByEmp };
}

/** Lock or unlock a range of weeks so nothing below can be edited afterwards. */
async function setPeriodLock(tenantId, fromWeek, toWeek, locked, actor) {
  const from = mondayOf(fromWeek || dayjs().startOf('month'));
  const to = mondayOf(toWeek || from);
  const [result] = await pool.query(
    `UPDATE timesheets SET locked = ? WHERE tenant_id = ? AND week_start BETWEEN ? AND ?`,
    [locked ? 1 : 0, tenantId, from, to]
  );
  await logAudit({
    tenantId, actor, action: locked ? 'timesheet.lock_period' : 'timesheet.unlock_period',
    entityType: 'timesheet_period', entityId: `${from}..${to}`, after: { sheets: result.affectedRows }, req: null,
  });
  return { from, to, locked: !!locked, sheets: result.affectedRows };
}

/** Recompute denormalised totals for a tenant (used after bulk edits / imports). */
async function recalcTotals(tenantId) {
  await pool.query(
    `UPDATE timesheets t
     SET total_hours = COALESCE((SELECT SUM(te.hours) FROM timesheet_entries te WHERE te.timesheet_id = t.id), 0),
         billable_hours = COALESCE((SELECT SUM(IF(te.billable = 1, te.hours, 0)) FROM timesheet_entries te WHERE te.timesheet_id = t.id), 0),
         non_billable_hours = COALESCE((SELECT SUM(IF(te.billable = 0, te.hours, 0)) FROM timesheet_entries te WHERE te.timesheet_id = t.id), 0)
     WHERE t.tenant_id = ?`,
    [tenantId]
  );
}

module.exports = {
  mondayOf, weekRange, weekDays, nonWorkingDays, computeTotals,
  validateEntries, getWeekly, saveWeekly, submitWeekly, actionTimesheet,
  analytics, setPeriodLock, recalcTotals, errorsOf,
  HARD_MAX_DAY_HOURS, DEFAULT_TIMESHEET_SETTINGS,
};