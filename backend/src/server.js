const app = require('./app');
const env = require('./config/env');
const { pool } = require('./config/db');

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
}

// A failed query in one request must never take the API down. Log it loudly and
// keep serving; the request that triggered it already returned an error.
process.on('unhandledRejection', (err) => console.error('[process] unhandled rejection:', err?.stack || err));
process.on('uncaughtException', (err) => console.error('[process] uncaught exception:', err?.stack || err));

start();
