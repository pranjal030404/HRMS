const fs = require('fs');
const path = require('path');
const { pool } = require('../config/db');

/** Highest numeric entitlement value in a plan's grant map (used for the legacy mirror). */
const maxOf = (entitlements, key) => {
  const v = entitlements && entitlements[key];
  return v === undefined || v === null ? 200 : Number(v);
};

// Idempotent column additions for existing tables (works on MySQL 8 and MariaDB).
const COLUMN_ADDITIONS = [
  { table: 'employees', column: 'external_employee_id', ddl: 'ALTER TABLE employees ADD COLUMN external_employee_id VARCHAR(60) NULL AFTER employee_code' },

  // Timesheets: normalised entry rows + split totals + period locking.
  { table: 'projects', column: 'bill_rate', ddl: 'ALTER TABLE projects ADD COLUMN bill_rate DECIMAL(12,2) DEFAULT 0 AFTER billable' },
  { table: 'projects', column: 'cost_rate', ddl: 'ALTER TABLE projects ADD COLUMN cost_rate DECIMAL(12,2) DEFAULT 0 AFTER bill_rate' },
  { table: 'projects', column: 'department_id', ddl: 'ALTER TABLE projects ADD COLUMN department_id BIGINT UNSIGNED NULL AFTER cost_rate' },
  { table: 'projects', column: 'default_project', ddl: 'ALTER TABLE projects ADD COLUMN default_project TINYINT(1) DEFAULT 0 AFTER department_id' },
  { table: 'timesheets', column: 'billable_hours', ddl: 'ALTER TABLE timesheets ADD COLUMN billable_hours DECIMAL(6,2) DEFAULT 0 AFTER total_hours' },
  { table: 'timesheets', column: 'non_billable_hours', ddl: 'ALTER TABLE timesheets ADD COLUMN non_billable_hours DECIMAL(6,2) DEFAULT 0 AFTER billable_hours' },
  { table: 'timesheets', column: 'locked', ddl: 'ALTER TABLE timesheets ADD COLUMN locked TINYINT(1) DEFAULT 0 AFTER status' },
  { table: 'timesheets', column: 'submitted_by', ddl: 'ALTER TABLE timesheets ADD COLUMN submitted_by BIGINT UNSIGNED NULL AFTER actioned_at' },

  // Payroll: persist reimbursements (they were computed but never stored, so claims
  // were never marked reimbursed and could be paid twice) and carry adjustment lines.
  { table: 'payroll_items', column: 'reimbursements', ddl: 'ALTER TABLE payroll_items ADD COLUMN reimbursements JSON NULL AFTER deductions' },
  { table: 'payroll_items', column: 'adjustments', ddl: 'ALTER TABLE payroll_items ADD COLUMN adjustments JSON NULL AFTER reimbursements' },
  { table: 'payroll_items', column: 'reimbursements_total', ddl: 'ALTER TABLE payroll_items ADD COLUMN reimbursements_total DECIMAL(12,2) DEFAULT 0 AFTER total_deductions' },
  { table: 'payroll_items', column: 'adjustments_total', ddl: 'ALTER TABLE payroll_items ADD COLUMN adjustments_total DECIMAL(12,2) DEFAULT 0 AFTER reimbursements_total' },
  { table: 'fnf_items', column: 'tenant_id', ddl: 'ALTER TABLE fnf_items ADD COLUMN tenant_id BIGINT UNSIGNED NULL AFTER id' },

  // ---------- Administration platform ----------
  // Tenant lifecycle: archived is a third lifecycle state distinct from suspension.
  { table: 'tenants', column: 'archived_at', ddl: 'ALTER TABLE tenants ADD COLUMN archived_at DATETIME NULL AFTER employee_limit' },
  { table: 'tenants', column: 'suspended_at', ddl: 'ALTER TABLE tenants ADD COLUMN suspended_at DATETIME NULL AFTER archived_at' },
  { table: 'tenants', column: 'onboarded_at', ddl: 'ALTER TABLE tenants ADD COLUMN onboarded_at DATETIME NULL AFTER suspended_at' },
  { table: 'tenants', column: 'limits', ddl: 'ALTER TABLE tenants ADD COLUMN limits JSON NULL AFTER onboarded_at' },

  { table: 'api_keys', column: 'expires_at', ddl: 'ALTER TABLE api_keys ADD COLUMN expires_at DATETIME NULL AFTER last_used_at' },

  // ---- Commercial layer ----
  { table: 'subscriptions', column: 'trial_extensions', ddl: 'ALTER TABLE subscriptions ADD COLUMN trial_extensions INT UNSIGNED NOT NULL DEFAULT 0 AFTER trial_ends_at' },
  { table: 'subscriptions', column: 'trial_extended_at', ddl: 'ALTER TABLE subscriptions ADD COLUMN trial_extended_at DATETIME NULL AFTER trial_extensions' },
  { table: 'subscriptions', column: 'trial_extension_reason', ddl: 'ALTER TABLE subscriptions ADD COLUMN trial_extension_reason VARCHAR(500) NULL AFTER trial_extended_at' },
  { table: 'subscriptions', column: 'converted_at', ddl: 'ALTER TABLE subscriptions ADD COLUMN converted_at DATETIME NULL AFTER trial_extension_reason' },
  { table: 'subscriptions', column: 'cancel_reason', ddl: 'ALTER TABLE subscriptions ADD COLUMN cancel_reason VARCHAR(500) NULL AFTER cancel_at_period_end' },
  { table: 'subscriptions', column: 'cancel_requested_by', ddl: 'ALTER TABLE subscriptions ADD COLUMN cancel_requested_by BIGINT UNSIGNED NULL AFTER cancel_reason' },
  { table: 'subscriptions', column: 'cancel_requested_at', ddl: 'ALTER TABLE subscriptions ADD COLUMN cancel_requested_at DATETIME NULL AFTER cancel_requested_by' },
  { table: 'subscriptions', column: 'cancel_effective_at', ddl: 'ALTER TABLE subscriptions ADD COLUMN cancel_effective_at DATETIME NULL AFTER cancel_requested_at' },
  { table: 'subscriptions', column: 'live_tenant_key', ddl: "ALTER TABLE subscriptions ADD COLUMN live_tenant_key BIGINT UNSIGNED AS (IF(status IN ('cancelled','expired'), NULL, tenant_id)) PERSISTENT" },
  { table: 'subscription_payments', column: 'kind', ddl: "ALTER TABLE subscription_payments ADD COLUMN kind ENUM('payment','refund') NOT NULL DEFAULT 'payment' AFTER invoice_id" },
  { table: 'subscription_payments', column: 'provider', ddl: 'ALTER TABLE subscription_payments ADD COLUMN provider VARCHAR(40) NULL AFTER method' },
  { table: 'subscription_payments', column: 'provider_ref', ddl: 'ALTER TABLE subscription_payments ADD COLUMN provider_ref VARCHAR(120) NULL AFTER provider' },
  { table: 'platform_plans', column: 'support_level', ddl: "ALTER TABLE platform_plans ADD COLUMN support_level VARCHAR(30) NOT NULL DEFAULT 'standard' AFTER trial_days" },

  // Roles become first-class configurable objects (label/name kept for compatibility).
  { table: 'roles', column: 'description', ddl: 'ALTER TABLE roles ADD COLUMN description VARCHAR(255) NULL AFTER label' },
  { table: 'roles', column: 'role_type', ddl: "ALTER TABLE roles ADD COLUMN role_type ENUM('platform','system','custom') DEFAULT 'custom' AFTER description" },
  { table: 'roles', column: 'is_custom', ddl: 'ALTER TABLE roles ADD COLUMN is_custom TINYINT(1) DEFAULT 0 AFTER role_type' },
  { table: 'roles', column: 'is_protected', ddl: 'ALTER TABLE roles ADD COLUMN is_protected TINYINT(1) DEFAULT 0 AFTER is_system' },
  { table: 'roles', column: 'status', ddl: "ALTER TABLE roles ADD COLUMN status ENUM('active','inactive','archived') DEFAULT 'active' AFTER is_protected" },
  { table: 'roles', column: 'created_by', ddl: 'ALTER TABLE roles ADD COLUMN created_by BIGINT UNSIGNED NULL AFTER status' },
  { table: 'roles', column: 'updated_by', ddl: 'ALTER TABLE roles ADD COLUMN updated_by BIGINT UNSIGNED NULL AFTER created_by' },
  { table: 'roles', column: 'code', ddl: 'ALTER TABLE roles ADD COLUMN code VARCHAR(60) NULL AFTER name' },

  // User lifecycle: invited / inactive / suspended / locked / archived alongside active.
  { table: 'users', column: 'failed_login_count', ddl: 'ALTER TABLE users ADD COLUMN failed_login_count INT UNSIGNED DEFAULT 0 AFTER must_change_password' },
  { table: 'users', column: 'locked_until', ddl: 'ALTER TABLE users ADD COLUMN locked_until DATETIME NULL AFTER failed_login_count' },
  { table: 'users', column: 'last_login_ip', ddl: 'ALTER TABLE users ADD COLUMN last_login_ip VARCHAR(64) NULL AFTER last_login_at' },
  { table: 'users', column: 'password_changed_at', ddl: 'ALTER TABLE users ADD COLUMN password_changed_at DATETIME NULL AFTER last_login_ip' },
  { table: 'users', column: 'deactivated_at', ddl: 'ALTER TABLE users ADD COLUMN deactivated_at DATETIME NULL AFTER password_changed_at' },

  // Audit trail gains module / request correlation / outcome for admin actions.
  { table: 'audit_logs', column: 'module', ddl: 'ALTER TABLE audit_logs ADD COLUMN module VARCHAR(60) NULL AFTER action' },
  { table: 'audit_logs', column: 'request_id', ddl: 'ALTER TABLE audit_logs ADD COLUMN request_id VARCHAR(64) NULL AFTER user_agent' },
  { table: 'audit_logs', column: 'outcome', ddl: 'ALTER TABLE audit_logs ADD COLUMN outcome VARCHAR(20) NULL AFTER request_id' },
  { table: 'audit_logs', column: 'actor_email', ddl: 'ALTER TABLE audit_logs ADD COLUMN actor_email VARCHAR(190) NULL AFTER actor_role' },

  // Organization entities gain description / location / cost center / effective dating.
  { table: 'departments', column: 'description', ddl: 'ALTER TABLE departments ADD COLUMN description VARCHAR(500) NULL AFTER name' },
  { table: 'departments', column: 'location_id', ddl: 'ALTER TABLE departments ADD COLUMN location_id BIGINT UNSIGNED NULL AFTER head_employee_id' },
  { table: 'departments', column: 'cost_center_id', ddl: 'ALTER TABLE departments ADD COLUMN cost_center_id BIGINT UNSIGNED NULL AFTER location_id' },
  { table: 'departments', column: 'effective_from', ddl: 'ALTER TABLE departments ADD COLUMN effective_from DATE NULL AFTER status' },
  { table: 'departments', column: 'effective_to', ddl: 'ALTER TABLE departments ADD COLUMN effective_to DATE NULL AFTER effective_from' },
  { table: 'departments', column: 'created_by', ddl: 'ALTER TABLE departments ADD COLUMN created_by BIGINT UNSIGNED NULL AFTER effective_to' },
  { table: 'departments', column: 'updated_by', ddl: 'ALTER TABLE departments ADD COLUMN updated_by BIGINT UNSIGNED NULL AFTER created_by' },
  { table: 'departments', column: 'archived_at', ddl: 'ALTER TABLE departments ADD COLUMN archived_at DATETIME NULL AFTER updated_by' },
  { table: 'departments', column: 'updated_at', ddl: 'ALTER TABLE departments ADD COLUMN updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP AFTER archived_at' },

  { table: 'business_units', column: 'description', ddl: 'ALTER TABLE business_units ADD COLUMN description VARCHAR(500) NULL AFTER name' },
  { table: 'business_units', column: 'location_id', ddl: 'ALTER TABLE business_units ADD COLUMN location_id BIGINT UNSIGNED NULL AFTER head_employee_id' },
  { table: 'business_units', column: 'cost_center_id', ddl: 'ALTER TABLE business_units ADD COLUMN cost_center_id BIGINT UNSIGNED NULL AFTER location_id' },

  { table: 'designations', column: 'description', ddl: 'ALTER TABLE designations ADD COLUMN description VARCHAR(255) NULL AFTER name' },
  { table: 'designations', column: 'job_level_id', ddl: 'ALTER TABLE designations ADD COLUMN job_level_id BIGINT UNSIGNED NULL AFTER grade_id' },
  { table: 'designations', column: 'level', ddl: 'ALTER TABLE designations ADD COLUMN level INT UNSIGNED DEFAULT 1 AFTER job_level_id' },
  { table: 'designations', column: 'effective_from', ddl: 'ALTER TABLE designations ADD COLUMN effective_from DATE NULL AFTER status' },
  { table: 'designations', column: 'effective_to', ddl: 'ALTER TABLE designations ADD COLUMN effective_to DATE NULL AFTER effective_from' },

  { table: 'grades', column: 'code', ddl: 'ALTER TABLE grades ADD COLUMN code VARCHAR(30) NULL AFTER name' },
  { table: 'grades', column: 'description', ddl: 'ALTER TABLE grades ADD COLUMN description VARCHAR(255) NULL AFTER level' },
  { table: 'grades', column: 'career_track', ddl: "ALTER TABLE grades ADD COLUMN career_track ENUM('individual','manager','leadership') DEFAULT 'individual' AFTER description" },

  { table: 'job_levels', column: 'code', ddl: 'ALTER TABLE job_levels ADD COLUMN code VARCHAR(30) NULL AFTER name' },

  { table: 'employees', column: 'job_level_id', ddl: 'ALTER TABLE employees ADD COLUMN job_level_id BIGINT UNSIGNED NULL AFTER grade_id' },
  { table: 'employees', column: 'position_id', ddl: 'ALTER TABLE employees ADD COLUMN position_id BIGINT UNSIGNED NULL AFTER designation_id' },

  // Workflow governance lifecycle alongside the existing runtime `active` switch.
  { table: 'workflows', column: 'description', ddl: 'ALTER TABLE workflows ADD COLUMN description VARCHAR(500) NULL AFTER name' },
  { table: 'workflows', column: 'status', ddl: "ALTER TABLE workflows ADD COLUMN status ENUM('draft','pending_approval','approved','active','expired','archived') DEFAULT 'active' AFTER active" },
  { table: 'workflows', column: 'published_at', ddl: 'ALTER TABLE workflows ADD COLUMN published_at DATETIME NULL AFTER status' },
  { table: 'workflows', column: 'updated_by', ddl: 'ALTER TABLE workflows ADD COLUMN updated_by BIGINT UNSIGNED NULL AFTER created_by' },

  // ---------- Platform control plane ----------
  // A tenant is not a legal entity, so the statutory registrations that Indian
  // payroll needs live on legal_entities rather than on the tenant.
  { table: 'legal_entities', column: 'tan', ddl: 'ALTER TABLE legal_entities ADD COLUMN tan VARCHAR(20) NULL AFTER gstin' },
  { table: 'legal_entities', column: 'address_line1', ddl: 'ALTER TABLE legal_entities ADD COLUMN address_line1 VARCHAR(255) NULL AFTER address' },
  { table: 'legal_entities', column: 'state_code', ddl: 'ALTER TABLE legal_entities ADD COLUMN state_code VARCHAR(8) NULL AFTER state' },
  { table: 'legal_entities', column: 'pincode', ddl: 'ALTER TABLE legal_entities ADD COLUMN pincode VARCHAR(12) NULL AFTER state_code' },
  { table: 'legal_entities', column: 'bank_name', ddl: 'ALTER TABLE legal_entities ADD COLUMN bank_name VARCHAR(120) NULL AFTER pincode' },
  { table: 'legal_entities', column: 'bank_account_enc', ddl: 'ALTER TABLE legal_entities ADD COLUMN bank_account_enc VARBINARY(512) NULL AFTER bank_name' },
  { table: 'legal_entities', column: 'bank_ifsc', ddl: 'ALTER TABLE legal_entities ADD COLUMN bank_ifsc VARCHAR(20) NULL AFTER bank_account_enc' },
  { table: 'legal_entities', column: 'pf_code', ddl: 'ALTER TABLE legal_entities ADD COLUMN pf_code VARCHAR(40) NULL AFTER bank_ifsc' },
  { table: 'legal_entities', column: 'esi_code', ddl: 'ALTER TABLE legal_entities ADD COLUMN esi_code VARCHAR(40) NULL AFTER pf_code' },
  { table: 'legal_entities', column: 'pt_state', ddl: 'ALTER TABLE legal_entities ADD COLUMN pt_state VARCHAR(8) NULL AFTER esi_code' },
  { table: 'legal_entities', column: 'pt_configuration', ddl: 'ALTER TABLE legal_entities ADD COLUMN pt_configuration JSON NULL AFTER pt_state' },
  { table: 'legal_entities', column: 'is_primary', ddl: 'ALTER TABLE legal_entities ADD COLUMN is_primary TINYINT(1) DEFAULT 0 AFTER pt_configuration' },

  // Tenant profile + lifecycle columns the provisioning wizard writes.
  { table: 'tenants', column: 'display_name', ddl: 'ALTER TABLE tenants ADD COLUMN display_name VARCHAR(160) NULL AFTER slug' },
  { table: 'tenants', column: 'industry', ddl: 'ALTER TABLE tenants ADD COLUMN industry VARCHAR(80) NULL AFTER plan' },
  { table: 'tenants', column: 'country', ddl: "ALTER TABLE tenants ADD COLUMN country VARCHAR(2) DEFAULT 'IN' AFTER industry" },
  { table: 'tenants', column: 'timezone', ddl: "ALTER TABLE tenants ADD COLUMN timezone VARCHAR(64) DEFAULT 'Asia/Kolkata' AFTER country" },
  { table: 'tenants', column: 'currency', ddl: "ALTER TABLE tenants ADD COLUMN currency VARCHAR(8) DEFAULT 'INR' AFTER timezone" },
  { table: 'tenants', column: 'contact_email', ddl: 'ALTER TABLE tenants ADD COLUMN contact_email VARCHAR(190) NULL AFTER currency' },
  { table: 'tenants', column: 'contact_phone', ddl: 'ALTER TABLE tenants ADD COLUMN contact_phone VARCHAR(30) NULL AFTER contact_email' },
  { table: 'tenants', column: 'deletion_scheduled_at', ddl: 'ALTER TABLE tenants ADD COLUMN deletion_scheduled_at DATETIME NULL AFTER archived_at' },
  { table: 'tenants', column: 'last_activity_at', ddl: 'ALTER TABLE tenants ADD COLUMN last_activity_at DATETIME NULL AFTER deletion_scheduled_at' },

  // Storage metering needs the size of what the vault actually holds (spec §13).
  { table: 'company_documents', column: 'file_size', ddl: 'ALTER TABLE company_documents ADD COLUMN file_size BIGINT DEFAULT 0 AFTER file_path' },

  // Plan editor metadata.
  { table: 'platform_plans', column: 'plan_type', ddl: "ALTER TABLE platform_plans ADD COLUMN plan_type ENUM('trial','standard','premium','custom') DEFAULT 'standard' AFTER description" },
  { table: 'platform_plans', column: 'is_public', ddl: 'ALTER TABLE platform_plans ADD COLUMN is_public TINYINT(1) DEFAULT 1 AFTER plan_type' },
  { table: 'platform_plans', column: 'trial_days', ddl: 'ALTER TABLE platform_plans ADD COLUMN trial_days INT UNSIGNED DEFAULT 0 AFTER employee_limit' },
];

