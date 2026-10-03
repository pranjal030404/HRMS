/**
 * Run the lifecycle sweep once and exit.
 *
 *   node src/scripts/lifecycle-sweep.js
 *   node src/scripts/lifecycle-sweep.js --json
 *
 * The API server runs the same sweep on a timer; this entry point exists so the
 * job can also be driven by cron/systemd in a deployment where the API is scaled
 * horizontally and a per-process interval would run the job once per replica.
 */
const { pool } = require('../config/db');
const lifecycle = require('../services/lifecycle');

async function main() {
  const asJson = process.argv.includes('--json');
  const report = await lifecycle.sweep({ reason: 'Lifecycle sweep (scheduled job)' });
  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`[lifecycle] sweep at ${report.ranAt}`);
    for (const [label, key] of [
      ['trials expired', 'trialsExpired'],
      ['subscriptions escalated', 'escalated'],
      ['subscriptions renewed', 'renewed'],
      ['support sessions expired', 'supportSessionsExpired'],
      ['deletions scheduled', 'deletionCancellations'],
      ['tenants purged', 'deletionsPurged'],
    ]) {
      console.log(`  ${label.padEnd(28)} ${report[key].length}`);
    }
    for (const e of report.errors) console.error(`  ! ${e.step}: ${e.message}`);
  }
  await pool.end();
  process.exit(report.errors.length ? 1 : 0);
}

main().catch(async (e) => {
  console.error('[lifecycle] sweep failed:', e?.stack || e);
  await pool.end().catch(() => {});
  process.exit(1);
});