const { HttpError } = require('../utils/helpers');
const env = require('../config/env');

function notFound(req, res) {
  res.status(404).json({ error: 'NOT_FOUND', message: `Route ${req.method} ${req.path} not found` });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const status = err.status || 500;
  if (status >= 500) console.error('[error]', req.method, req.path, err);
  const body = {
    error: err.code || (status === 500 ? 'INTERNAL_ERROR' : 'REQUEST_ERROR'),
    message: status === 500 && env.nodeEnv === 'production' ? 'Internal server error' : err.message,
  };
  if (err.extra) body.details = err.extra;
  if (err.sqlState) body.dbError = err.sqlMessage;
  res.status(status).json(body);
}

module.exports = { notFound, errorHandler, HttpError };