// Widen ENUMs in place. Values already stored remain valid, so this is additive.
const ENUM_WIDENING = [
  {
    table: 'users', column: 'status',
    contains: 'invited',current: "'active'",
    ddl: "ALTER TABLE users MODIFY COLUMN status ENUM('invited','active','inactive','suspended','locked','disabled','archived') DEFAULT 'active'",
  },
  {
    table: 'tenants', column: 'status',
    contains: 'archived',
    ddl: "ALTER TABLE tenants MODIFY COLUMN status ENUM('active','suspended','archived') DEFAULT 'active'",
  },
  // Full tenant lifecycle (spec §27). Applied after the widening above so an
  // installation that has already been through an earlier version reaches the
  // final shape in order and never loses the value it was holding.
  {
    table: 'tenants', column: 'status',
    contains: 'deletion_pending',
    ddl: "ALTER TABLE tenants MODIFY COLUMN status ENUM('provisioning','trial','active','past_due','grace_period','suspended','cancelled','archived','deletion_pending','deleted') DEFAULT 'active'",
  },
  // Support access gained a fourth state so `requires_approval` can be enforced
  // rather than merely recorded (spec §21): a session requested with a second
  // pair of eyes is created `pending` and grants nothing until approved by a
  // different operator.
  {
    table: 'support_access_sessions', column: 'status',
    contains: 'pending',
    ddl: "ALTER TABLE support_access_sessions MODIFY COLUMN status ENUM('pending','active','expired','revoked') DEFAULT 'active'",
  },
];

