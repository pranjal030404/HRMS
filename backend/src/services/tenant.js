/**
 * Tenant service (spec §18) — the provisioning wizard's backend.
 *
 * Step 9 of the wizard is the only place a customer company comes into being, so
 * it is deliberately transactional: tenant row, roles, legal entities, plan +
 * entitlements, module configuration, first owner, branding, subscription and
 * status history either all exist or none do. A half-provisioned tenant is worse
 * than a failed one — every screen inside it would 403 with no obvious cause.
 */
const { pool, withTransaction } = require('../config/db');
const { HttpError } = require('../utils/helpers');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const rbac = require('./rbac');
const subscriptions = require('./subscriptions');
const entitlements = require('./entitlements');
const usage = require('./usage');
const { logPlatformAudit } = require('./platformAudit');
const { MODULE_CATALOG, moduleDependencies, LEGACY_PLAN_ALIASES } = require('../utils/permissions');

const slugify = (v) => String(v || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/**
 * @param {object} input the collected wizard payload
 * @param {object} ctx   { actor, req }
 */
async function provision(input = {}, { actor, req } = {}) {
  const step1 = input.tenant || input;
  const name = String(step1.legalName || step1.name || '').trim();
  if (!name) throw new HttpError(400, 'Step 1 — a legal name is required');
  const slug = slugify(step1.slug || name);
  if (!slug) throw new HttpError(400, 'Step 1 — a tenant slug could not be derived from that name');

  const planKey = LEGACY_PLAN_ALIASES[input.planKey || step1.plan] || input.planKey || step1.plan || 'trial';
  const [[plan]] = await pool.query('SELECT * FROM platform_plans WHERE plan_key = ?', [planKey]);
  if (!plan) throw new HttpError(400, `Step 3 — unknown plan "${planKey}"`);

  const firstOwner = input.owner || {};
  const ownerEmail = String(firstOwner.email || input.adminEmail || '').toLowerCase().trim();
  if (!ownerEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(ownerEmail)) {
    throw new HttpError(400, 'Step 6 — a valid first company owner email is required');
  }
  const [existingUser] = await pool.query('SELECT id FROM users WHERE email = ?', [ownerEmail]);
  if (existingUser[0]) throw new HttpError(409, 'That email is already in use by another account');

  const [dupe] = await pool.query('SELECT id FROM tenants WHERE slug = ?', [slug]);
  if (dupe[0]) throw new HttpError(409, `The slug "${slug}" is already taken`);

  // Step 4 — module selection, validated against the dependency graph (spec §16)
  // *before* anything is written, so an invalid combination fails at review time
  // rather than half way through the transaction.
  const requested = Array.isArray(input.modules) && input.modules.length
    ? input.modules
    : (plan.module_keys ? plan.module_keys.slice() : MODULE_CATALOG.filter((m) => m.defaultEnabled).map((m) => m.key));
  const unknownModules = requested.filter((k) => !MODULE_CATALOG.some((m) => m.key === k));
  if (unknownModules.length) throw new HttpError(400, `Step 4 — unknown module(s): ${unknownModules.join(', ')}`);
  const dependencyErrors = checkDependencies(requested);
  if (dependencyErrors.length) {
    throw new HttpError(400, 'Step 4 — the selected modules have unmet dependencies', { dependencies: dependencyErrors });
  }

  const tempPassword = `Av@${crypto.randomBytes(4).toString('hex')}`;
  let tenantId;

  await withTransaction(async (conn) => {
    const [ins] = await conn.query(
      `INSERT INTO tenants (name, display_name, slug, plan, status, industry, country, timezone, currency,
         contact_email, contact_phone, branding, feature_flags, employee_limit, onboarded_at)
       VALUES (?,?,?,?, 'provisioning', ?,?,?,?,?,?,?,?,?, NOW())`,
      [name, step1.displayName || null, slug, plan.plan_key, step1.industry || null, step1.country || 'IN',
        step1.timezone || 'Asia/Kolkata', step1.currency || 'INR',
        step1.contactEmail || ownerEmail, step1.contactPhone || null,
        JSON.stringify(buildBranding(input, name)), '{}', plan.employee_limit]
    );
    tenantId = ins.insertId;

    await rbac.provisionTenantRoles(tenantId);

    // Step 2 — legal entities. A tenant is NOT a legal entity (spec §6); the first
    // one is created from the wizard's company profile so Indian statutory
    // configuration has somewhere to live.
    const entity = (input.legalEntities && input.legalEntities[0]) || step1;
    await conn.query(
      `INSERT INTO legal_entities (tenant_id, name, code, is_primary, status, address_line1, city, state, state_code, pincode)
       VALUES (?,?,?,1,'active',?,?,?,?,?)`,
      [tenantId, entity.name || name, slug.toUpperCase().slice(0, 10),
        entity.addressLine1 || null, entity.city || null, entity.state || null,
        entity.stateCode || null, entity.pincode || null]
    ).catch(async () => {
      // A pre-control-plane schema may not carry every column; the company row is
      // the fallback so the tenant is still usable.
      await conn.query(
        `INSERT INTO companies (tenant_id, legal_name, trade_name, cin, pan, tan, gstin, address_line1, city, state, state_code, pincode, contact_email, contact_phone)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [tenantId, entity.legalName || name, entity.name || name, entity.cin || null, entity.pan || null,
          entity.tan || null, entity.gstin || null, entity.addressLine1 || null, entity.city || null,
          entity.state || null, entity.stateCode || null, entity.pincode || null,
          step1.contactEmail || ownerEmail, step1.contactPhone || null]
      );
    });

    // Step 3 — subscription (trial or active) drives tenant lifecycle state.
    await conn.query(
      `INSERT INTO subscriptions (tenant_id, plan_id, plan_key, status, billing_cycle, quantity, price_per_period,
          trial_ends_at, current_period_start, current_period_end, created_by)
       VALUES (?,?,?,?,?,?,?,?, NOW(), DATE_ADD(NOW(), INTERVAL 1 MONTH), ?)`,
      [tenantId, plan.id, plan.plan_key, plan.trial_days > 0 ? 'trialing' : 'active',
        input.billingCycle || 'monthly', Number(input.quantity || 0), plan.price_monthly,
        plan.trial_days > 0 ? new Date(Date.now() + plan.trial_days * 86400000) : null, actor?.id ?? null]
    );

    // Step 4 — materialise the chosen modules. Every catalog row is written so the
    // state is explicit rather than inferred from defaults.
    for (const m of MODULE_CATALOG) {
      const on = requested.includes(m.key);
      await conn.query(
        `INSERT INTO module_configurations (tenant_id, module_key, name, category, enabled, settings, updated_by)
         VALUES (?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE enabled = VALUES(enabled)`,
        [tenantId, m.key, m.name, m.category, on ? 1 : 0, '{}', actor?.id ?? null]
      );
    }

    // Step 5 — bespoke entitlements for this tenant (a "Custom" plan in practice).
    const overrides = input.entitlements || {};
    if (overrides && typeof overrides === 'object' && Object.keys(overrides).length) {
      const [ents] = await conn.query('SELECT id, entitlement_key FROM entitlements WHERE entitlement_key IN (?)', [Object.keys(overrides)]);
      for (const e of ents) {
        await conn.query(
          `INSERT INTO tenant_entitlement_overrides (tenant_id, entitlement_id, value, reason, status, approved_by, approved_at, created_by)
           VALUES (?,?,?,?, 'active', ?, NOW(), ?)`,
          [tenantId, e.id, String(overrides[e.entitlement_key]), input.overrideReason || 'Set during provisioning',
            actor?.id ?? null, actor?.id ?? null]
        );
      }
    }

    // Step 6 — the first company owner.
    await conn.query(
      `INSERT INTO users (tenant_id, email, password_hash, name, role, status, must_change_password)
       VALUES (?,?,?,?, 'company_owner','active',1)`,
      [tenantId, ownerEmail, await bcrypt.hash(tempPassword, 10), firstOwner.name || input.adminName || name]
    );

    // Step 7 — branding is written above; a verified primary domain is recorded so
    // the white-label login has something to resolve.
    if (input.domain) {
      await conn.query(
        'INSERT INTO tenant_domains (tenant_id, hostname, is_primary, verified, created_by) VALUES (?,?,1,0,?)',
        [tenantId, String(input.domain).toLowerCase().trim(), actor?.id ?? null]
      ).catch(() => {});
    }
  });

  rbac.invalidateTenant(tenantId);
  entitlements.invalidateTenant(tenantId);
  await usage.recompute(tenantId, { source: 'provision', actorUserId: actor?.id, requestId: req?.requestId });

  await subscriptions.setTenantStatus(tenantId, plan.trial_days > 0 ? 'trial' : 'active', { actor, reason: 'Provisioning', req });
  await logPlatformAudit({
    tenantId, actor, action: 'tenant.provisioned', category: 'tenant',
    entityType: 'tenant', entityId: tenantId,
    after: { name, slug, plan: plan.plan_key, modules: requested, ownerEmail },
    reason: input.reason || 'Provisioning wizard', req,
  });

  return {
    id: tenantId, tenantId, slug, planKey: plan.plan_key, modules: requested,
    ownerEmail, tempPassword,
  };
}

/** Missing prerequisites for the requested module set. */
function checkDependencies(requested) {
  const want = new Set(requested);
  const errors = [];
  for (const key of want) {
    for (const dep of moduleDependencies(key)) {
      if (!want.has(dep)) {
        errors.push({
          module: key,
          moduleName: (MODULE_CATALOG.find((m) => m.key === key) || {}).name || key,
          requires: dep,
          requiresName: (MODULE_CATALOG.find((m) => m.key === dep) || {}).name || dep,
        });
      }
    }
  }
  return errors;
}

function buildBranding(input, name) {
  const branding = input.branding || {};
  return {
    companyName: branding.companyName || (input.tenant && input.tenant.displayName) || name,
    logoUrl: branding.logoUrl || null,
    primaryColor: branding.primaryColor || '#1d4ed8',
    loginTagline: branding.loginTagline || null,
    supportEmail: branding.supportEmail || null,
    emailFromName: branding.emailFromName || null,
  };
}

async function get(tenantId) {
  const [rows] = await pool.query(
    `SELECT t.*, p.name AS plan_name, p.price_monthly FROM tenants t
     LEFT JOIN platform_plans p ON p.plan_key = t.plan WHERE t.id = ?`, [tenantId]
  );
  const tenant = rows[0];
  if (!tenant) return null;
  const [[sub]] = await pool.query(
    `SELECT * FROM subscriptions WHERE tenant_id = ? ORDER BY id DESC LIMIT 1`, [tenantId]
  );
  const [[counts]] = await pool.query(
    `SELECT (SELECT COUNT(*) FROM employees WHERE tenant_id = t.id AND deleted_at IS NULL) AS employees,
            (SELECT COUNT(*) FROM users WHERE tenant_id = t.id AND status = 'active') AS active_users,
            (SELECT COUNT(*) FROM legal_entities WHERE tenant_id = t.id) AS legal_entities,
            (SELECT MAX(last_login_at) FROM users WHERE tenant_id = t.id) AS last_activity
     FROM tenants t WHERE t.id = ?`, [tenantId]
  );
  return { ...tenant, branding: parse(tenant.branding), subscription: sub || null, counts };
}

const parse = (v) => {
  if (v == null) return null;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return v; }
};

module.exports = { provision, get, checkDependencies, slugify };