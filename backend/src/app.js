const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const path = require('path');
const env = require('./config/env');
const { notFound, errorHandler } = require('./middleware/error');

const app = express();
app.set('trust proxy', 1);
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors({ origin: env.corsOrigin.split(','), credentials: true }));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// brute-force protection on auth endpoints
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 50, standardHeaders: true, legacyHeaders: false });

app.get('/health', (req, res) => res.json({ ok: true, service: 'arthvex-hrms', time: new Date().toISOString() }));

app.use('/api/auth', authLimiter, require('./routes/auth'));
app.use('/api/org', require('./routes/org'));
app.use('/api/employees', require('./routes/employees'));
app.use('/api/attendance', require('./routes/attendance'));
app.use('/api/leave', require('./routes/leave'));
app.use('/api/payroll', require('./routes/payroll'));
app.use('/api/expenses', require('./routes/expenses').expenses);
app.use('/api/loans', require('./routes/expenses').loans);
app.use('/api/documents', require('./routes/documents'));
app.use('/api/performance', require('./routes/performance'));
app.use('/api/recruitment', require('./routes/recruitment'));
app.use('/api/assets', require('./routes/assets'));
app.use('/api/tickets', require('./routes/tickets'));
app.use('/api/lifecycle', require('./routes/lifecycle'));
app.use('/api/billing', require('./routes/billing'));
app.use('/api/dashboard', require('./routes/dashboard'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/platform', require('./routes/platform'));
app.use('/api/files', require('./routes/files'));

app.use(notFound);
app.use(errorHandler);

module.exports = app;
