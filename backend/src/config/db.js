const mysql = require('mysql2/promise');
const env = require('./env');

const pool = mysql.createPool({
  ...env.db,
  charset: 'utf8mb4_general_ci',
  waitForConnections: true,
  queueLimit: 0,
  decimalNumbers: true,
  dateStrings: ['DATE'],
  typeCast: (field, next) => {
    if (field.type === 'TINY' && field.length === 1) return field.string() === '1';
    return next();
  },
});

// Run a set of queries inside a transaction.
async function withTransaction(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    try { await conn.rollback(); } catch (_) { /* noop */ }
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = { pool, withTransaction, query: pool.query.bind(pool) };
