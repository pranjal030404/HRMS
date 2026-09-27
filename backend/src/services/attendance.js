const dayjs = require('dayjs');
const { pool } = require('../config/db');

const DAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function weeklyOffSet(shift) {
  const offs = Array.isArray(shift?.weekly_offs) ? shift.weekly_offs : JSON.parse(shift?.weekly_offs || '[]');
  return new Set(offs.map((d) => DAY_INDEX[d]).filter((n) => n !== undefined));
}

async function getShiftForEmployee(tenantId, employeeId, date) {
  const [rows] = await pool.query(
    `SELECT s.* FROM employee_shifts es JOIN shifts s ON s.id = es.shift_id
     WHERE es.tenant_id = ? AND es.employee_id = ? AND es.effective_from <= ?
       AND (es.effective_to IS NULL OR es.effective_to >= ?)
     ORDER BY es.effective_from DESC LIMIT 1`,
    [tenantId, employeeId, date, date]
  );
  if (rows[0]) return rows[0];
  const [emp] = await pool.query(
    `SELECT s.* FROM employees e JOIN shifts s ON s.id = e.shift_id WHERE e.tenant_id = ? AND e.id = ?`,
    [tenantId, employeeId]
  );
  if (emp[0]) return emp[0];
  const [def] = await pool.query('SELECT * FROM shifts WHERE tenant_id = ? ORDER BY id LIMIT 1', [tenantId]);
  return def[0] || null;
}

async function isHoliday(tenantId, date, locationId = null) {
  const [rows] = await pool.query(
    'SELECT name FROM holidays WHERE tenant_id = ? AND hdate = ? AND (location_id IS NULL OR location_id = ?) LIMIT 1',
    [tenantId, date, locationId]
  );
  return rows[0] || null;
}

/** Resolve the effective status of one day for an employee. */
async function resolveDay({ tenantId, employee, date, record = null }) {
  const d = dayjs(date);
  const shift = await getShiftForEmployee(tenantId, employee.id, date);
  const offs = weeklyOffSet(shift);
  const weekday = d.day();
  const holiday = await isHoliday(tenantId, date, employee.location_id);

  let status = 'not_marked';
  let worked = record?.worked_minutes || 0;

  const [leaveRows] = await pool.query(
    `SELECT lr.days, lr.day_part, lr.status, lt.code FROM leave_requests lr
     JOIN leave_types lt ON lt.id = lr.leave_type_id
     WHERE lr.tenant_id = ? AND lr.employee_id = ? AND lr.status = 'approved'
       AND lr.start_date <= ? AND lr.end_date >= ?`,
    [tenantId, employee.id, date, date]
  );
  const leave = leaveRows[0] || null;

  if (holiday) status = 'holiday';
  else if (offs.has(weekday)) status = 'week_off';

  if (leave) {
    if (leave.days >= 1) status = 'on_leave';
    else status = status === 'not_marked' ? 'half_day' : status;
  }

  if (record && record.punches && record.punches.length) {
    const fullDayH = Number(shift?.full_day_hours || 8);
    const halfDayH = Number(shift?.half_day_hours || 4);
    const lastPunch = record.punches[record.punches.length - 1];
    const openPunch = lastPunch && !lastPunch.out;
    if (worked >= fullDayH * 60) status = 'present';
    else if (worked >= halfDayH * 60) status = worked > 0 && status === 'on_leave' ? 'present' : 'half_day';
    else if (openPunch) status = 'present'; // currently punched in
    else if (status === 'not_marked' || status === 'week_off' || status === 'holiday') status = worked > 0 ? 'half_day' : status;
    else if (status === 'not_marked') status = 'missed_punch';
    if (status === 'not_marked') status = 'missed_punch';
  }

  return {
    date,
    status,
    workedMinutes: worked,
    firstIn: record?.first_in || null,
    lastOut: record?.last_out || null,
    lateMinutes: record?.late_minutes || 0,
    earlyOutMinutes: record?.early_out_minutes || 0,
    overtimeMinutes: record?.overtime_minutes || 0,
    isRegularized: !!record?.is_regularized,
    shiftName: shift?.name || null,
    leaveType: leave?.code || null,
    holidayName: holiday?.name || null,
  };
}

