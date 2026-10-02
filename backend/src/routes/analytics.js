const express = require('express');
const dayjs = require('dayjs');
const { pool } = require('../config/db');
const { asyncH, HttpError } = require('../utils/helpers');
const { authenticate, requirePermission } = require('../middleware/auth');

const r = express.Router();
r.use(authenticate);

const num = (v) => Number(v || 0);

/** Executive dashboard (spec §13): headcount, workforce cost, turnover, hiring, attendance, payroll. */
r.get('/executive', requirePermission('analytics.view'), asyncH(async (req, res) => {
  const T = req.user.tenant_id;
  const [[{ headcount }]] = await pool.query(
    `SELECT COUNT(*) AS headcount FROM employees WHERE tenant_id = ? AND status IN ('active','on_probation')`, [T]);
  const [[{ workforceCost }]] = await pool.query(
    `SELECT COALESCE(SUM(ctc_annual),0) AS workforceCost FROM employee_salaries es
     JOIN employees e ON e.id = es.employee_id AND e.status IN ('active','on_probation')
     WHERE es.id = (SELECT MAX(id) FROM employee_salaries WHERE employee_id = es.employee_id) AND e.tenant_id = ?`, [T]);
  const [[{ joined12m }]] = await pool.query(
    `SELECT COUNT(*) AS joined12m FROM employees WHERE tenant_id = ? AND joined_on >= DATE_SUB(CURDATE(), INTERVAL 365 DAY)`, [T]);
  const [[{ exited12m }]] = await pool.query(
    `SELECT COUNT(*) AS exited12m FROM employees WHERE tenant_id = ? AND status = 'exited' AND updated_at >= DATE_SUB(NOW(), INTERVAL 365 DAY)`, [T]);
  const [[{ openReq }]] = await pool.query(
    `SELECT COALESCE(SUM(openings),0) AS openReq FROM requisitions WHERE tenant_id = ? AND status = 'open'`, [T]);
  const [[{ presentToday }]] = await pool.query(
    `SELECT COUNT(DISTINCT employee_id) AS presentToday FROM attendance_records WHERE tenant_id = ? AND adate = CURDATE() AND status IN ('present','half_day','late')`, [T]);
  const [[{ payrollCost }]] = await pool.query(
    `SELECT COALESCE(SUM(net_pay),0) AS payrollCost FROM payroll_items WHERE tenant_id = ?`, [T]);
  const turnoverRate = headcount ? Math.round(((exited12m / (headcount + exited12m)) * 100) * 10) / 10 : 0;
  res.json({
    data: {
      headcount, workforceCost, joined12m, exited12m, turnoverRate, openReq, presentToday, payrollCost,
    },
  });
}));

/** HR dashboard: headcount movement, absenteeism, leave, lifecycle, engagement. */
r.get('/hr', requirePermission('analytics.view'), asyncH(async (req, res) => {
  const T = req.user.tenant_id;
  const [headcountByMonth] = await pool.query(
    `SELECT DATE_FORMAT(joined_on, '%Y-%m') AS ym, COUNT(*) AS joined FROM employees
     WHERE tenant_id = ? AND joined_on >= DATE_SUB(CURDATE(), INTERVAL 12 MONTH) GROUP BY ym ORDER BY ym`, [T]);
  const [[{ absentRate }]] = await pool.query(
    `SELECT ROUND(100 * SUM(status = 'absent') / NULLIF(COUNT(*),0), 1) AS absentRate FROM attendance_records
     WHERE tenant_id = ? AND adate >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)`, [T]);
  const [[{ onLeaveToday }]] = await pool.query(
    `SELECT COUNT(*) AS onLeaveToday FROM leave_requests WHERE tenant_id = ? AND status = 'approved' AND CURDATE() BETWEEN start_date AND end_date`, [T]);
  const [[{ pendingLeaves }]] = await pool.query(
    `SELECT COUNT(*) AS pendingLeaves FROM leave_requests WHERE tenant_id = ? AND status = 'pending'`, [T]);
  const [[{ avgTenureMonths }]] = await pool.query(
    `SELECT ROUND(AVG(TIMESTAMPDIFF(MONTH, joined_on, CURDATE())),1) AS avgTenureMonths FROM employees WHERE tenant_id = ? AND status IN ('active','on_probation')`, [T]);
  const [[{ recognitions30d }]] = await pool.query(
    `SELECT COUNT(*) AS recognitions30d FROM recognitions WHERE tenant_id = ? AND created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)`, [T]);
  res.json({ data: { headcountByMonth, absentRate, onLeaveToday, pendingLeaves, avgTenureMonths, recognitions30d } });
}));

