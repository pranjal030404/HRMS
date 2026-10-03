/**
 * AI HR Assistant (spec §5 / §21): natural-language read/query assistance,
 * draft generation and anomaly detection — strictly permission-scoped,
 * human-in-the-loop: every answer cites its scope; nothing mutates data.
 */
const express = require('express');
const { pool } = require('../config/db');
const { asyncH, HttpError } = require('../utils/helpers');
const { authenticate } = require('../middleware/auth');
const { allowedScopes } = require('../utils/permissions');

/**
 * Every answer here is a COMPANY-wide aggregate or list, so it needs company-wide reach.
 * `hasPerm` was used before, which is true for `leave.view:own` or `employee.view:team`,
 * letting an ordinary employee ask for everyone on leave today and a manager for the
 * whole company's headcount. Scoped holders get a refusal that says what they would need.
 */
const companyWide = (user, perm) => user.role === 'platform_super_admin'
  || allowedScopes(user.permissions || [], perm).some((sc) => ['company', 'tenant', 'platform'].includes(sc));
const hasPerm = (perms, perm) => companyWide({ permissions: perms }, perm);

const r = express.Router();
r.use(authenticate);

const SUGGESTIONS = [
  'How many employees do we have?',
  'Who is on leave today?',
  'What is the payroll cost last month?',
  'Show attendance summary for last 30 days',
  'Show the hiring funnel',
  'Which documents are expiring soon?',
  'Who are our critical positions without ready successors?',
  'Draft an offer summary for a candidate',
];

