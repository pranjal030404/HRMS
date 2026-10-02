const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const path = require('path');
const env = require('./config/env');
const { notFound, errorHandler } = require('./middleware/error');
const { requestContext, requireModuleEnabled } = require('./middleware/auth');

const app = express();
app.set('trust proxy', 1);
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors({ origin: env.corsOrigin.split(','), credentials: true }));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
// Correlate every request (and every admin audit entry) with a request id.
app.use(requestContext);

// brute-force protection on auth endpoints
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 50, standardHeaders: true, legacyHeaders: false });

app.get('/health', (req, res) => res.json({ ok: true, service: 'arthvex-hrms', time: new Date().toISOString() }));

app.use('/api/auth', authLimiter, require('./routes/auth'));
// Core shell: master data, the home dashboard and the platform surface are always
// available. Everything below is gated on the tenant module it belongs to, so a
// module switched off in the Administration Center stops answering here — not
// merely in the navigation.
app.use('/api/org', require('./routes/org'));
app.use('/api/dashboard', require('./routes/dashboard'));
app.use('/api/employees', requireModuleEnabled('employees'), require('./routes/employees'));
app.use('/api/attendance', requireModuleEnabled('attendance'), require('./routes/attendance'));
app.use('/api/leave', requireModuleEnabled('leave'), require('./routes/leave'));
app.use('/api/payroll', requireModuleEnabled('payroll'), require('./routes/payroll'));
app.use('/api/expenses', requireModuleEnabled('expenses'), require('./routes/expenses').expenses);
app.use('/api/loans', requireModuleEnabled('loans'), require('./routes/expenses').loans);
app.use('/api/documents', requireModuleEnabled('documents'), require('./routes/documents'));
app.use('/api/performance', requireModuleEnabled('performance'), require('./routes/performance'));
app.use('/api/recruitment', requireModuleEnabled('recruitment'), require('./routes/recruitment'));
app.use('/api/assets', requireModuleEnabled('assets'), require('./routes/assets'));
app.use('/api/tickets', requireModuleEnabled('helpdesk'), require('./routes/tickets'));
app.use('/api/lifecycle', requireModuleEnabled('lifecycle'), require('./routes/lifecycle'));
app.use('/api/billing', requireModuleEnabled('billing'), require('./routes/billing'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/platform', require('./routes/platform'));
app.use('/api/administration', require('./routes/administration'));
app.use('/api/files', require('./routes/files'));
// v2 modules
app.use('/api/talent', requireModuleEnabled('talent'), require('./routes/talent'));
app.use('/api/engagement', requireModuleEnabled('engagement'), require('./routes/engagement'));
app.use('/api/relations', requireModuleEnabled('employee_relations'), require('./routes/relations'));
app.use('/api/travel', requireModuleEnabled('travel'), require('./routes/travel'));
app.use('/api/compensation', requireModuleEnabled('compensation'), require('./routes/compensation'));
app.use('/api/benefits', requireModuleEnabled('benefits'), require('./routes/benefits'));
app.use('/api/workforce', requireModuleEnabled('workforce_planning'), require('./routes/workforce'));
app.use('/api/analytics', requireModuleEnabled('analytics'), require('./routes/analytics'));
app.use('/api/timesheets', requireModuleEnabled('timesheets'), require('./routes/timesheets'));
app.use('/api/workflows', requireModuleEnabled('workflow'), require('./routes/workflow'));
app.use('/api/notifications-center', requireModuleEnabled('notifications'), require('./routes/notifications'));
app.use('/api/ai', requireModuleEnabled('ai_assistant'), require('./routes/ai'));
app.use('/api/integrations', requireModuleEnabled('integrations'), require('./routes/integrations').admin);
// Versioned public API (service API keys, LMS sync contract)
app.use('/api/v1', require('./routes/integrations').publicV1);

app.use(notFound);
app.use(errorHandler);

module.exports = app;
