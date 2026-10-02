/**
 * The account behind the `/admin` console entrance.
 *
 * Shared by `migrate.js` (so an existing installation gains the console login
 * without a destructive re-seed) and `seed.js` (so a fresh database gets it too).
 *
 * Why a *tenant-bound* platform super admin rather than another plain super admin:
 * `super@arthvex.com` has `tenant_id = NULL`, which is right for pure cross-tenant
 * work but leaves every HR page empty — those pages scope their data with
 * `req.user.tenant_id`. Binding an administrator to a company gives:
 *
 *   • unrestricted reach — `requirePermission` and `requireModuleEnabled` both
 *     short-circuit for `platform_super_admin`, so modules the company has switched
 *     off (Travel, Workforce, AI, Integrations) still answer for this account;
 *   • real data to click through, because every page resolves the tenant from the
 *     session;
 *   • the cross-tenant console — `tenantId(req)` still honours an explicit
 *     `?tenant_id=` for platform admins, and `platform.*` keys come from ROLE_DEFS.
 *
 * It is deliberately not linked to an `employee` row: an administrator is not on the
 * payroll, and the self-service portal is covered by the demo employee account.
 */
const bcrypt = require('bcryptjs');

const ADMIN_EMAIL = process.env.ADMIN_SEED_EMAIL || 'admin@arthvex.com';
const ADMIN_PASSWORD = process.env.ADMIN_SEED_PASSWORD || 'Admin@12345';
const ADMIN_TENANT_SLUG = 'arthvex';

/**
 * Idempotent. Existing rows are left alone: re-running must not silently re-enable an
 * account an administrator deliberately locked, nor overwrite a password they changed.
 * @returns {'created'|'exists'|'no-tenant'}
 */
async function ensureAdminUser(pool) {
  const [tenants] = await pool.query('SELECT id FROM tenants WHERE slug = ? ORDER BY id LIMIT 1', [ADMIN_TENANT_SLUG]);
  const tenant = tenants[0];
  if (!tenant) return 'no-tenant';

  const [existing] = await pool.query('SELECT id FROM users WHERE email = ?', [ADMIN_EMAIL]);
  if (existing.length) return 'exists';

  await pool.query(
    `INSERT INTO users (tenant_id, email, password_hash, name, role, status)
     VALUES (?, ?, ?, 'Arthvex Administrator', 'platform_super_admin', 'active')`,
    [tenant.id, ADMIN_EMAIL, await bcrypt.hash(ADMIN_PASSWORD, 10)]
  );
  return 'created';
}

module.exports = { ensureAdminUser, ADMIN_EMAIL, ADMIN_PASSWORD };