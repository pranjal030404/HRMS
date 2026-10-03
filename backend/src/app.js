const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const path = require('path');
const env = require('./config/env');
const { notFound, errorHandler } = require('./middleware/error');
const { requestContext, requireModuleEnabled, authenticate, requireTenantWritable } = require('./middleware/auth');

const app = express();
app.set('trust proxy', 1);
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors({ origin: env.corsOrigin.split(','), credentials: true }));
// Payment-provider webhooks need the exact bytes that were signed, so this one path is read raw
// BEFORE the JSON parser. It is public by design: the HMAC signature is the authentication.
app.post('/api/billing-webhooks/:provider', express.raw({ type: '*/*', limit: '256kb' }), async (req, res, next) => {
  try {
    const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
    const out = await require('./services/payments').handleWebhook(req.params.provider, raw, req.headers, { requestId: req.requestId });
    res.status(200).json(out);
  } catch (e) { next(e); }
});
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
// Correlate every request (and every admin audit entry) with a request id.
app.use(requestContext);
// One structured line per API request, carrying the correlation, company and actor ids
// so a production problem can be traced. No bodies, headers or tokens are ever logged.
if (process.env.REQUEST_LOG !== 'off' && env.nodeEnv === 'production') {
  app.use('/api', (req, res, next) => {
    const t0 = Date.now();
    res.on('finish', () => {
      console.log(JSON.stringify({
        t: new Date().toISOString(), requestId: req.requestId, method: req.method,
        path: req.baseUrl + (req.route ? req.route.path : ''), status: res.statusCode, ms: Date.now() - t0,
        tenantId: req.user?.tenant_id ?? null, userId: req.user?.id ?? null,
      }));
    });
    next();
  });
}

// brute-force protection on auth endpoints
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 50, standardHeaders: true, legacyHeaders: false });

// Whole-API ceiling per client, on top of the stricter auth limiter. Production only,
// so local development and the test suite are not throttled.
if (env.nodeEnv === 'production') {
  app.use('/api', rateLimit({
    windowMs: 60 * 1000, max: parseInt(process.env.API_RATE_LIMIT || '600', 10),
    standardHeaders: true, legacyHeaders: false,
  }));
}

app.get('/health', (req, res) => res.json({ ok: true, service: 'arthvex-hrms', time: new Date().toISOString() }));

// A suspended / past-due / cancelled company keeps read access to its own history
// but may not change anything. Doing this once, here, means no route can forget it —
// previously only the handful of routes that happened to check a usage limit refused.
// Auth (password, MFA, logout), the control plane and the public API keep their own rules.
// Maintenance windows: tenant users get a 503 with the message and end time; platform
// operators and the health check pass, so the people doing the maintenance are never locked out.
app.use('/api', (req, res, next) => {
  // /v1 authenticates with API keys, not user tokens; its own gate applies the same window.
  if (!req.headers.authorization || /^\/(auth|platform|v1)(\/|$)/.test(req.path)) return next();
  authenticate(req, res, async (err) => {
    if (err) return next(err);
    if (req.user.tenant_id == null) return next();
    try {
      const w = await require('./services/maintenance').blockingFor(req.user.tenant_id);
      if (!w) return next();
      res.setHeader('Retry-After', String(Math.max(60, Math.ceil((new Date(w.ends_at) - Date.now()) / 1000))));
      return res.status(503).json({ error: 'MAINTENANCE', message: w.message, details: { endsAt: w.ends_at } });
    } catch (e) { return next(e); }
  });
});

const tenantWriteGate = requireTenantWritable();
app.use('/api', (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  // /account stays open on purpose: a suspended or past-due company must still be able to raise a
  // support ticket and ask to cancel, otherwise the only way to resolve billing is to be locked out.
  if (/^\/(auth|platform|v1|account)(\/|$)/.test(req.path)) return next();
  if (!req.headers.authorization) return next();
  authenticate(req, res, (err) => {
    if (err) return next(err);
    if (req.user.tenant_id == null) return next();
    return tenantWriteGate(req, res, next);
  });
});

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
app.use('/api/account', require('./routes/account'));
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