// Secondary indexes added after the initial release; MariaDB/MySQL both lack IF NOT EXISTS here,
// so each is attempted and "already exists" is tolerated.
const INDEX_ADDITIONS = [
  { table: 'projects', index: 'idx_proj_tenant', ddl: 'ALTER TABLE projects ADD KEY idx_proj_tenant (tenant_id, status)' },
  { table: 'timesheets', index: 'idx_ts_status', ddl: 'ALTER TABLE timesheets ADD KEY idx_ts_status (tenant_id, status, week_start)' },
  { table: 'fnf_items', index: 'idx_fnf_tenant', ddl: 'ALTER TABLE fnf_items ADD KEY idx_fnf_tenant (tenant_id, separation_id)' },
  // Commercial rules enforced by the database, not only by code:
  { table: 'subscriptions', index: 'uq_live_sub', ddl: 'CREATE UNIQUE INDEX uq_live_sub ON subscriptions (live_tenant_key)' },
  { table: 'subscription_payments', index: 'uq_payment_provider_ref', ddl: 'CREATE UNIQUE INDEX uq_payment_provider_ref ON subscription_payments (provider, provider_ref)' },
];

async function addMissingColumns() {
  let added = 0;
  for (const { table, column, ddl } of COLUMN_ADDITIONS) {
    const [rows] = await pool.query(
      `SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [table, column]
    );
    if (rows[0].n === 0) {
      try {
        await pool.query(ddl);
        added++;
        console.log(`[migrate] added column ${table}.${column}`);
      } catch (e) {
        if (!/duplicate column|already exists/i.test(e.message)) throw e;
      }
    }
  }
  if (added) console.log(`[migrate] ${added} column addition(s) applied`);

  let indexed = 0;
  for (const { table, index, ddl } of INDEX_ADDITIONS) {
    const [rows] = await pool.query(
      `SELECT COUNT(*) AS n FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`,
      [table, index]
    );
    if (rows[0].n === 0) {
      try {
        await pool.query(ddl);
        indexed++;
        console.log(`[migrate] added index ${table}.${index}`);
      } catch (e) {
        if (!/duplicate|already exists/i.test(e.message)) throw e;
      }
    }
  }
  if (indexed) console.log(`[migrate] ${indexed} index addition(s) applied`);

  let widened = 0;
  for (const { table, column, contains, ddl } of ENUM_WIDENING) {
    const [rows] = await pool.query(
      `SELECT COLUMN_TYPE AS t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [table, column]
    );
    if (rows[0] && !rows[0].t.includes(`'${contains}'`)) {
      try {
        await pool.query(ddl);
        widened++;
        console.log(`[migrate] widened enum ${table}.${column}`);
      } catch (e) {
        if (!/duplicate|already exists/i.test(e.message)) throw e;
      }
    }
  }
  if (widened) console.log(`[migrate] ${widened} enum widening(s) applied`);
}