/** Recruitment dashboard. */
r.get('/recruitment', requirePermission('analytics.view'), asyncH(async (req, res) => {
  const T = req.user.tenant_id;
  const [[{ openRoles }]] = await pool.query(`SELECT COUNT(*) AS openRoles FROM requisitions WHERE tenant_id = ? AND status = 'open'`, [T]);
  const [byStage] = await pool.query(`SELECT stage, COUNT(*) AS n FROM candidates WHERE tenant_id = ? GROUP BY stage`, [T]);
  const [bySource] = await pool.query(`SELECT COALESCE(source,'unknown') AS source, COUNT(*) AS n FROM candidates WHERE tenant_id = ? GROUP BY source ORDER BY n DESC`, [T]);
  const [[{ hired90d }]] = await pool.query(
    `SELECT COUNT(*) AS hired90d FROM offers WHERE tenant_id = ? AND status = 'accepted'`, [T]);
  const [[{ avgTTH }]] = await pool.query(
    `SELECT ROUND(AVG(DATEDIFF(a.applied_on, r.created_at)),0) AS avgTTH FROM candidates a
     JOIN requisitions r ON r.id = a.requisition_id
     WHERE a.tenant_id = ? AND a.stage = 'offer'`, [T]);
  const [[{ offersPending }]] = await pool.query(`SELECT COUNT(*) AS offersPending FROM offers WHERE tenant_id = ? AND status = 'sent'`, [T]);
  res.json({ data: { openRoles, byStage, bySource, hired90d, avgTTH, offersPending } });
}));

/** Attendance dashboard. */
r.get('/attendance', requirePermission('analytics.view'), asyncH(async (req, res) => {
  const T = req.user.tenant_id;
  const days = Math.min(90, Number(req.query.days) || 30);
  const [trend] = await pool.query(
    `SELECT adate,
            SUM(status IN ('present','late')) AS present, SUM(status = 'absent') AS absent,
            SUM(status = 'half_day') AS half_day, ROUND(AVG(late_minutes),0) AS avg_late,
            ROUND(SUM(overtime_minutes)/60,1) AS ot_hours
     FROM attendance_records WHERE tenant_id = ? AND adate >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
     GROUP BY adate ORDER BY adate`, [T, days]);
  const [[{ pendingReg }]] = await pool.query(
    `SELECT COUNT(*) AS pendingReg FROM attendance_regularizations WHERE tenant_id = ? AND status = 'pending'`, [T]);
  res.json({ data: { trend, pendingReg } });
}));

/** Payroll dashboard. */
r.get('/payroll', requirePermission('analytics.view'), asyncH(async (req, res) => {
  const T = req.user.tenant_id;
  const [byMonth] = await pool.query(
    `SELECT CONCAT(pr.period_year, '-', LPAD(pr.period_month,2,'0')) AS period,
            SUM(pi.gross) AS gross, SUM(pi.total_deductions) AS deductions, SUM(pi.net_pay) AS net,
            SUM(pi.employer_cost) AS employer_cost, COUNT(*) AS headcount
     FROM payroll_items pi JOIN payroll_runs pr ON pr.id = pi.run_id
     WHERE pi.tenant_id = ? GROUP BY period ORDER BY period DESC LIMIT 12`, [T]);
  // statutory totals are inside the JSON component columns — aggregate in app code
  const [items] = await pool.query(
    `SELECT deductions, employer_contrib FROM payroll_items WHERE tenant_id = ?`, [T]);
  const statutoryTotals = { pf: 0, esi: 0, pt: 0, tds: 0 };
  const parse = (v) => { try { return typeof v === 'string' ? JSON.parse(v) : (v || []); } catch { return []; } };
  for (const it of items) {
    for (const c of [...parse(it.deductions), ...parse(it.employer_contrib)]) {
      const code = String(c.code || '').toUpperCase();
      if (code.startsWith('PF')) statutoryTotals.pf += Number(c.amount || 0);
      else if (code.startsWith('ESI')) statutoryTotals.esi += Number(c.amount || 0);
      else if (code === 'PT') statutoryTotals.pt += Number(c.amount || 0);
      else if (code === 'TDS') statutoryTotals.tds += Number(c.amount || 0);
    }
  }
  res.json({ data: { byMonth, statutoryTotals } });
}));

