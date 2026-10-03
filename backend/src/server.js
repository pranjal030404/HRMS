const app = require('./app');
const env = require('./config/env');
const { pool } = require('./config/db');
const lifecycle = require('./services/lifecycle');

async function start() {
  try {
    await pool.query('SELECT 1');
    console.log(`[db] connected to ${env.db.host}:${env.db.port}/${env.db.database}`);
  } catch (e) {
    console.error('[db] connection failed:', e.message);
    console.error('      Check backend/.env and make sure MySQL/MariaDB is running.');
    process.exit(1);
  }
  app.listen(env.port, () => console.log(`[server] Arthvex HRMS API listening on http://localhost:${env.port}`));

  // The lifecycle clock (spec §26, §27). Trials end and overdue subscriptions
  // escalate whether or not an operator is looking at the console. Skippable via
  // LIFECYCLE_SWEEPER=off for a read-only replica or a one-off task worker.
  if (String(env.lifecycleSweeper ?? 'on').toLowerCase() !== 'off') {
    lifecycle.startScheduler();
    console.log('[lifecycle] scheduler started');
  }
}

// A failed query in one request must never take the API down. Log it loudly and
// keep serving; the request that triggered it already returned an error.
process.on('unhandledRejection', (err) => console.error('[process] unhandled rejection:', err?.stack || err));
process.on('uncaughtException', (err) => console.error('[process] uncaught exception:', err?.stack || err));

start();