/**
 * Publish the in-code permission catalogue into the `permissions` registry so the
 * Administration Center can browse/group/assign permissions from data rather than
 * from a hard-coded array. Idempotent (INSERT IGNORE on the unique pkey).
 */
async function seedPermissionCatalog() {
  const { PERMISSION_CATALOG } = require('../utils/permissions');
  const rows = PERMISSION_CATALOG.map((p) => [
    p.key, p.module, p.action, p.base,
    p.label, p.description || null, p.category || p.module,
    p.scopes && p.scopes.length ? 1 : 0, 1,
  ]);
  if (!rows.length) return;
  const [res] = await pool.query(
    `INSERT IGNORE INTO permissions (pkey, module, action, base_key, label, description, category, supports_scope, is_system)
     VALUES ?`, [rows]
  );
  if (res.affectedRows) console.log(`[migrate] published ${res.affectedRows} permission(s) to the registry`);
}

/**
 * roles.permissions (JSON) is the long-standing source of truth. Mirror it into the
 * normalised role_permissions table so roles can also be composed from permission
 * groups, and so the UI can join without parsing JSON per row. Idempotent.
 */
async function backfillRolePermissions() {
  const [roles] = await pool.query('SELECT id, tenant_id, permissions FROM roles');
  let n = 0;
  for (const role of roles) {
    let perms = role.permissions;
    if (typeof perms === 'string') { try { perms = JSON.parse(perms || '[]'); } catch { perms = []; } }
    if (!Array.isArray(perms) || !perms.length) continue;
    const [ids] = await pool.query(
      'SELECT id, pkey FROM permissions WHERE pkey IN (?)', [perms]
    );
    if (!ids.length) continue;
    const values = ids.map((p) => [role.tenant_id, role.id, p.id]);
    const [res] = await pool.query(
      'INSERT IGNORE INTO role_permissions (tenant_id, role_id, permission_id) VALUES ?', [values]
    );
    n += res.affectedRows;
  }
  if (n) console.log(`[migrate] mirrored ${n} role permission grant(s) into role_permissions`);
}