// ---- Chat: intent → scoped SQL ----
r.post('/ask', asyncH(async (req, res) => {
  const T = req.user.tenant_id;
  if (T == null) throw new HttpError(403, 'The assistant answers questions about one company; sign in as a company user.');
  const q = String(req.body?.question || '').trim();
  if (!q) throw new HttpError(400, 'question required');

  // Metered entitlement (spec §13, §14). The AI assistant is a per-plan capability,
  // so both the boolean grant and the monthly question allowance are checked here
  // rather than at the UI. A tenant that never bought AI gets a 402 that names the
  // entitlement; a tenant that has exhausted its allowance gets the same with the
  // reset guidance.
  const limits = require('../services/limits');
  await limits.assertWithinLimit({
    tenantId: T, entitlementKey: 'ai.requests.month', incoming: 1, action: 'ai.ask', req,
  });

  const ql = q.toLowerCase();

  const can = (p) => hasPerm(req.user.permissions || [], p);
  let answer = null, intent = 'unknown', link = null;

  if (/how many employees|headcount|total employees|team size/.test(ql)) {
    if (!can('employee.view')) { intent = 'blocked'; answer = 'You need employee view permission for this.'; }
    else {
      const [[{ active }]] = await pool.query(`SELECT COUNT(*) AS active FROM employees WHERE tenant_id = ? AND status IN ('active','on_probation')`, [T]);
      const [byDept] = await pool.query(
        `SELECT d.name AS department, COUNT(*) AS n FROM employees e JOIN departments d ON d.id = e.department_id
         WHERE e.tenant_id = ? AND e.status IN ('active','on_probation') GROUP BY d.name ORDER BY n DESC`, [T]);
      intent = 'headcount';
      answer = `There are **${active}** active employees.\n\nBy department:\n${byDept.map((x) => `- ${x.department}: ${x.n}`).join('\n')}`;
    }
  } else if (/on leave|leave today|absent today/.test(ql)) {
    if (!can('leave.view')) { intent = 'blocked'; answer = 'You need leave view permission for this.'; }
    else {
      const [rows] = await pool.query(
        `SELECT CONCAT(e.first_name, ' ', e.last_name) AS name, d.name AS department, lr.leave_type_id, lr.end_date
         FROM leave_requests lr JOIN employees e ON e.id = lr.employee_id
         LEFT JOIN departments d ON d.id = e.department_id
         WHERE lr.tenant_id = ? AND lr.status = 'approved' AND CURDATE() BETWEEN lr.start_date AND lr.end_date`, [T]);
      intent = 'leave_today';
      answer = rows.length
        ? `On approved leave today (${rows.length}):\n${rows.map((x) => `- ${x.name}${x.department ? ` (${x.department})` : ''} — back ${String(x.end_date).slice(0, 10)}`).join('\n')}`
        : 'Nobody is on approved leave today.';
    }
  } else if (/payroll cost|payroll total|salary cost|gross|net pay/.test(ql)) {
    if (!can('payroll.view')) { intent = 'blocked'; answer = 'You need payroll view permission for this.'; }
    else {
      const [rows] = await pool.query(
        `SELECT CONCAT(pr.period_year,'-',LPAD(pr.period_month,2,'0')) AS period, SUM(pi.gross) AS gross, SUM(pi.net_pay) AS net, SUM(pi.employer_cost) AS employer
         FROM payroll_items pi JOIN payroll_runs pr ON pr.id = pi.run_id
         WHERE pi.tenant_id = ? GROUP BY period ORDER BY period DESC LIMIT 3`, [T]);
      intent = 'payroll_cost';
      answer = rows.length
        ? rows.map((x) => `**${x.period}**: gross ₹${Number(x.gross).toLocaleString('en-IN')}, net ₹${Number(x.net).toLocaleString('en-IN')}, employer cost ₹${Number(x.employer).toLocaleString('en-IN')}`).join('\n')
        : 'No payroll runs have been processed yet.';
    }
  } else if (/attendance|late|absent/.test(ql)) {
    if (!can('attendance.view')) { intent = 'blocked'; answer = 'You need attendance view permission for this.'; }
    else {
      const [rows] = await pool.query(
        `SELECT COUNT(*) AS total, SUM(status IN ('present','late')) AS present, SUM(status='absent') AS absent,
                SUM(status='half_day') AS half, ROUND(AVG(late_minutes),0) AS avg_late
         FROM attendance_records WHERE tenant_id = ? AND adate >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)`, [T]);
      const s = rows[0];
      const rate = s.total ? Math.round((s.present / s.total) * 1000) / 10 : 0;
      intent = 'attendance';
      answer = `Last 30 days: **${rate}%** attendance rate (${s.present} present, ${s.absent} absent, ${s.half} half-days; average late ${s.avg_late || 0} min).`;
    }
  } else if (/hiring|funnel|candidates|recruit/.test(ql)) {
    if (!can('recruitment.view')) { intent = 'blocked'; answer = 'You need recruitment view permission for this.'; }
    else {
      const [rows] = await pool.query(`SELECT stage, COUNT(*) AS n FROM candidates WHERE tenant_id = ? GROUP BY stage`, [T]);
      const [[{ openRoles }]] = await pool.query(`SELECT COUNT(*) AS openRoles FROM requisitions WHERE tenant_id = ? AND status='open'`, [T]);
      intent = 'hiring';
      answer = `Open roles: **${openRoles}**.\nPipeline: ${rows.map((x) => `${x.stage}: ${x.n}`).join(', ') || 'empty'}`;
    }
  } else if (/documents? expiring|expiring|expiry/.test(ql)) {
    if (!can('document.view')) { intent = 'blocked'; answer = 'You need document view permission for this.'; }
    else {
      const [rows] = await pool.query(
        `SELECT ed.name AS doc_name, CONCAT(e.first_name,' ',e.last_name) AS employee, ed.expires_on
         FROM employee_documents ed JOIN employees e ON e.id = ed.employee_id
         WHERE ed.tenant_id = ? AND ed.expires_on BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 60 DAY)
         ORDER BY ed.expires_on LIMIT 10`, [T]);
      intent = 'doc_expiry';
      answer = rows.length
        ? `Expiring within 60 days:\n${rows.map((x) => `- ${x.doc_name} — ${x.employee} (${String(x.expires_on).slice(0, 10)})`).join('\n')}`
        : 'No employee documents expire in the next 60 days.';
    }
  } else if (/succession|critical position|successor/.test(ql)) {
    if (!can('talent.view')) { intent = 'blocked'; answer = 'You need talent view permission for this.'; }
    else {
      const [rows] = await pool.query(
        `SELECT position_title, criticality, readiness, CONCAT(e.first_name,' ',e.last_name) AS incumbent
         FROM succession_plans sp LEFT JOIN employees e ON e.id = sp.employee_id
         WHERE sp.tenant_id = ? AND sp.criticality IN ('high','critical') AND (sp.readiness IS NULL OR sp.readiness != 'ready_now')`, [T]);
      intent = 'succession';
      answer = rows.length
        ? `Critical/high positions without a ready-now successor:\n${rows.map((x) => `- **${x.position_title}** (incumbent: ${x.incumbent || '—'}, readiness: ${x.readiness || 'none'})`).join('\n')}`
        : 'All critical positions have ready-now successors.';
    }
  } else if (/draft|offer|letter/.test(ql)) {
    intent = 'draft';
    answer = [
      '**Draft — Offer summary** (template, edit before sending):',
      '',
      'Dear {{candidateName}},',
      '',
      `We are pleased to offer you the position of {{designation}} at {{companyName}}, based at {{location}}.`,
      `Your annual compensation will be ₹{{ctc}} (CTC), with a joining date of {{joiningDate}}.`,
      'Kindly confirm your acceptance within 7 working days.',
      '',
      'Regards,\nHR — {{companyName}}',
    ].join('\n');
    link = '/recruitment';
  } else {
    intent = 'unknown';
    answer = `I can help with scoped questions like:\n${SUGGESTIONS.map((s) => `- ${s}`).join('\n')}\n\n(I read data you already have permission to see — I never change it.)`;
  }

  const status = intent === 'blocked' ? 'blocked' : 'answered';
  const [ins] = await pool.query(
    `INSERT INTO ai_conversations (tenant_id, user_id, question, answer, intent, data_scope, status) VALUES (?,?,?,?,?,?,?)`,
    [T, req.user.id, q, answer || '', intent, req.user.role, status]
  );
  // Charged per question asked, answered or blocked: a permission-refused answer
  // still consumed the tenant's allowance, and a meter that only counts successes
  // would quietly under-report real consumption.
  await require('../services/usage').increment(T, 'ai.requests.month', 1, {
    source: 'ai_ask', referenceType: 'ai_conversation', referenceId: ins.insertId,
    actorUserId: req.user?.id, requestId: req.requestId, metadata: { intent, status },
  }).catch((e) => console.error('[usage] AI metering failed:', e.message));
  res.json({ data: { id: ins.insertId, intent, answer, link } });
}));

