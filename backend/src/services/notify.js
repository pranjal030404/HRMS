const nodemailer = require('nodemailer');
const { pool } = require('../config/db');
const { getSetting } = require('./settings');

const EMAIL_TEMPLATES = {
  'leave.submitted': { subject: 'Leave request submitted — {{employeeName}}', body: '{{employeeName}} applied for {{leaveTypeName}} from {{startDate}} to {{endDate}} ({{days}} day(s)).' },
  'leave.actioned': { subject: 'Your leave request was {{status}}', body: 'Your {{leaveTypeName}} request ({{startDate}} to {{endDate}}) was {{status}}. Comment: {{comment}}' },
  'regularization.actioned': { subject: 'Attendance regularization {{status}}', body: 'Your attendance regularization for {{date}} was {{status}}.' },
  'expense.actioned': { subject: 'Expense claim {{status}}', body: 'Your expense claim "{{title}}" (₹{{amount}}) was {{status}}.' },
  'payslip.published': { subject: 'Payslip for {{period}} published', body: 'Your payslip for {{period}} is now available in the HRMS portal. Net pay: ₹{{netPay}}.' },
  'ticket.created': { subject: '[Ticket {{ticketNo}}] {{subject}}', body: 'A new {{category}} ticket was raised: {{subject}}.' },
  'ticket.updated': { subject: '[Ticket {{ticketNo}}] {{status}}', body: 'Your ticket "{{subject}}" is now {{status}}.' },
  'onboarding.assigned': { subject: 'Onboarding task: {{title}}', body: 'Task "{{title}}" is assigned to you, due {{dueDate}}.' },
  'announcement.published': { subject: 'Announcement: {{title}}', body: '{{body}}' },
  'separation.approved': { subject: 'Resignation approved — LWD {{lastWorkingDay}}', body: 'Your resignation has been approved. Your last working day is {{lastWorkingDay}}.' },
  'password.security': { subject: 'Your HRMS password was changed', body: 'Your account password was changed. If this was not you, contact support immediately.' },
  'account.welcome': { subject: 'Welcome to {{companyName}} HRMS', body: 'Hello {{name}}, your HRMS account is ready. Login with your email and the temporary password shared by HR.' },
};

function fillTemplate(text, vars = {}) {
  return String(text || '').replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : ''));
}

async function getTransport(tenantId) {
  const cfg = await getSetting(tenantId, 'notifications', {});
  if (!cfg.smtpHost || !cfg.smtpUser) return { transport: null, cfg };
  const transport = nodemailer.createTransport({
    host: cfg.smtpHost,
    port: Number(cfg.smtpPort || 587),
    secure: Number(cfg.smtpPort) === 465,
    auth: cfg.smtpPass ? { user: cfg.smtpUser, pass: cfg.smtpPass } : undefined,
  });
  return { transport, cfg };
}

/**
 * Fire a notification event: in-app row(s) + best-effort email + delivery log.
 * userIds: array of user ids. recipients: [{userId, email}] preferred when emailing.
 */
async function notifyEvent({ tenantId, eventKey, vars = {}, recipients = [], link = null }) {
  const tpl = EMAIL_TEMPLATES[eventKey] || { subject: vars.title || eventKey, body: vars.body || '' };
  const title = fillTemplate(vars.title || tpl.subject, vars);
  const body = fillTemplate(tpl.body, vars);
  const results = [];

  // In-app notifications (always) — recipients may be email-only (userId: null)
  const inAppRecipients = recipients.filter((r) => r.userId);
  if (inAppRecipients.length) {
    const values = inAppRecipients.map((r) => [tenantId ?? null, r.userId, eventKey, title, body, link]);
    await pool.query(
      'INSERT INTO notifications (tenant_id, user_id, ntype, title, body, link) VALUES ?',
      [values]
    );
    results.push({ channel: 'inapp', status: 'sent', count: inAppRecipients.length });
  }

  // Email (best effort — skipped when SMTP not configured)
  const { transport, cfg } = await getTransport(tenantId);
  const emailRecipients = recipients.filter((r) => r.email);
  if (!transport) {
    if (emailRecipients.length) {
      await pool.query(
        'INSERT INTO delivery_logs (tenant_id, event_key, channel, recipient, subject, status, error) VALUES ?',
        [emailRecipients.map((r) => [tenantId ?? null, eventKey, 'email', r.email, title, 'skipped', 'SMTP not configured'])]
      );
      results.push({ channel: 'email', status: 'skipped' });
    }
    return results;
  }
  for (const r of emailRecipients) {
    try {
      await transport.sendMail({
        from: `"${cfg.fromName || 'HRMS'}" <${cfg.fromEmail || cfg.smtpUser}>`,
        to: r.email,
        subject: title,
        text: body,
      });
      await pool.query(
        'INSERT INTO delivery_logs (tenant_id, event_key, channel, recipient, subject, status) VALUES (?,?,?,?,?,?)',
        [tenantId ?? null, eventKey, 'email', r.email, title, 'sent']
      );
      results.push({ channel: 'email', status: 'sent', to: r.email });
    } catch (e) {
      await pool.query(
        'INSERT INTO delivery_logs (tenant_id, event_key, channel, recipient, subject, status, error) VALUES (?,?,?,?,?,?,?)',
        [tenantId ?? null, eventKey, 'email', r.email, title, 'failed', e.message.slice(0, 490)]
      );
      results.push({ channel: 'email', status: 'failed', to: r.email, error: e.message });
    }
  }
  return results;
}

module.exports = { notifyEvent, EMAIL_TEMPLATES, fillTemplate };