/** users.role is the single-role legacy column; mirror it into user_roles. */
async function backfillUserRoles() {
  const [users] = await pool.query(
    `SELECT u.id, u.tenant_id, u.role, r.id AS role_id
     FROM users u LEFT JOIN roles r ON r.name = u.role AND (r.tenant_id = u.tenant_id OR r.tenant_id IS NULL)`
  );
  const values = users.filter((u) => u.role_id).map((u) => [u.tenant_id, u.id, u.role_id, 1]);
  if (!values.length) return;
  const [res] = await pool.query(
    'INSERT IGNORE INTO user_roles (tenant_id, user_id, role_id, is_primary) VALUES ?', [values]
  );
  if (res.affectedRows) console.log(`[migrate] mirrored ${res.affectedRows} user→role assignment(s)`);
}

/** System permission groups + a per-tenant copy of each so companies can edit them. */
async function seedPermissionGroups() {
  const { SYSTEM_PERMISSION_GROUPS } = require('../utils/permissions');
  for (const g of SYSTEM_PERMISSION_GROUPS) {
    await pool.query(
      `INSERT INTO permission_groups (tenant_id, code, name, description, is_system, status)
       VALUES (NULL, ?, ?, ?, 1, 'active') ON DUPLICATE KEY UPDATE name = VALUES(name), description = VALUES(description)`,
      [g.code, g.name, g.description]
    );
    const [[row]] = await pool.query('SELECT id FROM permission_groups WHERE tenant_id IS NULL AND code = ?', [g.code]);
    if (!row) continue;
    if (g.permissions.length) {
      const [ids] = await pool.query('SELECT id FROM permissions WHERE pkey IN (?)', [g.permissions]);
      if (ids.length) {
        await pool.query(
          'INSERT IGNORE INTO permission_group_permissions (tenant_id, group_id, permission_id) VALUES ?',
          [ids.map((p) => [null, row.id, p.id])]
        );
      }
    }
    const [tenants] = await pool.query('SELECT id FROM tenants');
    for (const t of tenants) {
      await pool.query(
        `INSERT INTO permission_groups (tenant_id, code, name, description, is_system, status)
         VALUES (?, ?, ?, ?, 1, 'active') ON DUPLICATE KEY UPDATE name = VALUES(name)`,
        [t.id, g.code, g.name, g.description]
      );
      const [[tRow]] = await pool.query('SELECT id FROM permission_groups WHERE tenant_id = ? AND code = ?', [t.id, g.code]);
      if (tRow && g.permissions.length) {
        const [ids] = await pool.query('SELECT id FROM permissions WHERE pkey IN (?)', [g.permissions]);
        if (ids.length) {
          await pool.query(
            'INSERT IGNORE INTO permission_group_permissions (tenant_id, group_id, permission_id) VALUES ?',
            [ids.map((p) => [t.id, tRow.id, p.id])]
          );
        }
      }
    }
  }
}

/**
 * employees.manager_id stays authoritative, but the relationship engine needs a row.
 * Seed the reporting_manager relationship from it so new relationship features work
 * on data created before this migration.
 */
async function backfillReportingRelationships() {
  const [[type]] = await pool.query(
    "SELECT id FROM employee_relationship_types WHERE tenant_id IS NULL AND code = 'reporting_manager'"
  );
  if (!type) return;
  const [res] = await pool.query(
    `INSERT IGNORE INTO employee_relationships (tenant_id, employee_id, related_employee_id, relationship_type_id, is_primary, effective_from)
     SELECT e.tenant_id, e.id, e.manager_id, ?, 1, e.joined_on
     FROM employees e WHERE e.manager_id IS NOT NULL AND e.deleted_at IS NULL`,
    [type.id]
  );
  if (res.affectedRows) console.log(`[migrate] backfilled ${res.affectedRows} reporting relationship(s)`);
}

