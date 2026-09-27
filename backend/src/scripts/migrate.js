const fs = require('fs');
const path = require('path');
const { pool } = require('../config/db');

async function migrate() {
  const schemaPath = path.join(__dirname, '..', '..', 'db', 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');
  const statements = sql.split(/;\s*\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('--') === false ? true : s.length > 0);
  let applied = 0;
  for (const stmt of statements) {
    const clean = stmt.replace(/^--.*$/gm, '').trim();
    if (!clean || clean === 'SET FOREIGN_KEY_CHECKS = 0' || clean === 'SET FOREIGN_KEY_CHECKS = 1') continue;
    try {
      await pool.query(clean);
      applied++;
    } catch (e) {
      if (!/already exists/i.test(e.message)) {
        console.error('Failed statement:', clean.slice(0, 80), '→', e.message);
        throw e;
      }
    }
  }
  console.log(`[migrate] schema applied (${applied} statements)`);
  await pool.end();
}

migrate().catch((e) => { console.error(e); process.exit(1); });