r.get('/history', asyncH(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT id, question, answer, intent, status, created_at FROM ai_conversations
     WHERE tenant_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT 30`,
    [req.user.tenant_id, req.user.id]
  );
  res.json({ data: rows });
}));

r.get('/suggestions', (req, res) => res.json({ data: SUGGESTIONS }));

/** Anomaly detection (read-only): late spikes, payroll variance, approval backlog. */
r.get('/anomalies', asyncH(async (req, res) => {
  const T = req.user.tenant_id;
  const out = [];
  if (hasPerm(req.user.permissions || [], 'attendance.view')) {
    const [rows] = await pool.query(
      `SELECT adate, ROUND(AVG(late_minutes),0) AS avg_late FROM attendance_records
       WHERE tenant_id = ? AND adate >= DATE_SUB(CURDATE(), INTERVAL 30 DAY) GROUP BY adate ORDER BY adate`, [T]);
    const avg = rows.reduce((a, x) => a + Number(x.avg_late || 0), 0) / Math.max(1, rows.length);
    const spikes = rows.filter((x) => Number(x.avg_late || 0) > avg * 2 && Number(x.avg_late) > 10);
    if (spikes.length) out.push({ type: 'attendance', severity: 'medium', message: `Late-arrival spike on ${spikes.length} day(s) (30-day avg ${Math.round(avg)} min)`, dates: spikes.map((s) => s.adate).slice(0, 5) });
  }
  if (hasPerm(req.user.permissions || [], 'payroll.view')) {
    const [rows] = await pool.query(
      `SELECT CONCAT(pr.period_year,'-',LPAD(pr.period_month,2,'0')) AS period, SUM(pi.gross) AS gross
       FROM payroll_items pi JOIN payroll_runs pr ON pr.id = pi.run_id
       WHERE pi.tenant_id = ? GROUP BY period ORDER BY period DESC LIMIT 6`, [T]);
    if (rows.length >= 2) {
      const latest = Number(rows[0].gross), prev = Number(rows[1].gross);
      if (prev > 0 && Math.abs(latest - prev) / prev > 0.15) {
        out.push({ type: 'payroll', severity: 'high', message: `Payroll gross changed ${Math.round(((latest - prev) / prev) * 100)}% between ${rows[1].period} and ${rows[0].period}` });
      }
    }
  }
  if (hasPerm(req.user.permissions || [], 'leave.view')) {
    const [[{ pending }]] = await pool.query(`SELECT COUNT(*) AS pending FROM leave_requests WHERE tenant_id = ? AND status = 'pending' AND start_date < CURDATE()`, [T]);
    if (pending > 0) out.push({ type: 'approvals', severity: 'medium', message: `${pending} leave request(s) pending past their start date` });
  }
  res.json({ data: out });
}));

module.exports = r;