/** Platform defaults: plans, system relationship types, default security policies. */
async function seedPlatformDefaults() {
  const { PLATFORM_PLANS, DEFAULT_SECURITY_POLICIES, SYSTEM_RELATIONSHIP_TYPES } = require('../utils/permissions');
  for (const p of PLATFORM_PLANS) {
    await pool.query(
      `INSERT INTO platform_plans (plan_key, name, description, plan_type, is_public, price_monthly, employee_limit,
         module_keys, feature_limits, trial_days, sort_order)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE name = VALUES(name), description = VALUES(description), plan_type = VALUES(plan_type),
         is_public = VALUES(is_public), price_monthly = VALUES(price_monthly), employee_limit = VALUES(employee_limit),
         module_keys = VALUES(module_keys), feature_limits = VALUES(feature_limits), trial_days = VALUES(trial_days)`,
      [p.key, p.name, p.description, p.planType || 'standard', p.isPublic === false ? 0 : 1,
        p.priceMonthly, p.employeeLimit ?? maxOf(p.entitlements, 'employees.max'),
        p.modules ? JSON.stringify(p.modules) : null, null, p.trialDays || 0, p.sortOrder]
    );
  }
  for (const t of SYSTEM_RELATIONSHIP_TYPES) {
    await pool.query(
      `INSERT INTO employee_relationship_types (tenant_id, code, name, description, is_primary_type, is_system, sort_order)
       VALUES (NULL, ?,?,?,?,1,?) ON DUPLICATE KEY UPDATE name = VALUES(name), sort_order = VALUES(sort_order)`,
      [t.code, t.name, t.description, t.isPrimary ? 1 : 0, t.sortOrder]
    );
    const [tenants] = await pool.query('SELECT id FROM tenants');
    for (const tenant of tenants) {
      await pool.query(
        `INSERT INTO employee_relationship_types (tenant_id, code, name, description, is_primary_type, is_system, sort_order)
         VALUES (?,?,?,?,?,1,?) ON DUPLICATE KEY UPDATE name = VALUES(name)`,
        [tenant.id, t.code, t.name, t.description, t.isPrimary ? 1 : 0, t.sortOrder]
      );
    }
  }
  for (const [key, value] of Object.entries(DEFAULT_SECURITY_POLICIES)) {
    await pool.query(
      `INSERT INTO security_policies (tenant_id, policy_key, policy_value, description)
       VALUES (NULL, ?, ?, ?) ON DUPLICATE KEY UPDATE description = VALUES(description)`,
      [key, JSON.stringify(value), value.__desc || null]
    );
  }
}

/** Every tenant gets a full module-configuration row set so nothing is ever undefined. */
async function seedModuleConfigurations() {
  const { MODULE_CATALOG } = require('../utils/permissions');
  const [tenants] = await pool.query('SELECT id, plan FROM tenants');
  for (const t of tenants) {
    // Only companies whose module configuration has already been materialised are
    // backfilled here. Flipping a feature off (and, now that gates are wired, refusing
    // its endpoints) must be a deliberate admin action, never a side effect of running a
    // migration, so those companies keep every module they already use. A tenant with no
    // rows is a company created after this migration: it is left alone so it resolves to
    // the catalog's defaults (see rbac.enabledModules) until its owner chooses otherwise.
    const [existing] = await pool.query(
      'SELECT COUNT(*) AS n FROM module_configurations WHERE tenant_id = ?', [t.id]
    );
    if (!Number(existing[0].n)) continue;
    for (const m of MODULE_CATALOG) {
      // `INSERT IGNORE` means a row an admin has already changed is never touched again.
      await pool.query(
        `INSERT IGNORE INTO module_configurations (tenant_id, module_key, name, category, enabled, available_from_plan)
         VALUES (?,?,?,?,1,?)`,
        [t.id, m.key, m.name, m.category, m.minPlan || null]
      );
    }
  }
}

/**
 * One-time backfill: timesheets written before normalisation only have the legacy `entries`
 * JSON blob. Expand those into timesheet_entries so totals and analytics are consistent.
 * Idempotent — sheets that already have entry rows are skipped.
 */
async function backfillTimesheetEntries() {
  const [result] = await pool.query(
    `INSERT INTO timesheet_entries (tenant_id, timesheet_id, employee_id, entry_date, project_id, hours, task, billable, source)
     SELECT t.tenant_id, t.id, t.employee_id,
            STR_TO_DATE(SUBSTRING(j.entry_date, 1, 10), '%Y-%m-%d'),
            j.project_id,
            LEAST(24, GREATEST(0, CAST(j.hours AS DECIMAL(5,2)))),
            LEFT(j.task, 255),
            IF(j.billable, 1, 0),
            'import'
     FROM timesheets t
     JOIN JSON_TABLE(
       t.entries, '$[*]' COLUMNS (
         entry_date VARCHAR(20) PATH '$.date',
         project_id BIGINT UNSIGNED PATH '$.project_id' NULL ON EMPTY,
         hours DECIMAL(6,2) PATH '$.hours' DEFAULT 0 ON EMPTY,
         task VARCHAR(255) PATH '$.task' NULL ON EMPTY,
         billable TINYINT(1) PATH '$.billable' DEFAULT 0 ON EMPTY
       )
     ) AS j
     WHERE JSON_LENGTH(t.entries) > 0
       AND NOT EXISTS (SELECT 1 FROM timesheet_entries te WHERE te.timesheet_id = t.id)`
  );
  if (result.affectedRows) console.log(`[migrate] backfilled ${result.affectedRows} timesheet entry row(s)`);

  // Keep the denormalised split totals in sync for anything backfilled above.
  // Correlated subqueries rather than UPDATE ... FROM, which MariaDB does not support here.
  await pool.query(
    `UPDATE timesheets t
     SET billable_hours = COALESCE(
           (SELECT SUM(IF(te.billable = 1, te.hours, 0)) FROM timesheet_entries te WHERE te.timesheet_id = t.id), 0),
         non_billable_hours = COALESCE(
           (SELECT SUM(IF(te.billable = 0, te.hours, 0)) FROM timesheet_entries te WHERE te.timesheet_id = t.id), 0)
     WHERE EXISTS (SELECT 1 FROM timesheet_entries te WHERE te.timesheet_id = t.id)`
  );
}

/** fnf_items predates tenant scoping — inherit the tenant from its separation. */
async function backfillFnfTenant() {
  const [res] = await pool.query(
    `UPDATE fnf_items f JOIN separations s ON s.id = f.separation_id
     SET f.tenant_id = s.tenant_id WHERE f.tenant_id IS NULL`
  );
  if (res.affectedRows) console.log(`[migrate] backfilled tenant_id on ${res.affectedRows} fnf_items row(s)`);
}

/**
 * Role rows are seeded per tenant, so adding a permission to ROLE_DEFS alone silently does
 * nothing for tenants that already exist. Union any newly-declared permissions into the
 * matching roles rows (additive only — a tenant's own extra permissions are never removed).
 */