/** Record a punch (in/out auto-detected). Mutates attendance_records. */
async function punch({ tenantId, employee, source = 'web', when = null }) {
  const now = when ? dayjs(when) : dayjs();
  const date = now.format('YYYY-MM-DD');
  const shift = await getShiftForEmployee(tenantId, employee.id, date);

  const [existing] = await pool.query(
    'SELECT * FROM attendance_records WHERE tenant_id = ? AND employee_id = ? AND adate = ?',
    [tenantId, employee.id, date]
  );
  let rec = existing[0];
  const punches = rec?.punches ? (Array.isArray(rec.punches) ? rec.punches : JSON.parse(rec.punches)) : [];
  const lastPunch = punches[punches.length - 1];
  const isOpen = lastPunch && !lastPunch.out;

  punches.push({ in: isOpen ? lastPunch.in : now.toISOString(), out: isOpen ? now.toISOString() : null, source });

  // recompute worked minutes from punch pairs
  let worked = 0;
  for (const p of punches) {
    if (p.in && p.out) worked += Math.max(0, dayjs(p.out).diff(dayjs(p.in), 'minute'));
  }
  const firstInIso = punches[0]?.in || now.toISOString();
  const lastOutIso = punches[punches.length - 1].out || punches[punches.length - 1].in;

  let lateMinutes = 0;
  let earlyOutMinutes = 0;
  if (shift) {
    const start = dayjs(`${date} ${dayjs(shift.start_time, 'HH:mm:ss').format('HH:mm')}`);
    const grace = Number(shift.grace_minutes || 0);
    const actualIn = dayjs(firstInIso);
    if (actualIn.isAfter(start.add(grace, 'minute'))) lateMinutes = actualIn.diff(start, 'minute');
    const end = dayjs(`${date} ${dayjs(shift.end_time, 'HH:mm:ss').format('HH:mm')}`);
    if (shift.cross_midnight && end.isBefore(start)) end.add(1, 'day');
    const actualOut = dayjs(lastOutIso);
    if (punches[punches.length - 1].out && actualOut.isBefore(end.subtract(grace, 'minute'))) {
      earlyOutMinutes = end.diff(actualOut, 'minute');
    }
  }

  const values = {
    punches: JSON.stringify(punches),
    worked_minutes: worked,
    late_minutes: lateMinutes,
    early_out_minutes: earlyOutMinutes,
    first_in: dayjs(firstInIso).format('YYYY-MM-DD HH:mm:ss'),
    last_out: dayjs(lastOutIso).format('YYYY-MM-DD HH:mm:ss'),
    status: worked > 0 ? 'present' : 'not_marked',
    shift_id: shift?.id || null,
    source,
  };

  if (rec) {
    if (rec.is_regularized) { /* keep regularized flag */ }
    await pool.query(
      `UPDATE attendance_records SET punches=?, worked_minutes=?, late_minutes=?, early_out_minutes=?, first_in=?, last_out=?, status=IF(is_regularized=1, status, ?), shift_id=?, source=?
       WHERE id = ?`,
      [values.punches, values.worked_minutes, values.late_minutes, values.early_out_minutes, values.first_in, values.last_out, values.status, values.shift_id, values.source, rec.id]
    );
  } else {
    const [ins] = await pool.query(
      `INSERT INTO attendance_records (tenant_id, employee_id, adate, shift_id, first_in, last_out, punches, worked_minutes, late_minutes, early_out_minutes, status, source)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [tenantId, employee.id, date, values.shift_id, values.first_in, values.last_out, values.punches, values.worked_minutes, values.late_minutes, values.early_out_minutes, values.status, values.source]
    );
    rec = { id: ins.insertId };
  }
  return { recordId: rec.id, status: values.status, lateMinutes, workedMinutes: worked };
}

/** LOP days for an employee in a month: unpaid-leave full days + absents + half-day halves. */
async function lopForMonth(tenantId, employeeId, year, month) {
  const { start, end } = require('../utils/helpers').monthRange(year, month);
  let lop = 0;
  const [unpaid] = await pool.query(
    `SELECT COALESCE(SUM(lr.days),0) AS d FROM leave_requests lr
     JOIN leave_types lt ON lt.id = lr.leave_type_id
     WHERE lr.tenant_id = ? AND lr.employee_id = ? AND lr.status = 'approved' AND lt.is_paid = 0
       AND lr.start_date <= ? AND lr.end_date >= ?`,
    [tenantId, employeeId, end, start]
  );
  lop += Number(unpaid[0].d || 0);
  const [abs] = await pool.query(
    `SELECT status, COUNT(*) AS n FROM attendance_records
     WHERE tenant_id = ? AND employee_id = ? AND adate BETWEEN ? AND ? AND status IN ('absent','half_day')
     GROUP BY status`,
    [tenantId, employeeId, start, end]
  );
  for (const a of abs) lop += a.status === 'absent' ? Number(a.n) : Number(a.n) * 0.5;
  return Math.min(lop, 30);
}

module.exports = { punch, resolveDay, getShiftForEmployee, isHoliday, weeklyOffSet, lopForMonth, DAY_INDEX };
