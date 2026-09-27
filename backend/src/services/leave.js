const dayjs = require('dayjs');
const { pool } = require('../config/db');
const { monthRange } = require('../utils/helpers');
const { weeklyOffSet, getShiftForEmployee, isHoliday } = require('./attendance');

/** Deterministic accrual: value reproducible from policy + effective dates alone. */
function accruedForYear(type, employee, year) {
  const quota = Number(type.annual_quota || 0);
  const perPeriod = Number(type.accrual_count || 0);
  const joined = employee.joined_on ? dayjs(employee.joined_on) : null;
  const now = dayjs();
  if (type.accrual_method === 'monthly') {
    const start = dayjs(`${year}-01-01`).isBefore(joined) && joined ? joined : dayjs(`${year}-01-01`);
    if (start.year() > year) return 0;
    // complete months elapsed between accrual start and now (cap at year end)
    let elapsed = (now.year() - start.year()) * 12 + (now.month() - start.month());
    const yearEnd = dayjs(`${year}-12-31`).endOf('month');
    if (start.isAfter(yearEnd)) return 0;
    elapsed = Math.max(0, Math.min(elapsed, 12));
    let accrued = perPeriod * elapsed;
    if (quota > 0) accrued = Math.min(accrued, quota);
    return Math.round(accrued * 100) / 100;
  }
  if (type.accrual_method === 'yearly') {
    if (joined && joined.year() > year) return 0;
    if (joined && joined.year() === year) {
      // prorate remaining months of joining year
      const remaining = 12 - joined.month();
      let accrued = perPeriod ? Math.round((quota * remaining) / 12 * 100) / 100 : 0;
      return accrued;
    }
    return quota || perPeriod;
  }
  if (type.accrual_method === 'on_joining') {
    if (joined && joined.year() === year) return perPeriod || quota;
    if (joined && joined.year() < year) return quota || perPeriod;
    return 0;
  }
  return 0;
}

async function ensureBalances(tenantId, employee, year) {
  const [types] = await pool.query('SELECT * FROM leave_types WHERE tenant_id = ? AND active = 1', [tenantId]);
  for (const t of types) {
    await pool.query(
      `INSERT IGNORE INTO leave_balances (tenant_id, employee_id, leave_type_id, year, opening)
       VALUES (?,?,?,?,0)`,
      [tenantId, employee.id, t.id, year]
    );
  }
  return types;
}

async function getBalances(tenantId, employee, year) {
  const types = await ensureBalances(tenantId, employee, year);
  const [usedRows] = await pool.query(
    `SELECT leave_type_id, COALESCE(SUM(days),0) AS used FROM leave_requests
     WHERE tenant_id = ? AND employee_id = ? AND status = 'approved' AND YEAR(start_date) = ?
     GROUP BY leave_type_id`,
    [tenantId, employee.id, year]
  );
  const usedMap = Object.fromEntries(usedRows.map((r) => [r.leave_type_id, Number(r.used)]));
  const [balRows] = await pool.query(
    'SELECT * FROM leave_balances WHERE tenant_id = ? AND employee_id = ? AND year = ?',
    [tenantId, employee.id, year]
  );
  const balMap = Object.fromEntries(balRows.map((b) => [b.leave_type_id, b]));

  return types.map((t) => {
    const b = balMap[t.id] || {};
    const accrued = accruedForYear(t, employee, year);
    const opening = Number(b.opening || 0);
    const carry = Number(b.carry_forwarded || 0);
    const lapsed = Number(b.lapsed || 0);
    const encashed = Number(b.encashed || 0);
    const used = usedMap[t.id] || 0;
    const available = Math.round((opening + accrued + carry - used - lapsed - encashed) * 100) / 100;
    return {
      leaveTypeId: t.id, code: t.code, name: t.name, unit: t.unit, paid: !!t.is_paid,
      opening, accrued, used, carryForwarded: carry, lapsed, encashed,
      available: t.negative_balance_allowed ? available : Math.max(0, available),
    };
  });
}