async function syncRolePermissions() {
  const { ROLE_DEFS } = require('../utils/permissions');

  // The platform role is not tenant-scoped, so no tenant seed creates its roles row.
  // Materialise it here (idempotently) so permissions stay DB-authoritative instead of
  // silently falling back to the in-code ROLE_DEFS in middleware/auth.
  const [existing] = await pool.query('SELECT id FROM roles WHERE name = ? AND tenant_id IS NULL', ['platform_super_admin']);
  if (!existing.length) {
    const def = ROLE_DEFS.platform_super_admin;
    await pool.query('INSERT INTO roles (tenant_id, name, label, permissions, is_system) VALUES (NULL,?,?,?,1)',
      ['platform_super_admin', def.label, JSON.stringify(def.permissions)]);
    console.log('[migrate] created platform_super_admin role row');
  }

  const [rows] = await pool.query('SELECT id, name, permissions FROM roles');
  let updated = 0;
  for (const row of rows) {
    const def = ROLE_DEFS[row.name];
    if (!def) continue; // tenant-defined custom role
    const current = Array.isArray(row.permissions) ? row.permissions : JSON.parse(row.permissions || '[]');
    const missing = def.permissions.filter((p) => !current.includes(p));
    if (!missing.length) continue;
    await pool.query('UPDATE roles SET permissions = ? WHERE id = ?', [
      JSON.stringify([...current, ...missing]), row.id,
    ]);
    console.log(`[migrate] role ${row.name}: +${missing.length} permission(s)`);
    updated++;
  }
  if (updated) console.log(`[migrate] synced permissions on ${updated} role row(s)`);

  // A permission nobody holds is dead code at runtime — surface it instead of failing silently.
  const granted = new Set();
  const [after] = await pool.query('SELECT permissions FROM roles');
  for (const r of after) {
    const list = Array.isArray(r.permissions) ? r.permissions : JSON.parse(r.permissions || '[]');
    for (const p of list) granted.add(p);
  }
  const { PERMISSIONS } = require('../utils/permissions');
  const orphans = PERMISSIONS.filter((p) => !granted.has(p) && !p.includes(':'));
  if (orphans.length) console.log(`[migrate] WARNING: no role grants: ${orphans.join(', ')}`);
}

/**
 * Publish the entitlement catalogue and every plan's grant list.
 *
 * Additive and idempotent: `INSERT ... ON DUPLICATE KEY UPDATE` on the natural key,
 * so re-running never duplicates a row and never drops a value an operator changed
 * on the plan editor (plan edits made in the UI write to the same tables and are
 * left alone because the seed only touches the keys it owns).
 */
async function seedEntitlementsAndPlanGrants() {
  const { ENTITLEMENT_CATALOG, PLATFORM_PLANS } = require('../utils/permissions');
  let published = 0;
  for (const [i, e] of ENTITLEMENT_CATALOG.entries()) {
    await pool.query(
      `INSERT INTO entitlements (entitlement_key, name, description, kind, module_key, scope, period,
          default_value, unit, unit_label, warning_pct, critical_pct, is_platform_available, sort_order)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE name = VALUES(name), description = VALUES(description), kind = VALUES(kind),
         module_key = VALUES(module_key), period = VALUES(period), unit = VALUES(unit),
         unit_label = VALUES(unit_label), warning_pct = VALUES(warning_pct), critical_pct = VALUES(critical_pct)`,
      [e.key, e.name, e.description || null, e.kind, e.moduleKey || null, 'tenant', e.period || 'none',
        e.defaultValue ?? null, e.unit || null, e.unitLabel || null,
        e.warningPct ?? 80, e.criticalPct ?? 90, e.isPlatformAvailable === false ? 0 : 1, (i + 1) * 10]
    );
    published++;
  }

  const [entRows] = await pool.query('SELECT id, entitlement_key FROM entitlements');
  const byKey = new Map(entRows.map((r) => [r.entitlement_key, r.id]));
  let grants = 0;
  for (const plan of PLATFORM_PLANS) {
    const [[row]] = await pool.query('SELECT id FROM platform_plans WHERE plan_key = ?', [plan.key]);
    if (!row) continue;
    for (const [key, value] of Object.entries(plan.entitlements || {})) {
      const entitlementId = byKey.get(key);
      if (!entitlementId) continue;
      await pool.query(
        `INSERT INTO plan_entitlements (plan_id, entitlement_id, value) VALUES (?,?,?)
         ON DUPLICATE KEY UPDATE value = VALUES(value)`,
        [row.id, entitlementId, String(value)]
      );
      grants++;
    }
  }
  console.log(`[migrate] entitlement catalogue seeded (${published} entitlements, ${grants} plan grants)`);
}

/**
 * Give every existing tenant the control-plane rows a subscription/usage screen
 * expects, without changing how it behaves.
 *
 * A company that predates subscriptions gets a `trialing`→`active` subscription on
 * whatever plan it already had, so its entitlements resolve from the plan instead
 * of falling back to defaults. Its `employee_limit` is preserved as a tenant
 * override when it is *tighter* than the plan, so an existing installation never
 * silently gains seats.
 */