/** Performance dashboard. */
r.get('/performance', requirePermission('analytics.view'), asyncH(async (req, res) => {
  const T = req.user.tenant_id;
  const [[{ activeGoals }]] = await pool.query(`SELECT COUNT(*) AS activeGoals FROM goals WHERE tenant_id = ? AND status = 'active'`, [T]);
  const [[{ avgProgress }]] = await pool.query(`SELECT ROUND(AVG(progress),0) AS avgProgress FROM goals WHERE tenant_id = ? AND status = 'active'`, [T]);
  const [reviewsByStatus] = await pool.query(`SELECT status, COUNT(*) AS n FROM reviews WHERE tenant_id = ? GROUP BY status`, [T]);
  const [[{ finalRated }]] = await pool.query(`SELECT COUNT(*) AS finalRated FROM reviews WHERE tenant_id = ? AND final_rating IS NOT NULL`, [T]);
  const [ratingDist] = await pool.query(`SELECT ROUND(final_rating,1) AS rating, COUNT(*) AS n FROM reviews WHERE tenant_id = ? AND final_rating IS NOT NULL GROUP BY rating ORDER BY rating`, [T]);
  res.json({ data: { activeGoals, avgProgress, reviewsByStatus, finalRated, ratingDist } });
}));

/** Compensation dashboard. */
r.get('/compensation', requirePermission('compensation.view'), asyncH(async (req, res) => {
  const T = req.user.tenant_id;
  const [byGrade] = await pool.query(
    `SELECT g.name AS grade, COUNT(*) AS employees, ROUND(AVG(es.ctc_annual)/100000,1) AS avg_lpa
     FROM employees e JOIN grades g ON g.id = e.grade_id
     JOIN employee_salaries es ON es.employee_id = e.id AND es.id = (SELECT MAX(id) FROM employee_salaries WHERE employee_id = e.id)
     WHERE e.tenant_id = ? AND e.status IN ('active','on_probation') GROUP BY g.name ORDER BY g.level`, [T]);
  const [[{ revisions12m }]] = await pool.query(
    `SELECT COUNT(*) AS revisions12m FROM employee_salaries WHERE tenant_id = ? AND effective_from >= DATE_SUB(CURDATE(), INTERVAL 365 DAY)`, [T]);
  const [[{ bonusBudget }]] = await pool.query(`SELECT COALESCE(SUM(budget),0) AS bonusBudget FROM bonus_plans WHERE tenant_id = ? AND status IN ('active','draft')`, [T]);
  res.json({ data: { byGrade, revisions12m, bonusBudget } });
}));

/** Compliance dashboard: expiring documents, statutory outputs, unresolved controls, audit events. */
r.get('/compliance', requirePermission('analytics.view'), asyncH(async (req, res) => {
  const T = req.user.tenant_id;
  const [[{ expiringDocs }]] = await pool.query(
    `SELECT COUNT(*) AS expiringDocs FROM employee_documents WHERE tenant_id = ? AND expires_on BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 60 DAY)`, [T]);
  const [[{ expiringCerts }]] = await pool.query(
    `SELECT COUNT(*) AS expiringCerts FROM certifications WHERE tenant_id = ? AND expires_on BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 90 DAY)`, [T]);
  const [[{ openCases }]] = await pool.query(`SELECT COUNT(*) AS openCases FROM hr_cases WHERE tenant_id = ? AND status IN ('open','investigating')`, [T]);
  const [[{ unverifiedDocs }]] = await pool.query(`SELECT COUNT(*) AS unverifiedDocs FROM employee_documents WHERE tenant_id = ? AND verification_status = 'pending'`, [T]);
  const [recentAudit] = await pool.query(
    `SELECT action, entity_type, actor_name, created_at FROM audit_logs WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 10`, [T]);
  res.json({ data: { expiringDocs, expiringCerts, openCases, unverifiedDocs, recentAudit } });
}));

/** Workforce planning dashboard. */
r.get('/workforce', requirePermission('workforce.view'), asyncH(async (req, res) => {
  const T = req.user.tenant_id;
  const year = req.query.year || dayjs().year();
  const [[{ planned }]] = await pool.query(`SELECT COALESCE(SUM(planned_count),0) AS planned FROM headcount_plans WHERE tenant_id = ? AND plan_year = ?`, [T, year]);
  const [[{ actual }]] = await pool.query(`SELECT COUNT(*) AS actual FROM employees WHERE tenant_id = ? AND status IN ('active','on_probation')`, [T]);
  const [[{ plannedCost }]] = await pool.query(`SELECT COALESCE(SUM(budget_ctc),0) AS plannedCost FROM headcount_plans WHERE tenant_id = ? AND plan_year = ?`, [T, year]);
  res.json({ data: { year: Number(year), planned, actual, vacancies: Math.max(0, planned - actual), plannedCost } });
}));

module.exports = r;