/** Walk the calendar between two dates and classify each day. */
async function dayBreakdown({ tenantId, employee, startDate, endDate }) {
  const shift = await getShiftForEmployee(tenantId, employee.id, startDate);
  const offs = weeklyOffSet(shift);
  const out = [];
  let d = dayjs(startDate);
  const end = dayjs(endDate);
  while (d.isBefore(end) || d.isSame(end, 'day')) {
    const date = d.format('YYYY-MM-DD');
    const holiday = await isHoliday(tenantId, date, employee.location_id);
    const weekday = d.day();
    if (holiday) out.push({ date, value: 0, kind: 'holiday', name: holiday.name });
    else if (offs.has(weekday)) out.push({ date, value: 0, kind: 'week_off' });
    else out.push({ date, value: 1, kind: 'working' });
    d = d.add(1, 'day');
  }
  return out;
}

/** Validate + price a leave request (does not insert). Returns {days, breakdown} or throws. */
async function priceLeaveRequest({ tenantId, employee, type, startDate, endDate, dayPart = 'full' }) {
  if (type.applicable_gender !== 'all' && employee.gender && type.applicable_gender !== employee.gender) {
    throw Object.assign(new Error(`${type.name} is not applicable`), { status: 400 });
  }
  const breakdown = await dayBreakdown({ tenantId, employee, startDate, endDate });
  let days = breakdown.reduce((s, b) => s + b.value, 0);

  if (type.sandwich_rule === 'include_holidays') {
    // holidays/week-offs sandwiched between working leave days count as full days
    const firstWork = breakdown.findIndex((b) => b.kind === 'working');
    const lastWork = breakdown.map((b) => b.kind === 'working').lastIndexOf(true);
    if (firstWork !== -1 && lastWork > firstWork) {
      for (let i = firstWork; i <= lastWork; i++) {
        if (breakdown[i].kind !== 'working') { breakdown[i].value = 1; breakdown[i].sandwiched = true; }
      }
      days = breakdown.reduce((s, b) => s + b.value, 0);
    }
  }

  if (dayjs(endDate).diff(dayjs(startDate), 'day') === 0 && dayPart !== 'full') {
    breakdown[0].value = 0.5;
    breakdown[0].kind = 'working';
    days = 0.5;
  }

  if (days <= 0) throw Object.assign(new Error('Selected range has no working days'), { status: 400 });
  if (type.max_consecutive_days > 0 && days > type.max_consecutive_days) {
    throw Object.assign(new Error(`Maximum ${type.max_consecutive_days} consecutive days allowed for ${type.name}`), { status: 400 });
  }
  if (type.min_notice_days > 0 && employee.joined_on) {
    const notice = dayjs(startDate).diff(dayjs(), 'day');
    if (notice < type.min_notice_days) {
      throw Object.assign(new Error(`${type.name} requires ${type.min_notice_days} days notice`), { status: 400 });
    }
  }
  return { days: Math.round(days * 100) / 100, breakdown };
}

/** After approval: mark attendance rows as leave for the covered dates. */
async function markLeaveAttendance(tenantId, employee, request, type) {
  for (const day of request.day_breakdown || []) {
    if (day.value <= 0) continue;
    const status = day.value >= 1 ? 'on_leave' : 'half_day';
    const [existing] = await pool.query(
      'SELECT id FROM attendance_records WHERE tenant_id = ? AND employee_id = ? AND adate = ?',
      [tenantId, employee.id, day.date]
    );
    if (existing[0]) {
      await pool.query('UPDATE attendance_records SET status = ?, notes = CONCAT(IFNULL(notes,""), " leave") WHERE id = ?', [status, existing[0].id]);
    } else {
      await pool.query(
        `INSERT INTO attendance_records (tenant_id, employee_id, adate, status, source, notes)
         VALUES (?,?,?,?, 'system', ?)`,
        [tenantId, employee.id, day.date, status, `${type.name} (leave #${request.id})`]
      );
    }
  }
}

async function revertLeaveAttendance(tenantId, employeeId, breakdown) {
  for (const day of breakdown || []) {
    if (day.value <= 0) continue;
    await pool.query(
      `DELETE FROM attendance_records WHERE tenant_id = ? AND employee_id = ? AND adate = ? AND source = 'system'`,
      [tenantId, employeeId, day.date]
    );
  }
}

module.exports = { accruedForYear, ensureBalances, getBalances, dayBreakdown, priceLeaveRequest, markLeaveAttendance, revertLeaveAttendance };