async function backfillTenantSubscriptions() {
  const { LEGACY_PLAN_ALIASES } = require('../utils/permissions');
  const [tenants] = await pool.query('SELECT id, plan, employee_limit, status FROM tenants');
  let created = 0;
  for (const t of tenants) {
    const [existing] = await pool.query('SELECT id FROM subscriptions WHERE tenant_id = ? LIMIT 1', [t.id]);
    if (!existing.length) {
      const planKey = LEGACY_PLAN_ALIASES[t.plan] || t.plan;
      const [[plan]] = await pool.query('SELECT * FROM platform_plans WHERE plan_key = ?', [planKey]);
      if (!plan) continue;
      const [ins] = await pool.query(
        `INSERT INTO subscriptions (tenant_id, plan_id, plan_key, status, billing_cycle, quantity, price_per_period,
            current_period_start, current_period_end)
         VALUES (?,?,?,'active','monthly',0,?, NOW(), DATE_ADD(NOW(), INTERVAL 1 MONTH))`,
        [t.id, plan.id, plan.plan_key, plan.price_monthly]
      );
      await pool.query(
        `INSERT INTO subscription_events (subscription_id, tenant_id, event_type, to_status, reason)
         VALUES (?,?,'created','active','Backfilled from the existing tenant plan')`,
        [ins.insertId, t.id]
      );
      created++;
    }

    // Never widen an existing company silently: only pin a limit that is tighter.
    if (t.employee_limit) {
      const [rows] = await pool.query(
        `SELECT e.id FROM entitlements e
         JOIN plan_entitlements pe ON pe.entitlement_id = e.id
         JOIN platform_plans p ON p.id = pe.plan_id
         JOIN tenants tn ON tn.plan = p.plan_key
         WHERE e.entitlement_key = 'employees.max' AND tn.id = ? LIMIT 1`, [t.id]
      );
      const planLimit = rows[0] ? Number((await pool.query('SELECT value FROM plan_entitlements WHERE plan_id = (SELECT id FROM platform_plans WHERE plan_key = ?) AND entitlement_id = ?', [LEGACY_PLAN_ALIASES[t.plan] || t.plan, rows[0].id]))[0][0].value) : null;
      if (planLimit && t.employee_limit < planLimit) {
        await pool.query(
          `INSERT INTO tenant_entitlement_overrides (tenant_id, entitlement_id, value, reason, status, effective_from)
           VALUES (?,?,?,?, 'active', NOW())
           ON DUPLICATE KEY UPDATE value = VALUES(value)`,
          [t.id, rows[0].id, String(t.employee_limit), 'Preserved from tenants.employee_limit during migration']
        );
      }
    }
  }
  if (created) console.log(`[migrate] backfilled ${created} subscription(s) for existing companies`);
}

/**
 * Materialise the platform roles as global (`tenant_id IS NULL`) role rows.
 *
 * Unlike tenant roles these are *replaced* rather than merged: a platform role is
 * owned by the product, not by an administrator, so the code definition is
 * authoritative and a stale grant left over from an earlier release (the old
 * "every HRMS permission" super admin) is withdrawn rather than inherited.
 */
async function seedPlatformRoles() {
  const { ROLE_DEFS, PLATFORM_ROLE_KEYS } = require('../utils/permissions');
  for (const key of PLATFORM_ROLE_KEYS) {
    const def = ROLE_DEFS[key];
    if (!def) continue;
    const [rows] = await pool.query('SELECT id, permissions FROM roles WHERE name = ? AND tenant_id IS NULL', [key]);
    const wanted = def.permissions;
    if (!rows.length) {
      await pool.query(
        `INSERT INTO roles (tenant_id, name, code, label, description, permissions, is_system, is_protected, role_type, status)
         VALUES (NULL,?,?,?,?,?,1,1,'platform','active')`,
        [key, key, def.label, 'ARTHVEX platform role', JSON.stringify(wanted)]
      );
      continue;
    }
    const current = Array.isArray(rows[0].permissions) ? rows[0].permissions : JSON.parse(rows[0].permissions || '[]');
    const missing = wanted.filter((p) => !current.includes(p));
    const extra = current.filter((p) => !wanted.includes(p));
    if (!missing.length && !extra.length) continue;
    await pool.query('UPDATE roles SET permissions = ? WHERE id = ?', [JSON.stringify(wanted), rows[0].id]);
    console.log(`[migrate] role ${key}: +${missing.length} / -${extra.length} permission(s)`);
  }
}

/**
 * The Administration Center reads its audit trail through a view over the single
 * immutable `audit_logs` table — one trail, one place to look — rather than a
 * second table that could drift. Created last, after the projected columns exist.
 */
async function createAdminAuditView() {
  await pool.query(`DROP VIEW IF EXISTS admin_audit_logs`);
  await pool.query(
    `CREATE OR REPLACE VIEW admin_audit_logs AS
     SELECT id, tenant_id, actor_user_id, actor_name, actor_role, actor_email, module, action,
            entity_type, entity_id, before_json, after_json, ip, user_agent,
            request_id, outcome, created_at
     FROM audit_logs`
  );
  console.log('[migrate] admin_audit_logs view ready');
}

/**
 * The `/admin` console login. Created here as well as in the seed so an existing
 * installation can gain the console entrance by running the (non-destructive)
 * migration instead of re-seeding. Idempotent: an existing account is left untouched,
 * so it never re-enables a login someone deliberately locked or resets a password
 * they changed.
 */
async function ensureAdminConsoleAccount() {
  const { ensureAdminUser, ADMIN_EMAIL, ADMIN_PASSWORD } = require('./lib/adminAccount');
  const outcome = await ensureAdminUser(pool);
  if (outcome === 'created') console.log(`[migrate] created the ${ADMIN_EMAIL} console login (password: ${ADMIN_PASSWORD})`);
  else if (outcome === 'no-tenant') console.log('[migrate] no tenant yet — the console login will be created on the next seed');
}

async function migrate() {
  const schemaPath = path.join(__dirname, '..', '..', 'db', 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');
  // Comments are stripped *before* the file is split into statements. Splitting
  // first means a `;` inside a `--` comment truncates the DDL before it, which
  // then fails to parse — a failure that looks like a schema error rather than the
  // punctuation problem it is.
  const withoutComments = sql.replace(/^\s*--.*$/gm, '');
  const statements = withoutComments
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  let applied = 0;
  for (const stmt of statements) {
    const clean = stmt.trim();
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
  await addMissingColumns();
  await backfillTimesheetEntries();
  await backfillFnfTenant();
  await syncRolePermissions();
  await seedPlatformRoles();
  await seedPermissionCatalog();
  await backfillRolePermissions();
  await backfillUserRoles();
  await seedPermissionGroups();
  await seedPlatformDefaults();
  await seedEntitlementsAndPlanGrants();
  await backfillTenantSubscriptions();
  await seedModuleConfigurations();
  await backfillReportingRelationships();
  await ensureAdminConsoleAccount();
  await createAdminAuditView();
  require('../services/entitlements').invalidateAll();
  require('../services/rbac').invalidateAll();
  await pool.end();
}

migrate().catch((e) => { console.error(e); process.exit(1); });
