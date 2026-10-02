-- ============================================================
-- ARTHVEX HRMS — MySQL Schema (MariaDB 10.6+ / MySQL 8 compatible)
-- Multi-tenant shared-schema design: every business table carries tenant_id.
-- ============================================================

SET FOREIGN_KEY_CHECKS = 0;

-- ---------- Platform / tenancy ----------
CREATE TABLE IF NOT EXISTS tenants (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(160) NOT NULL,
  slug VARCHAR(80) NOT NULL UNIQUE,
  plan VARCHAR(40) DEFAULT 'standard',
  status ENUM('active','suspended') DEFAULT 'active',
  branding JSON,                -- {logoUrl, primaryColor, companyName, supportEmail, loginTagline}
  feature_flags JSON,           -- {recruitment:true, performance:true, billing:false, ...}
  employee_limit INT UNSIGNED DEFAULT 200,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS roles (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NULL,             -- NULL = system role template
  name VARCHAR(60) NOT NULL,
  label VARCHAR(80) NOT NULL,
  permissions JSON NOT NULL,                  -- ["employee.view:company", ...]
  is_system TINYINT(1) DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_role (tenant_id, name)
);

CREATE TABLE IF NOT EXISTS users (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NULL,             -- NULL only for platform super admin
  employee_id BIGINT UNSIGNED NULL,
  email VARCHAR(190) NOT NULL UNIQUE,
  phone VARCHAR(20) NULL,
  password_hash VARCHAR(255) NOT NULL,
  name VARCHAR(120) NOT NULL,
  role VARCHAR(40) NOT NULL,                  -- role key; permissions from roles table (system default if no row)
  status ENUM('active','disabled') DEFAULT 'active',
  mfa_enabled TINYINT(1) DEFAULT 0,
  mfa_secret VARCHAR(255) NULL,
  must_change_password TINYINT(1) DEFAULT 0,
  last_login_at DATETIME NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_users_tenant (tenant_id),
  KEY idx_users_employee (employee_id)
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  token_hash VARCHAR(128) NOT NULL,
  user_agent VARCHAR(255) NULL,
  ip VARCHAR(64) NULL,
  expires_at DATETIME NOT NULL,
  revoked_at DATETIME NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY idx_rt_user (user_id),
  KEY idx_rt_hash (token_hash)
);

CREATE TABLE IF NOT EXISTS password_resets (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  token_hash VARCHAR(128) NOT NULL,
  expires_at DATETIME NOT NULL,
  used_at DATETIME NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NULL,
  actor_user_id BIGINT UNSIGNED NULL,
  actor_name VARCHAR(120),
  actor_role VARCHAR(40),
  action VARCHAR(80) NOT NULL,                -- e.g. employee.update, payroll.approve, auth.login
  entity_type VARCHAR(60),
  entity_id VARCHAR(40),
  before_json JSON NULL,
  after_json JSON NULL,
  ip VARCHAR(64),
  user_agent VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY idx_audit_tenant_time (tenant_id, created_at),
  KEY idx_audit_entity (entity_type, entity_id)
);

CREATE TABLE IF NOT EXISTS settings (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  skey VARCHAR(80) NOT NULL,                  -- company, attendance, leave, payroll, notifications, billing, workflows
  svalue JSON NOT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_setting (tenant_id, skey)
);

-- ---------- Organization ----------
CREATE TABLE IF NOT EXISTS companies (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  legal_name VARCHAR(190) NOT NULL,
  trade_name VARCHAR(190),
  cin VARCHAR(40), pan VARCHAR(20), tan VARCHAR(20), gstin VARCHAR(20),
  address_line1 VARCHAR(190), address_line2 VARCHAR(190), city VARCHAR(80),
  state VARCHAR(80), state_code VARCHAR(4), pincode VARCHAR(10), country VARCHAR(80) DEFAULT 'India',
  contact_email VARCHAR(190), contact_phone VARCHAR(20),
  fiscal_year_start_month TINYINT UNSIGNED DEFAULT 4,
  timezone VARCHAR(60) DEFAULT 'Asia/Kolkata',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_company_tenant (tenant_id)
);

CREATE TABLE IF NOT EXISTS locations (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(120) NOT NULL,
  code VARCHAR(30),
  address VARCHAR(255), city VARCHAR(80), state VARCHAR(80),
  timezone VARCHAR(60) DEFAULT 'Asia/Kolkata',
  status ENUM('active','inactive') DEFAULT 'active',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS departments (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(120) NOT NULL,
  code VARCHAR(30),
  parent_id BIGINT UNSIGNED NULL,
  head_employee_id BIGINT UNSIGNED NULL,
  status ENUM('active','inactive') DEFAULT 'active',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS grades (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(80) NOT NULL,
  level INT UNSIGNED DEFAULT 1,
  status ENUM('active','inactive') DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS designations (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(120) NOT NULL,
  code VARCHAR(30),
  grade_id BIGINT UNSIGNED NULL,
  status ENUM('active','inactive') DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS cost_centers (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(120) NOT NULL,
  code VARCHAR(30),
  status ENUM('active','inactive') DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS shifts (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(120) NOT NULL,
  code VARCHAR(30),
  start_time TIME NOT NULL DEFAULT '09:30:00',
  end_time TIME NOT NULL DEFAULT '18:30:00',
  grace_minutes INT UNSIGNED DEFAULT 10,
  half_day_hours DECIMAL(4,2) DEFAULT 4.00,
  full_day_hours DECIMAL(4,2) DEFAULT 8.00,
  break_minutes INT UNSIGNED DEFAULT 45,
  weekly_offs JSON,                            -- ["Sun"] or ["Sat","Sun"]
  cross_midnight TINYINT(1) DEFAULT 0,
  overtime_enabled TINYINT(1) DEFAULT 0,
  min_overtime_minutes INT UNSIGNED DEFAULT 30,
  status ENUM('active','inactive') DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS employee_shifts (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  employee_id BIGINT UNSIGNED NOT NULL,
  shift_id BIGINT UNSIGNED NOT NULL,
  effective_from DATE NOT NULL,
  effective_to DATE NULL
);

CREATE TABLE IF NOT EXISTS holidays (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  location_id BIGINT UNSIGNED NULL,            -- NULL = all locations
  hdate DATE NOT NULL,
  name VARCHAR(120) NOT NULL,
  htype ENUM('public','optional','restricted') DEFAULT 'public',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_holiday (tenant_id, location_id, hdate)
);

-- ---------- Employees ----------
CREATE TABLE IF NOT EXISTS employees (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  employee_code VARCHAR(30) NOT NULL,
  first_name VARCHAR(80) NOT NULL,
  last_name VARCHAR(80) NOT NULL,
  email VARCHAR(190) NOT NULL,
  personal_email VARCHAR(190),
  phone VARCHAR(20),
  dob DATE, gender ENUM('male','female','other'),
  marital_status ENUM('single','married','other'),
  blood_group VARCHAR(6),
  father_name VARCHAR(120), spouse_name VARCHAR(120),
  address VARCHAR(255), city VARCHAR(80), state VARCHAR(80), pincode VARCHAR(10),
  emergency_name VARCHAR(120), emergency_relation VARCHAR(60), emergency_phone VARCHAR(20),
  joined_on DATE,
  confirmation_date DATE,
  probation_months TINYINT UNSIGNED DEFAULT 6,
  employment_type ENUM('full_time','part_time','contract','intern','consultant') DEFAULT 'full_time',
  status ENUM('active','on_probation','on_notice','resigned','terminated','exited','onboarding') DEFAULT 'onboarding',
  department_id BIGINT UNSIGNED NULL,
  designation_id BIGINT UNSIGNED NULL,
  grade_id BIGINT UNSIGNED NULL,
  location_id BIGINT UNSIGNED NULL,
  cost_center_id BIGINT UNSIGNED NULL,
  shift_id BIGINT UNSIGNED NULL,
  manager_id BIGINT UNSIGNED NULL,
  reporting_head_id BIGINT UNSIGNED NULL,
  work_mode ENUM('office','hybrid','remote') DEFAULT 'office',
  -- Statutory & payroll identifiers (encrypted at rest by app layer for sensitive ones)
  pan_enc VARBINARY(255), aadhaar_enc VARBINARY(512), uan VARCHAR(20), esic_no VARCHAR(30),
  bank_name VARCHAR(120), bank_account_enc VARBINARY(255), ifsc VARCHAR(15),
  tax_regime ENUM('new','old') DEFAULT 'new',
  -- encrypted PAN (enc), plain PAN PAN
  pan_plain VARCHAR(20) NULL,
  profile_photo VARCHAR(255),
  custom_values JSON,                          -- {fieldKey: value}
  exit_date DATE NULL,
  exit_reason VARCHAR(255) NULL,
  rehire_eligible TINYINT(1) DEFAULT 1,
  created_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at TIMESTAMP NULL,
  UNIQUE KEY uq_emp_code (tenant_id, employee_code),
  UNIQUE KEY uq_emp_email (tenant_id, email),
  KEY idx_emp_dept (tenant_id, department_id),
  KEY idx_emp_manager (manager_id),
  KEY idx_emp_status (tenant_id, status)
);

CREATE TABLE IF NOT EXISTS employee_timeline (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  employee_id BIGINT UNSIGNED NOT NULL,
  event_type VARCHAR(60) NOT NULL,             -- joined, confirmation, transfer, promotion, salary_revision, manager_change, status_change, exit
  title VARCHAR(190) NOT NULL,
  details JSON,
  event_date DATE NOT NULL,
  created_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY idx_tl_emp (employee_id, event_date)
);

CREATE TABLE IF NOT EXISTS employee_custom_fields (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  field_key VARCHAR(60) NOT NULL,
  label VARCHAR(120) NOT NULL,
  ftype ENUM('text','number','date','select','boolean') DEFAULT 'text',
  options JSON,                                -- for select
  required TINYINT(1) DEFAULT 0,
  visible_to VARCHAR(40) DEFAULT 'admin',      -- admin | manager | all
  UNIQUE KEY uq_cf (tenant_id, field_key)
);

CREATE TABLE IF NOT EXISTS employee_documents (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  employee_id BIGINT UNSIGNED NOT NULL,
  doc_type VARCHAR(60) NOT NULL,               -- offer_letter, id_proof, qualification, certification, other
  name VARCHAR(190) NOT NULL,
  file_path VARCHAR(255) NOT NULL,
  mime_type VARCHAR(100),
  size_bytes INT UNSIGNED,
  issued_on DATE NULL,
  expires_on DATE NULL,
  verification_status ENUM('pending','verified','rejected') DEFAULT 'pending',
  uploaded_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY idx_edoc_emp (employee_id),
  KEY idx_edoc_expiry (tenant_id, expires_on)
);

CREATE TABLE IF NOT EXISTS company_documents (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  title VARCHAR(190) NOT NULL,
  category VARCHAR(60) DEFAULT 'policy',
  description TEXT,
  file_path VARCHAR(255),
  version VARCHAR(20) DEFAULT '1.0',
  requires_ack TINYINT(1) DEFAULT 0,
  published_at DATETIME NULL,
  created_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS document_acknowledgements (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  document_id BIGINT UNSIGNED NOT NULL,
  employee_id BIGINT UNSIGNED NOT NULL,
  acknowledged_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_ack (document_id, employee_id)
);

CREATE TABLE IF NOT EXISTS letter_templates (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(120) NOT NULL,
  ltype VARCHAR(60) NOT NULL,                  -- offer, appointment, confirmation, promotion, increment, experience, relieving, warning, custom
  subject VARCHAR(190),
  body TEXT NOT NULL,                          -- supports {{merge_fields}}
  active TINYINT(1) DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS generated_letters (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  employee_id BIGINT UNSIGNED NOT NULL,
  template_id BIGINT UNSIGNED NOT NULL,
  ltype VARCHAR(60),
  title VARCHAR(190),
  content TEXT,
  pdf_path VARCHAR(255),
  generated_by BIGINT UNSIGNED NULL,
  generated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ---------- Attendance ----------
CREATE TABLE IF NOT EXISTS attendance_records (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  employee_id BIGINT UNSIGNED NOT NULL,
  adate DATE NOT NULL,
  shift_id BIGINT UNSIGNED NULL,
  first_in DATETIME NULL,
  last_out DATETIME NULL,
  punches JSON,                                -- [{in: 'ISO', out: 'ISO', source}]
  worked_minutes INT UNSIGNED DEFAULT 0,
  late_minutes INT UNSIGNED DEFAULT 0,
  early_out_minutes INT UNSIGNED DEFAULT 0,
  overtime_minutes INT UNSIGNED DEFAULT 0,
  status ENUM('present','absent','half_day','on_leave','holiday','week_off','not_marked','missed_punch') DEFAULT 'not_marked',
  source ENUM('web','biometric','import','api','system') DEFAULT 'web',
  is_regularized TINYINT(1) DEFAULT 0,
  notes VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_att (tenant_id, employee_id, adate),
  KEY idx_att_date (tenant_id, adate)
);

CREATE TABLE IF NOT EXISTS attendance_regularizations (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  employee_id BIGINT UNSIGNED NOT NULL,
  adate DATE NOT NULL,
  requested_in DATETIME NULL,
  requested_out DATETIME NULL,
  reason VARCHAR(255) NOT NULL,
  status ENUM('pending','approved','rejected','cancelled') DEFAULT 'pending',
  approver_id BIGINT UNSIGNED NULL,
  approver_comment VARCHAR(255),
  actioned_at DATETIME NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY idx_reg_status (tenant_id, status)
);

CREATE TABLE IF NOT EXISTS attendance_locks (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  period_year SMALLINT UNSIGNED NOT NULL,
  period_month TINYINT UNSIGNED NOT NULL,
  locked_by BIGINT UNSIGNED NULL,
  locked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_alock (tenant_id, period_year, period_month)
);

CREATE TABLE IF NOT EXISTS attendance_imports (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  file_name VARCHAR(190),
  imported_by BIGINT UNSIGNED NULL,
  total_rows INT UNSIGNED DEFAULT 0,
  success_rows INT UNSIGNED DEFAULT 0,
  error_rows INT UNSIGNED DEFAULT 0,
  error_report JSON,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ---------- Leave ----------
CREATE TABLE IF NOT EXISTS leave_types (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(80) NOT NULL,
  code VARCHAR(20) NOT NULL,
  unit ENUM('day','half_day','hour') DEFAULT 'day',
  is_paid TINYINT(1) DEFAULT 1,
  accrual_method ENUM('none','monthly','yearly','on_joining') DEFAULT 'monthly',
  accrual_count DECIMAL(5,2) DEFAULT 0,        -- days per accrual period
  annual_quota DECIMAL(5,2) DEFAULT 0,
  max_carry_forward DECIMAL(5,2) DEFAULT 0,
  carry_forward_expiry_months TINYINT UNSIGNED DEFAULT 0,  -- 0 = never expires
  encashable TINYINT(1) DEFAULT 0,
  negative_balance_allowed TINYINT(1) DEFAULT 0,
  min_notice_days INT UNSIGNED DEFAULT 0,
  max_consecutive_days INT UNSIGNED DEFAULT 0, -- 0 = unlimited
  applicable_gender ENUM('all','male','female') DEFAULT 'all',
  proof_required_after_days INT UNSIGNED DEFAULT 3,
  sandwich_rule ENUM('none','include_holidays','exclude_holidays') DEFAULT 'none',
  requires_approval TINYINT(1) DEFAULT 1,
  active TINYINT(1) DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_lt (tenant_id, code)
);

CREATE TABLE IF NOT EXISTS leave_balances (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  employee_id BIGINT UNSIGNED NOT NULL,
  leave_type_id BIGINT UNSIGNED NOT NULL,
  year SMALLINT UNSIGNED NOT NULL,
  opening DECIMAL(6,2) DEFAULT 0,
  accrued DECIMAL(6,2) DEFAULT 0,
  used DECIMAL(6,2) DEFAULT 0,
  carry_forwarded DECIMAL(6,2) DEFAULT 0,
  encashed DECIMAL(6,2) DEFAULT 0,
  lapsed DECIMAL(6,2) DEFAULT 0,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_lb (employee_id, leave_type_id, year)
);

CREATE TABLE IF NOT EXISTS leave_requests (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  employee_id BIGINT UNSIGNED NOT NULL,
  leave_type_id BIGINT UNSIGNED NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  days DECIMAL(5,2) NOT NULL DEFAULT 1,
  day_part ENUM('full','first_half','second_half') DEFAULT 'full',
  reason VARCHAR(500),
  contact_during_leave VARCHAR(120),
  handover_to BIGINT UNSIGNED NULL,
  day_breakdown JSON,                          -- [{date, value:1|0.5|0, kind:'working'|'holiday'|'week_off'}]
  status ENUM('pending','approved','rejected','cancelled','withdrawn') DEFAULT 'pending',
  approver_id BIGINT UNSIGNED NULL,
  approver_comment VARCHAR(255),
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  actioned_at DATETIME NULL,
  cancel_requested TINYINT(1) DEFAULT 0,
  KEY idx_lr_status (tenant_id, status),
  KEY idx_lr_emp (employee_id, start_date)
);

-- ---------- Payroll ----------
CREATE TABLE IF NOT EXISTS salary_components (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(120) NOT NULL,
  code VARCHAR(30) NOT NULL,
  ctype ENUM('earning','deduction','employer_contribution','reimbursement') NOT NULL,
  calc_type ENUM('fixed','formula','attendance_based','statutory') DEFAULT 'fixed',
  formula VARCHAR(500) NULL,                   -- safe expression; vars: BASIC, GROSS, PAYABLE_DAYS, MONTH_DAYS, LOP_DAYS, CTC_MONTHLY
  taxable TINYINT(1) DEFAULT 1,
  prorated TINYINT(1) DEFAULT 1,               -- prorate on LOP
  part_of_gross TINYINT(1) DEFAULT 1,
  is_statutory_code VARCHAR(20) NULL,          -- 'PF_EMPLOYEE','PF_EMPLOYER','ESI_EMPLOYEE','ESI_EMPLOYER','PT','TDS','LWF'
  display_order INT UNSIGNED DEFAULT 0,
  active TINYINT(1) DEFAULT 1,
  UNIQUE KEY uq_sc (tenant_id, code)
);

CREATE TABLE IF NOT EXISTS salary_structures (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(120) NOT NULL,
  description VARCHAR(255),
  active TINYINT(1) DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_ss (tenant_id, name)
);

CREATE TABLE IF NOT EXISTS salary_structure_items (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  structure_id BIGINT UNSIGNED NOT NULL,
  component_id BIGINT UNSIGNED NOT NULL,
  amount DECIMAL(12,2) NULL,                   -- fixed monthly amount if formula NULL
  formula VARCHAR(500) NULL,                   -- e.g. "BASIC * 0.40"
  UNIQUE KEY uq_ssi (structure_id, component_id)
);

CREATE TABLE IF NOT EXISTS employee_salaries (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  employee_id BIGINT UNSIGNED NOT NULL,
  structure_id BIGINT UNSIGNED NULL,
  ctc_annual DECIMAL(12,2) DEFAULT 0,
  gross_monthly DECIMAL(12,2) DEFAULT 0,
  items JSON NOT NULL,                         -- [{code, name, type, calcType, amount, formula, taxable, prorated}]
  effective_from DATE NOT NULL,
  effective_to DATE NULL,
  revision_reason VARCHAR(190),
  created_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY idx_es_emp (employee_id, effective_from)
);

CREATE TABLE IF NOT EXISTS payroll_runs (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  period_year SMALLINT UNSIGNED NOT NULL,
  period_month TINYINT UNSIGNED NOT NULL,
  pay_date DATE NULL,
  status ENUM('draft','calculated','submitted','approved','locked','paid','cancelled') DEFAULT 'draft',
  month_days INT UNSIGNED DEFAULT 30,
  totals JSON,                                 -- {gross, net, totalDeductions, employerCost, headcount}
  exceptions JSON,                             -- [{employeeId, code, message}]
  notes VARCHAR(255),
  calculated_by BIGINT UNSIGNED NULL, calculated_at DATETIME NULL,
  submitted_by BIGINT UNSIGNED NULL, submitted_at DATETIME NULL,
  approved_by BIGINT UNSIGNED NULL, approved_at DATETIME NULL,
  locked_by BIGINT UNSIGNED NULL, locked_at DATETIME NULL,
  paid_at DATETIME NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_pr (tenant_id, period_year, period_month)
);

CREATE TABLE IF NOT EXISTS payroll_items (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  run_id BIGINT UNSIGNED NOT NULL,
  employee_id BIGINT UNSIGNED NOT NULL,
  month_days DECIMAL(5,2) DEFAULT 30,
  payable_days DECIMAL(5,2) DEFAULT 30,
  lop_days DECIMAL(5,2) DEFAULT 0,
  earnings JSON,                               -- [{code,name,amount}]
  deductions JSON,
  reimbursements JSON,                          -- [{code,name,amount,expenseClaimId}] (added to net, not gross)
  adjustments JSON,                             -- [{code,name,amount,direction,adjustmentId,atype}] (arrears/back-pay/bonus/F&F)
  employer_contrib JSON,
  gross DECIMAL(12,2) DEFAULT 0,
  total_deductions DECIMAL(12,2) DEFAULT 0,
  reimbursements_total DECIMAL(12,2) DEFAULT 0,
  adjustments_total DECIMAL(12,2) DEFAULT 0,
  net_pay DECIMAL(12,2) DEFAULT 0,
  employer_cost DECIMAL(12,2) DEFAULT 0,
  inputs_snapshot JSON,                        -- attendance/leave/loan inputs used (for reproducibility)
  remarks VARCHAR(255),
  UNIQUE KEY uq_pi (run_id, employee_id),
  KEY idx_pi_emp (employee_id)
);

-- Arrears, back-pay, corrections, bonus & F&F settlements.
-- Locked/paid payroll is immutable, so every post-lock correction is booked here and
-- consumed by the next calculation. Approved + not-yet-applied rows are picked up automatically.
CREATE TABLE IF NOT EXISTS payroll_adjustments (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  employee_id BIGINT UNSIGNED NOT NULL,
  atype ENUM('arrears','back_pay','correction','bonus','reimbursement','deduction','fnf','other') NOT NULL DEFAULT 'other',
  direction ENUM('earning','deduction') NOT NULL DEFAULT 'earning',
  component VARCHAR(60) NOT NULL,              -- payslip line code
  description VARCHAR(255),
  amount DECIMAL(12,2) NOT NULL,
  for_period_year SMALLINT UNSIGNED NULL,      -- period being corrected (informational)
  for_period_month TINYINT UNSIGNED NULL,
  original_run_id BIGINT UNSIGNED NULL,        -- locked/paid run being corrected
  source_type VARCHAR(40) NULL,                -- manual | bonus_award | fnf_item | expense_claim
  source_id BIGINT UNSIGNED NULL,
  status ENUM('draft','submitted','approved','rejected','applied') DEFAULT 'draft',
  reason VARCHAR(500),
  requested_by BIGINT UNSIGNED NULL, requested_at DATETIME NULL,
  actioned_by BIGINT UNSIGNED NULL, actioned_at DATETIME NULL,
  actioned_comment VARCHAR(255),
  applied_run_id BIGINT UNSIGNED NULL, applied_at DATETIME NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_pa_source (source_type, source_id),
  KEY idx_pa_emp (tenant_id, employee_id, status),
  KEY idx_pa_run (original_run_id),
  KEY idx_pa_pending (tenant_id, status, for_period_year, for_period_month)
);

CREATE TABLE IF NOT EXISTS payslips (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  run_id BIGINT UNSIGNED NOT NULL,
  payroll_item_id BIGINT UNSIGNED NOT NULL,
  employee_id BIGINT UNSIGNED NOT NULL,
  pdf_path VARCHAR(255) NULL,
  published_at DATETIME NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_ps (payroll_item_id)
);

CREATE TABLE IF NOT EXISTS statutory_rules (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  rule_type VARCHAR(20) NOT NULL,              -- PF, ESI, PT, TDS, LWF
  jurisdiction VARCHAR(60) DEFAULT 'IN',       -- state code for PT
  effective_from DATE NOT NULL,
  effective_to DATE NULL,
  version VARCHAR(30) NOT NULL,
  params JSON NOT NULL,
  notes VARCHAR(255),
  created_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY idx_sr (tenant_id, rule_type, effective_from)
);

CREATE TABLE IF NOT EXISTS tax_declarations (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  employee_id BIGINT UNSIGNED NOT NULL,
  financial_year VARCHAR(10) NOT NULL,         -- "2026-27"
  regime ENUM('new','old') DEFAULT 'new',
  sections JSON,                               -- {ded80c: 150000, ded80d: 25000, hra_exempt: ...}
  status ENUM('draft','submitted','under_review','approved','rejected') DEFAULT 'draft',
  reviewer_id BIGINT UNSIGNED NULL, review_comment VARCHAR(255),
  submitted_at DATETIME NULL,
  UNIQUE KEY uq_td (employee_id, financial_year)
);

-- ---------- Expenses & Loans ----------
CREATE TABLE IF NOT EXISTS expense_categories (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(80) NOT NULL,
  monthly_limit DECIMAL(10,2) NULL,
  receipt_required_above DECIMAL(10,2) NULL,
  active TINYINT(1) DEFAULT 1
);

CREATE TABLE IF NOT EXISTS expense_claims (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  employee_id BIGINT UNSIGNED NOT NULL,
  category_id BIGINT UNSIGNED NOT NULL,
  title VARCHAR(190) NOT NULL,
  expense_date DATE NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  tax_amount DECIMAL(10,2) DEFAULT 0,
  description VARCHAR(500),
  receipt_path VARCHAR(255),
  status ENUM('draft','submitted','approved','rejected','reimbursed','cancelled') DEFAULT 'draft',
  approver_id BIGINT UNSIGNED NULL, approver_comment VARCHAR(255), actioned_at DATETIME NULL,
  reimbursed_run_id BIGINT UNSIGNED NULL,
  submitted_at DATETIME NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY idx_ec_status (tenant_id, status)
);

CREATE TABLE IF NOT EXISTS loans (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  employee_id BIGINT UNSIGNED NOT NULL,
  ltype ENUM('loan','advance') DEFAULT 'loan',
  title VARCHAR(120),
  principal DECIMAL(12,2) NOT NULL,
  interest_rate DECIMAL(5,2) DEFAULT 0,
  tenure_months INT UNSIGNED NOT NULL DEFAULT 1,
  emi_amount DECIMAL(12,2) NOT NULL,
  start_month TINYINT UNSIGNED NOT NULL,
  start_year SMALLINT UNSIGNED NOT NULL,
  outstanding DECIMAL(12,2) NOT NULL,
  status ENUM('pending','active','paused','closed','rejected') DEFAULT 'pending',
  disbursed_on DATE NULL,
  notes VARCHAR(255),
  created_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY idx_loan_emp (employee_id)
);

CREATE TABLE IF NOT EXISTS loan_installments (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  loan_id BIGINT UNSIGNED NOT NULL,
  tenant_id BIGINT UNSIGNED NOT NULL,
  installment_no INT UNSIGNED NOT NULL,
  due_month TINYINT UNSIGNED NOT NULL,
  due_year SMALLINT UNSIGNED NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  status ENUM('pending','deducted','skipped') DEFAULT 'pending',
  payroll_run_id BIGINT UNSIGNED NULL,
  paid_at DATETIME NULL,
  UNIQUE KEY uq_li (loan_id, installment_no)
);

-- ---------- Performance ----------
CREATE TABLE IF NOT EXISTS performance_cycles (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(120) NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  review_type ENUM('annual','half_yearly','quarterly','probation') DEFAULT 'annual',
  status ENUM('draft','active','closed') DEFAULT 'draft',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS goals (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  employee_id BIGINT UNSIGNED NOT NULL,
  cycle_id BIGINT UNSIGNED NULL,
  title VARCHAR(190) NOT NULL,
  description TEXT,
  kpi VARCHAR(190),
  weightage DECIMAL(5,2) DEFAULT 0,
  target VARCHAR(120),
  due_date DATE NULL,
  progress TINYINT UNSIGNED DEFAULT 0,         -- 0-100
  status ENUM('draft','active','completed','closed') DEFAULT 'draft',
  manager_comment VARCHAR(255),
  created_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS reviews (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  cycle_id BIGINT UNSIGNED NOT NULL,
  employee_id BIGINT UNSIGNED NOT NULL,
  self_rating DECIMAL(3,1) NULL,
  self_comments TEXT,
  manager_rating DECIMAL(3,1) NULL,
  manager_comments TEXT,
  final_rating DECIMAL(3,1) NULL,
  status ENUM('not_started','self_review','manager_review','calibrated','completed') DEFAULT 'not_started',
  UNIQUE KEY uq_review (cycle_id, employee_id)
);

-- ---------- Recruitment ----------
CREATE TABLE IF NOT EXISTS requisitions (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  rcode VARCHAR(30),
  title VARCHAR(190) NOT NULL,
  department_id BIGINT UNSIGNED NULL,
  location_id BIGINT UNSIGNED NULL,
  openings INT UNSIGNED DEFAULT 1,
  employment_type VARCHAR(30) DEFAULT 'full_time',
  min_experience DECIMAL(4,1) DEFAULT 0,
  max_experience DECIMAL(4,1) NULL,
  budget_ctc DECIMAL(12,2) NULL,
  description TEXT,
  hiring_manager_id BIGINT UNSIGNED NULL,
  status ENUM('draft','pending_approval','approved','open','on_hold','closed','cancelled') DEFAULT 'draft',
  published TINYINT(1) DEFAULT 0,
  created_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS candidates (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  requisition_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(120) NOT NULL,
  email VARCHAR(190), phone VARCHAR(20),
  source VARCHAR(60) DEFAULT 'direct',
  resume_path VARCHAR(255),
  experience_years DECIMAL(4,1) DEFAULT 0,
  current_company VARCHAR(120),
  expected_ctc DECIMAL(12,2) NULL,
  stage ENUM('applied','screening','interview','offer','hired','rejected','on_hold') DEFAULT 'applied',
  rating TINYINT UNSIGNED NULL,
  notes TEXT,
  applied_on TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY idx_cand_stage (tenant_id, stage)
);

CREATE TABLE IF NOT EXISTS interviews (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  candidate_id BIGINT UNSIGNED NOT NULL,
  round_name VARCHAR(80) NOT NULL,
  scheduled_at DATETIME NOT NULL,
  mode VARCHAR(40) DEFAULT 'video',
  interviewer_id BIGINT UNSIGNED NULL,
  score DECIMAL(4,1) NULL,
  feedback TEXT,
  result ENUM('pending','selected','rejected','on_hold') DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS offers (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  candidate_id BIGINT UNSIGNED NOT NULL,
  designation VARCHAR(120),
  ctc_annual DECIMAL(12,2),
  joining_date DATE,
  status ENUM('draft','sent','accepted','rejected','expired') DEFAULT 'draft',
  letter_id BIGINT UNSIGNED NULL,
  sent_at DATETIME NULL, responded_at DATETIME NULL,
  created_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ---------- Assets ----------
CREATE TABLE IF NOT EXISTS assets (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  asset_code VARCHAR(40) NOT NULL,
  name VARCHAR(120) NOT NULL,
  category VARCHAR(60) DEFAULT 'laptop',
  serial_no VARCHAR(120),
  brand VARCHAR(80), model VARCHAR(80),
  purchase_date DATE NULL, purchase_value DECIMAL(12,2) NULL,
  status ENUM('available','assigned','repair','retired','lost') DEFAULT 'available',
  location_id BIGINT UNSIGNED NULL,
  notes VARCHAR(255),
  UNIQUE KEY uq_asset (tenant_id, asset_code)
);

CREATE TABLE IF NOT EXISTS asset_assignments (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  asset_id BIGINT UNSIGNED NOT NULL,
  employee_id BIGINT UNSIGNED NOT NULL,
  assigned_on DATE NOT NULL,
  due_return_on DATE NULL,
  returned_on DATE NULL,
  condition_on_issue VARCHAR(120),
  condition_on_return VARCHAR(120),
  status ENUM('assigned','returned','overdue') DEFAULT 'assigned',
  notes VARCHAR(255),
  assigned_by BIGINT UNSIGNED NULL
);

-- ---------- Helpdesk ----------
CREATE TABLE IF NOT EXISTS tickets (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  ticket_no VARCHAR(30) NOT NULL,
  employee_id BIGINT UNSIGNED NOT NULL,
  category VARCHAR(60) DEFAULT 'general',      -- hr, payroll, it, admin, general
  subject VARCHAR(190) NOT NULL,
  description TEXT,
  priority ENUM('low','medium','high','urgent') DEFAULT 'medium',
  status ENUM('open','in_progress','resolved','closed','reopened') DEFAULT 'open',
  assignee_id BIGINT UNSIGNED NULL,
  sla_hours INT UNSIGNED DEFAULT 48,
  sla_due_at DATETIME NULL,
  resolved_at DATETIME NULL,
  rating TINYINT UNSIGNED NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_ticket (tenant_id, ticket_no)
);

CREATE TABLE IF NOT EXISTS ticket_comments (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  ticket_id BIGINT UNSIGNED NOT NULL,
  author_id BIGINT UNSIGNED NOT NULL,
  comment TEXT NOT NULL,
  is_internal TINYINT(1) DEFAULT 0,
  attachment VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ---------- Lifecycle: announcements, onboarding, separation ----------
CREATE TABLE IF NOT EXISTS announcements (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  title VARCHAR(190) NOT NULL,
  body TEXT NOT NULL,
  audience ENUM('all','department','location') DEFAULT 'all',
  department_id BIGINT UNSIGNED NULL,
  location_id BIGINT UNSIGNED NULL,
  publish_from DATE NULL, publish_to DATE NULL,
  pinned TINYINT(1) DEFAULT 0,
  created_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS onboarding_tasks (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  employee_id BIGINT UNSIGNED NOT NULL,
  title VARCHAR(190) NOT NULL,
  description VARCHAR(500),
  category VARCHAR(60) DEFAULT 'general',      -- document, asset, induction, it_setup, policy, payroll
  assignee_role ENUM('employee','manager','hr','it','admin') DEFAULT 'hr',
  due_date DATE NULL,
  status ENUM('pending','in_progress','completed','skipped') DEFAULT 'pending',
  completed_at DATETIME NULL,
  completed_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY idx_ob_emp (employee_id, status)
);

CREATE TABLE IF NOT EXISTS separations (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  employee_id BIGINT UNSIGNED NOT NULL,
  sep_type ENUM('resignation','termination','contract_end') DEFAULT 'resignation',
  requested_on DATE NOT NULL,
  last_working_day DATE NOT NULL,
  notice_days INT UNSIGNED DEFAULT 30,
  reason VARCHAR(500),
  status ENUM('requested','approved','rejected','in_notice','clearance','fnf_pending','completed','withdrawn') DEFAULT 'requested',
  approver_id BIGINT UNSIGNED NULL, approver_comment VARCHAR(255), actioned_at DATETIME NULL,
  exit_interview_notes TEXT,
  fnf_status ENUM('pending','calculated','paid') NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS fnf_items (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NULL,               -- backfilled from separations for existing rows
  separation_id BIGINT UNSIGNED NOT NULL,
  component VARCHAR(120) NOT NULL,             -- Leave encashment, Notice pay recovery, Gratuity...
  ftype ENUM('payment','recovery') DEFAULT 'payment',
  amount DECIMAL(12,2) NOT NULL,
  remarks VARCHAR(255),
  KEY idx_fnf_sep (separation_id)
);

CREATE TABLE IF NOT EXISTS clearances (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  separation_id BIGINT UNSIGNED NOT NULL,
  department VARCHAR(40) NOT NULL,             -- IT, Admin, Finance, HR
  status ENUM('pending','cleared') DEFAULT 'pending',
  remarks VARCHAR(255),
  signoff_by BIGINT UNSIGNED NULL, signed_at DATETIME NULL,
  UNIQUE KEY uq_clr (separation_id, department)
);

-- ---------- Billing ----------
CREATE TABLE IF NOT EXISTS customers (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(190) NOT NULL,
  gstin VARCHAR(20),
  address VARCHAR(255), city VARCHAR(80), state VARCHAR(80), state_code VARCHAR(4), pincode VARCHAR(10),
  contact_name VARCHAR(120), email VARCHAR(190), phone VARCHAR(20),
  payment_terms_days INT UNSIGNED DEFAULT 30,
  status ENUM('active','inactive') DEFAULT 'active',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS invoices (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  customer_id BIGINT UNSIGNED NOT NULL,
  invoice_no VARCHAR(40) NOT NULL,
  invoice_date DATE NOT NULL,
  due_date DATE NOT NULL,
  period_label VARCHAR(60),
  subtotal DECIMAL(12,2) DEFAULT 0,
  discount DECIMAL(12,2) DEFAULT 0,
  cgst DECIMAL(12,2) DEFAULT 0,
  sgst DECIMAL(12,2) DEFAULT 0,
  igst DECIMAL(12,2) DEFAULT 0,
  total DECIMAL(12,2) DEFAULT 0,
  amount_paid DECIMAL(12,2) DEFAULT 0,
  place_of_supply VARCHAR(4),
  is_intra_state TINYINT(1) DEFAULT 1,
  notes VARCHAR(255),
  status ENUM('draft','sent','part_paid','paid','overdue','cancelled') DEFAULT 'draft',
  pdf_path VARCHAR(255),
  created_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_inv_no (tenant_id, invoice_no),
  KEY idx_inv_status (tenant_id, status)
);

CREATE TABLE IF NOT EXISTS invoice_items (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  invoice_id BIGINT UNSIGNED NOT NULL,
  description VARCHAR(255) NOT NULL,
  hsn_sac VARCHAR(20),
  quantity DECIMAL(10,2) DEFAULT 1,
  rate DECIMAL(12,2) NOT NULL,
  gst_rate DECIMAL(5,2) DEFAULT 18.00,
  amount DECIMAL(12,2) NOT NULL
);

CREATE TABLE IF NOT EXISTS invoice_payments (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  invoice_id BIGINT UNSIGNED NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  paid_on DATE NOT NULL,
  mode VARCHAR(40) DEFAULT 'bank_transfer',
  reference VARCHAR(120),
  notes VARCHAR(255),
  recorded_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ---------- Notifications ----------
CREATE TABLE IF NOT EXISTS notifications (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  ntype VARCHAR(60) NOT NULL,                  -- leave.submitted, payslip.published, ...
  title VARCHAR(190) NOT NULL,
  body VARCHAR(500),
  link VARCHAR(255),
  read_at DATETIME NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY idx_notif_user (user_id, read_at)
);

CREATE TABLE IF NOT EXISTS notification_prefs (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  event_key VARCHAR(60) NOT NULL,
  inapp_enabled TINYINT(1) DEFAULT 1,
  email_enabled TINYINT(1) DEFAULT 1,
  UNIQUE KEY uq_np (user_id, event_key)
);

CREATE TABLE IF NOT EXISTS delivery_logs (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NULL,
  event_key VARCHAR(60),
  channel ENUM('inapp','email','sms','whatsapp') DEFAULT 'email',
  recipient VARCHAR(190),
  subject VARCHAR(190),
  status ENUM('queued','sent','failed','skipped') DEFAULT 'queued',
  error VARCHAR(500),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY idx_dl_time (created_at)
);

-- ============================================================
-- v2 EXPANSION — spec 2.0 (September 2026)
-- ============================================================

-- ---------- Extended org masters ----------
CREATE TABLE IF NOT EXISTS legal_entities (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(190) NOT NULL,
  code VARCHAR(30),
  entity_type ENUM('company','llp','partnership','proprietorship') DEFAULT 'company',
  cin VARCHAR(40), pan VARCHAR(20), gstin VARCHAR(20),
  address VARCHAR(255), city VARCHAR(80), state VARCHAR(80),
  status ENUM('active','inactive') DEFAULT 'active',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS business_units (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(120) NOT NULL,
  code VARCHAR(30),
  head_employee_id BIGINT UNSIGNED NULL,
  parent_id BIGINT UNSIGNED NULL,
  status ENUM('active','inactive') DEFAULT 'active',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS job_levels (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(80) NOT NULL,
  level INT UNSIGNED DEFAULT 1,
  description VARCHAR(255),
  status ENUM('active','inactive') DEFAULT 'active'
);

-- ---------- Career & Talent ----------
CREATE TABLE IF NOT EXISTS skills (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(120) NOT NULL,
  category VARCHAR(60),
  status ENUM('active','inactive') DEFAULT 'active',
  UNIQUE KEY uq_skill (tenant_id, name)
);

CREATE TABLE IF NOT EXISTS employee_skills (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  employee_id BIGINT UNSIGNED NOT NULL,
  skill_id BIGINT UNSIGNED NOT NULL,
  proficiency ENUM('beginner','intermediate','advanced','expert') DEFAULT 'intermediate',
  years_experience DECIMAL(4,1) DEFAULT 0,
  verified TINYINT(1) DEFAULT 0,
  notes VARCHAR(255),
  UNIQUE KEY uq_emp_skill (tenant_id, employee_id, skill_id)
);

CREATE TABLE IF NOT EXISTS career_paths (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(160) NOT NULL,
  track ENUM('technical','management','specialist','leadership') DEFAULT 'technical',
  from_designation_id BIGINT UNSIGNED NULL,
  to_designation_id BIGINT UNSIGNED NULL,
  steps JSON,                                  -- [{order, title, description, competency}]
  description VARCHAR(500),
  status ENUM('active','inactive') DEFAULT 'active',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS development_plans (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  employee_id BIGINT UNSIGNED NOT NULL,
  title VARCHAR(190) NOT NULL,
  description VARCHAR(500),
  mentor_id BIGINT UNSIGNED NULL,
  start_date DATE,
  target_date DATE,
  progress TINYINT UNSIGNED DEFAULT 0,         -- 0-100
  status ENUM('draft','active','completed','cancelled') DEFAULT 'active',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS talent_pools (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(160) NOT NULL,
  description VARCHAR(500),
  status ENUM('active','inactive') DEFAULT 'active',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS talent_pool_members (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  pool_id BIGINT UNSIGNED NOT NULL,
  employee_id BIGINT UNSIGNED NULL,
  candidate_id BIGINT UNSIGNED NULL,
  notes VARCHAR(255),
  added_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_pool_emp (pool_id, employee_id, candidate_id)
);

CREATE TABLE IF NOT EXISTS succession_plans (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  position_title VARCHAR(160) NOT NULL,
  employee_id BIGINT UNSIGNED NULL,            -- incumbent
  criticality ENUM('low','medium','high','critical') DEFAULT 'medium',
  risk ENUM('low','medium','high') DEFAULT 'medium',
  successor_employee_id BIGINT UNSIGNED NULL,
  readiness ENUM('ready_now','ready_1_2_years','ready_3_5_years','not_ready') DEFAULT 'ready_1_2_years',
  development_actions VARCHAR(500),
  notes VARCHAR(500),
  status ENUM('draft','active','closed') DEFAULT 'active',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ---------- Compensation ----------
CREATE TABLE IF NOT EXISTS salary_bands (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(120) NOT NULL,
  grade_id BIGINT UNSIGNED NULL,
  currency VARCHAR(8) DEFAULT 'INR',
  min_amount DECIMAL(12,2) DEFAULT 0,
  mid_amount DECIMAL(12,2) DEFAULT 0,
  max_amount DECIMAL(12,2) DEFAULT 0,
  effective_from DATE,
  status ENUM('active','inactive') DEFAULT 'active',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS comp_cycles (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(160) NOT NULL,
  cycle_year INT UNSIGNED NOT NULL,
  effective_date DATE,
  increment_budget_pct DECIMAL(5,2) DEFAULT 10,
  status ENUM('draft','active','closed') DEFAULT 'draft',
  created_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS comp_reviews (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  cycle_id BIGINT UNSIGNED NOT NULL,
  employee_id BIGINT UNSIGNED NOT NULL,
  current_ctc DECIMAL(12,2) DEFAULT 0,
  proposed_increment_pct DECIMAL(5,2) DEFAULT 0,
  proposed_bonus DECIMAL(12,2) DEFAULT 0,
  promotion_flag TINYINT(1) DEFAULT 0,
  new_designation_id BIGINT UNSIGNED NULL,
  new_ctc DECIMAL(12,2) DEFAULT 0,
  justification VARCHAR(500),
  status ENUM('pending','approved','rejected','applied') DEFAULT 'pending',
  decided_by BIGINT UNSIGNED NULL, decided_at DATETIME NULL,
  UNIQUE KEY uq_comp_review (cycle_id, employee_id)
);

CREATE TABLE IF NOT EXISTS bonus_plans (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(160) NOT NULL,
  plan_year INT UNSIGNED NOT NULL,
  btype ENUM('performance','festival','incentive','retention','referral') DEFAULT 'performance',
  budget DECIMAL(14,2) DEFAULT 0,
  status ENUM('draft','active','closed','paid') DEFAULT 'draft',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS bonus_awards (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  plan_id BIGINT UNSIGNED NOT NULL,
  employee_id BIGINT UNSIGNED NOT NULL,
  amount DECIMAL(12,2) DEFAULT 0,
  pct_of_ctc DECIMAL(5,2) DEFAULT 0,
  reason VARCHAR(500),
  status ENUM('proposed','approved','paid') DEFAULT 'proposed',
  UNIQUE KEY uq_bonus_award (plan_id, employee_id)
);

-- ---------- Benefits ----------
CREATE TABLE IF NOT EXISTS benefit_plans (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(160) NOT NULL,
  btype ENUM('insurance','allowance','wellness','retirement','other') DEFAULT 'insurance',
  provider VARCHAR(160),
  description VARCHAR(500),
  eligibility JSON,                            -- {employmentTypes:[], grades:[], minTenureMonths:0}
  employer_cost DECIMAL(12,2) DEFAULT 0,
  employee_cost DECIMAL(12,2) DEFAULT 0,
  effective_from DATE,
  status ENUM('active','inactive') DEFAULT 'active',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS benefit_enrollments (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  plan_id BIGINT UNSIGNED NOT NULL,
  employee_id BIGINT UNSIGNED NOT NULL,
  nominee_name VARCHAR(120),
  nominee_relation VARCHAR(40),
  nominee_dob DATE NULL,
  coverage_details JSON,                       -- {sumInsured, policyNo, members:[...]}
  enrolled_on DATE,
  status ENUM('active','waived','closed') DEFAULT 'active',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_benroll (plan_id, employee_id)
);

-- ---------- Engagement ----------
CREATE TABLE IF NOT EXISTS surveys (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  title VARCHAR(190) NOT NULL,
  description VARCHAR(500),
  stype ENUM('annual','pulse','onboarding','exit') DEFAULT 'pulse',
  anonymity ENUM('anonymous','named') DEFAULT 'anonymous',
  questions JSON NOT NULL,                     -- [{id, text, type: rating|text|choice, options:[]}]
  start_date DATE, end_date DATE,
  status ENUM('draft','active','closed') DEFAULT 'draft',
  created_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS survey_responses (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  survey_id BIGINT UNSIGNED NOT NULL,
  employee_id BIGINT UNSIGNED NULL,            -- NULL when anonymous
  answers JSON NOT NULL,                       -- [{qid, value}]
  submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS polls (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  question VARCHAR(255) NOT NULL,
  options JSON NOT NULL,                       -- ["Yes","No"]
  ends_at DATETIME NULL,
  status ENUM('active','closed') DEFAULT 'active',
  created_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS poll_votes (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  poll_id BIGINT UNSIGNED NOT NULL,
  employee_id BIGINT UNSIGNED NOT NULL,
  option_index TINYINT UNSIGNED NOT NULL,
  voted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_poll_vote (poll_id, employee_id)
);

CREATE TABLE IF NOT EXISTS recognitions (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  from_employee_id BIGINT UNSIGNED NOT NULL,
  to_employee_id BIGINT UNSIGNED NOT NULL,
  rtype ENUM('kudos','badge','reward') DEFAULT 'kudos',
  points INT UNSIGNED DEFAULT 0,
  message VARCHAR(500),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY idx_recog_to (tenant_id, to_employee_id)
);

CREATE TABLE IF NOT EXISTS suggestions (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  employee_id BIGINT UNSIGNED NULL,            -- NULL when anonymous
  category VARCHAR(60),
  subject VARCHAR(190) NOT NULL,
  body TEXT,
  status ENUM('submitted','reviewing','implemented','rejected') DEFAULT 'submitted',
  admin_notes VARCHAR(500),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- ---------- Employee Relations ----------
CREATE TABLE IF NOT EXISTS hr_cases (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  case_no VARCHAR(40) NOT NULL,
  employee_id BIGINT UNSIGNED NOT NULL,
  raised_by BIGINT UNSIGNED NULL,
  category ENUM('grievance','complaint','disciplinary','harassment','other') DEFAULT 'grievance',
  title VARCHAR(190) NOT NULL,
  description TEXT,
  severity ENUM('low','medium','high','critical') DEFAULT 'medium',
  status ENUM('open','investigating','resolved','closed') DEFAULT 'open',
  assigned_to BIGINT UNSIGNED NULL,
  resolution TEXT,
  resolution_date DATE NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_case_no (tenant_id, case_no)
);

CREATE TABLE IF NOT EXISTS hr_case_notes (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  case_id BIGINT UNSIGNED NOT NULL,
  author_id BIGINT UNSIGNED NOT NULL,
  note TEXT NOT NULL,
  visibility ENUM('internal','hr_only') DEFAULT 'internal',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS disciplinary_actions (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  case_id BIGINT UNSIGNED NULL,
  employee_id BIGINT UNSIGNED NOT NULL,
  action_type ENUM('verbal_warning','written_warning','show_cause','suspension','pip','termination') DEFAULT 'written_warning',
  reason TEXT,
  issued_by BIGINT UNSIGNED NULL,
  issued_on DATE,
  effective_from DATE NULL,
  acknowledged TINYINT(1) DEFAULT 0,
  acknowledged_at DATETIME NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ---------- Travel ----------
CREATE TABLE IF NOT EXISTS travel_requests (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  trno VARCHAR(40) NOT NULL,
  employee_id BIGINT UNSIGNED NOT NULL,
  purpose VARCHAR(255) NOT NULL,
  destination VARCHAR(160),
  start_date DATE, end_date DATE,
  estimated_cost DECIMAL(12,2) DEFAULT 0,
  travel_mode VARCHAR(60),
  status ENUM('pending','approved','rejected','completed','cancelled') DEFAULT 'pending',
  approver_id BIGINT UNSIGNED NULL, approver_comment VARCHAR(255), actioned_at DATETIME NULL,
  settlement_status ENUM('not_required','pending','settled') DEFAULT 'not_required',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_trno (tenant_id, trno)
);

CREATE TABLE IF NOT EXISTS travel_advances (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  request_id BIGINT UNSIGNED NOT NULL,
  employee_id BIGINT UNSIGNED NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  issued_on DATE NULL,
  status ENUM('requested','issued','adjusted') DEFAULT 'requested',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS travel_bookings (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  request_id BIGINT UNSIGNED NOT NULL,
  mode ENUM('flight','train','cab','hotel','bus') DEFAULT 'flight',
  provider VARCHAR(120),
  reference VARCHAR(120),
  booked_on DATE NULL,
  amount DECIMAL(12,2) DEFAULT 0,
  status ENUM('booked','cancelled') DEFAULT 'booked',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS travel_settlements (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  request_id BIGINT UNSIGNED NOT NULL,
  employee_id BIGINT UNSIGNED NOT NULL,
  amount_spent DECIMAL(12,2) DEFAULT 0,
  advance_adjusted DECIMAL(12,2) DEFAULT 0,
  payable DECIMAL(12,2) DEFAULT 0,
  status ENUM('submitted','approved','paid') DEFAULT 'submitted',
  approved_by BIGINT UNSIGNED NULL, settled_on DATE NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ---------- Workforce Planning ----------
CREATE TABLE IF NOT EXISTS headcount_plans (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  plan_year INT UNSIGNED NOT NULL,
  quarter TINYINT UNSIGNED DEFAULT 1,
  department_id BIGINT UNSIGNED NOT NULL,
  designation_id BIGINT UNSIGNED NULL,
  planned_count INT UNSIGNED DEFAULT 0,
  budget_ctc DECIMAL(14,2) DEFAULT 0,
  scenario VARCHAR(120) DEFAULT 'base',        -- base | aggressive | conservative
  notes VARCHAR(500),
  status ENUM('draft','active','closed') DEFAULT 'active',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_hcplan (tenant_id, plan_year, quarter, department_id, designation_id, scenario)
);

-- ---------- Timesheets ----------
CREATE TABLE IF NOT EXISTS projects (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(160) NOT NULL,
  code VARCHAR(30),
  client VARCHAR(160),
  billable TINYINT(1) DEFAULT 0,
  bill_rate DECIMAL(12,2) DEFAULT 0,          -- billing rate per billable hour (INR)
  cost_rate DECIMAL(12,2) DEFAULT 0,          -- internal cost per hour (INR)
  department_id BIGINT UNSIGNED NULL,
  default_project TINYINT(1) DEFAULT 0,       -- offered by default in the weekly grid
  status ENUM('active','inactive') DEFAULT 'active',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY idx_proj_tenant (tenant_id, status)
);

-- Planned allocation of an employee across projects (utilisation / capacity planning)
CREATE TABLE IF NOT EXISTS project_members (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  project_id BIGINT UNSIGNED NOT NULL,
  employee_id BIGINT UNSIGNED NOT NULL,
  allocation_pct DECIMAL(5,2) DEFAULT 0,      -- planned % of working time
  from_date DATE NULL,
  to_date DATE NULL,
  active TINYINT(1) DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_pm (project_id, employee_id),
  KEY idx_pm_emp (tenant_id, employee_id, active)
);

CREATE TABLE IF NOT EXISTS timesheets (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  employee_id BIGINT UNSIGNED NOT NULL,
  week_start DATE NOT NULL,
  entries JSON NOT NULL,                       -- legacy mirror; normalised rows live in timesheet_entries
  total_hours DECIMAL(6,2) DEFAULT 0,
  billable_hours DECIMAL(6,2) DEFAULT 0,
  non_billable_hours DECIMAL(6,2) DEFAULT 0,
  status ENUM('draft','submitted','approved','rejected') DEFAULT 'draft',
  locked TINYINT(1) DEFAULT 0,                 -- period-locked: no further edits/actions
  approver_id BIGINT UNSIGNED NULL, approver_comment VARCHAR(255), actioned_at DATETIME NULL,
  submitted_by BIGINT UNSIGNED NULL,
  submitted_at DATETIME NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_timesheet (tenant_id, employee_id, week_start),
  KEY idx_ts_status (tenant_id, status, week_start)
);

-- Normalised daily entries. This is the source of truth for totals & analytics.
CREATE TABLE IF NOT EXISTS timesheet_entries (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  timesheet_id BIGINT UNSIGNED NOT NULL,
  employee_id BIGINT UNSIGNED NOT NULL,
  entry_date DATE NOT NULL,
  project_id BIGINT UNSIGNED NULL,             -- NULL = internal / non-project time
  hours DECIMAL(5,2) NOT NULL DEFAULT 0,
  task VARCHAR(255),
  billable TINYINT(1) DEFAULT 0,
  source ENUM('manual','import','api') DEFAULT 'manual',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_te_sheet (timesheet_id),
  KEY idx_te_emp_date (tenant_id, employee_id, entry_date),
  KEY idx_te_project (tenant_id, project_id, entry_date)
);

-- ---------- Shift swaps & comp-off ----------
CREATE TABLE IF NOT EXISTS shift_swaps (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  employee_id BIGINT UNSIGNED NOT NULL,
  target_employee_id BIGINT UNSIGNED NOT NULL,
  shift_date DATE NOT NULL,
  reason VARCHAR(255),
  status ENUM('pending','approved','rejected','cancelled') DEFAULT 'pending',
  approver_id BIGINT UNSIGNED NULL, actioned_at DATETIME NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS comp_off_requests (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  employee_id BIGINT UNSIGNED NOT NULL,
  worked_date DATE NOT NULL,
  reason VARCHAR(255),
  days DECIMAL(4,1) DEFAULT 1,
  status ENUM('pending','approved','rejected','credited') DEFAULT 'pending',
  approver_id BIGINT UNSIGNED NULL, actioned_at DATETIME NULL,
  credited_leave_type_id BIGINT UNSIGNED NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ---------- Workflow & Automation engine ----------
CREATE TABLE IF NOT EXISTS workflows (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(160) NOT NULL,
  trigger_event VARCHAR(80) NOT NULL,          -- leave.submitted, expense.submitted, travel.submitted, hr_case.created, manual, schedule.*
  entity_type VARCHAR(60),
  conditions JSON,                             -- [{field, op, value}]
  steps JSON NOT NULL,                         -- [{name, assignee: {type: role|user|manager, value}}]
  active TINYINT(1) DEFAULT 1,
  version INT UNSIGNED DEFAULT 1,
  created_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS workflow_runs (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  workflow_id BIGINT UNSIGNED NOT NULL,
  entity_type VARCHAR(60),
  entity_id VARCHAR(40),
  context JSON,
  status ENUM('running','completed','failed','cancelled') DEFAULT 'running',
  current_step VARCHAR(120),
  started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  finished_at DATETIME NULL
);

CREATE TABLE IF NOT EXISTS workflow_tasks (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  run_id BIGINT UNSIGNED NOT NULL,
  step_name VARCHAR(120) NOT NULL,
  assignee_user_id BIGINT UNSIGNED NULL,
  assignee_role VARCHAR(40) NULL,
  sla_hours INT UNSIGNED DEFAULT 48,
  due_at DATETIME NULL,
  status ENUM('pending','approved','rejected','skipped') DEFAULT 'pending',
  comment VARCHAR(500),
  delegated_to BIGINT UNSIGNED NULL,
  actioned_at DATETIME NULL,
  actioned_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS approval_delegations (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  from_user_id BIGINT UNSIGNED NOT NULL,
  to_user_id BIGINT UNSIGNED NOT NULL,
  base_permission VARCHAR(60),
  starts_on DATE, ends_on DATE,
  active TINYINT(1) DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ---------- Notification templates ----------
CREATE TABLE IF NOT EXISTS notification_templates (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NULL,              -- NULL = system default
  event_key VARCHAR(80) NOT NULL,
  channel ENUM('inapp','email','sms','whatsapp') DEFAULT 'email',
  subject VARCHAR(190) NOT NULL,
  body TEXT NOT NULL,
  locale VARCHAR(10) DEFAULT 'en',
  active TINYINT(1) DEFAULT 1,
  UNIQUE KEY uq_ntpl (tenant_id, event_key, channel, locale)
);

-- ---------- Integrations & API platform ----------
CREATE TABLE IF NOT EXISTS webhook_subscriptions (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  url VARCHAR(500) NOT NULL,
  secret VARCHAR(190) NOT NULL,
  events JSON NOT NULL,                        -- ["employee.created","leave.approved",...]
  active TINYINT(1) DEFAULT 1,
  created_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  subscription_id BIGINT UNSIGNED NOT NULL,
  event_id VARCHAR(60) NOT NULL,
  event_type VARCHAR(80) NOT NULL,
  payload JSON,
  status ENUM('pending','success','failed','dead') DEFAULT 'pending',
  attempts INT UNSIGNED DEFAULT 0,
  response_code INT NULL,
  last_error VARCHAR(500),
  next_retry_at DATETIME NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY idx_whd_sub (subscription_id, created_at)
);

CREATE TABLE IF NOT EXISTS api_keys (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(120) NOT NULL,
  key_prefix VARCHAR(20) NOT NULL,
  key_hash VARCHAR(128) NOT NULL,
  scopes JSON NOT NULL,                        -- ["employee.read","payroll.read","lms.sync",...]
  last_used_at DATETIME NULL,
  revoked_at DATETIME NULL,
  created_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY idx_ak_hash (key_hash)
);

CREATE TABLE IF NOT EXISTS integration_connections (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  itype ENUM('biometric','banking','accounting','lms','email','sms','whatsapp','calendar','jobboard','other') NOT NULL,
  name VARCHAR(120) NOT NULL,
  config JSON,                                 -- adapter-specific, secrets encrypted by service layer
  status ENUM('connected','disabled','error') DEFAULT 'connected',
  last_sync_at DATETIME NULL,
  last_error VARCHAR(500),
  created_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  idem_key VARCHAR(120) NOT NULL,
  endpoint VARCHAR(190) NOT NULL,
  response_json JSON,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_idem (tenant_id, idem_key, endpoint)
);

-- ---------- LMS integration (HRMS ↔ standalone LMS) ----------
CREATE TABLE IF NOT EXISTS training_records (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  employee_id BIGINT UNSIGNED NOT NULL,
  external_employee_id VARCHAR(60),
  course_name VARCHAR(190) NOT NULL,
  provider VARCHAR(120) DEFAULT 'Arthvex LMS',
  completed_on DATE,
  score DECIMAL(5,2) NULL,
  learning_hours DECIMAL(6,2) DEFAULT 0,
  skills JSON,
  source VARCHAR(60) DEFAULT 'lms',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY idx_training_emp (tenant_id, employee_id)
);

CREATE TABLE IF NOT EXISTS certifications (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  employee_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(190) NOT NULL,
  issued_by VARCHAR(160),
  issued_on DATE NULL,
  expires_on DATE NULL,
  credential_id VARCHAR(120),
  verified TINYINT(1) DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY idx_cert_expiry (tenant_id, expires_on)
);

-- ---------- Security: login events & SSO ----------
CREATE TABLE IF NOT EXISTS login_events (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NULL,
  user_id BIGINT UNSIGNED NULL,
  email VARCHAR(190),
  event ENUM('login','login_failed','logout','mfa_failed','suspicious') DEFAULT 'login',
  ip VARCHAR(64),
  user_agent VARCHAR(255),
  details VARCHAR(500),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY idx_le_user (user_id, created_at),
  KEY idx_le_email (email, created_at)
);

CREATE TABLE IF NOT EXISTS sso_configs (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  protocol ENUM('oidc','saml') DEFAULT 'oidc',
  issuer_url VARCHAR(255),
  client_id VARCHAR(190),
  client_secret_enc VARCHAR(500),
  redirect_url VARCHAR(255),
  email_domains JSON,
  active TINYINT(1) DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ---------- AI HR Assistant ----------
CREATE TABLE IF NOT EXISTS ai_conversations (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  question TEXT NOT NULL,
  answer TEXT,
  intent VARCHAR(60),
  data_scope VARCHAR(40),
  status ENUM('answered','pending_approval','blocked') DEFAULT 'answered',
  approved_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ---------- Recruitment: referrals ----------
CREATE TABLE IF NOT EXISTS referrals (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  employee_id BIGINT UNSIGNED NOT NULL,
  candidate_name VARCHAR(120) NOT NULL,
  candidate_email VARCHAR(190),
  requisition_id BIGINT UNSIGNED NULL,
  status ENUM('referred','in_process','hired','rejected','rewarded') DEFAULT 'referred',
  reward_amount DECIMAL(12,2) DEFAULT 0,
  notes VARCHAR(500),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================
-- ADMINISTRATION PLATFORM — dynamic organization, RBAC, configuration
-- Added by the Administration Center build. All tenant-scoped tables carry
-- tenant_id; tenant_id IS NULL means a platform-level (system) row.
-- ============================================================

-- ---------- Organization: teams & positions ----------
CREATE TABLE IF NOT EXISTS teams (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  department_id BIGINT UNSIGNED NULL,
  business_unit_id BIGINT UNSIGNED NULL,
  location_id BIGINT UNSIGNED NULL,
  cost_center_id BIGINT UNSIGNED NULL,
  name VARCHAR(120) NOT NULL,
  code VARCHAR(30) NULL,
  description VARCHAR(500),
  team_lead_id BIGINT UNSIGNED NULL,            -- employee
  manager_id BIGINT UNSIGNED NULL,              -- employee
  status ENUM('active','inactive','archived') DEFAULT 'active',
  effective_from DATE NULL,
  effective_to DATE NULL,
  created_by BIGINT UNSIGNED NULL,
  updated_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_team_code (tenant_id, code),
  KEY idx_team_tenant_status (tenant_id, status),
  KEY idx_team_dept (tenant_id, department_id)
);

CREATE TABLE IF NOT EXISTS team_members (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  team_id BIGINT UNSIGNED NOT NULL,
  employee_id BIGINT UNSIGNED NOT NULL,
  member_role ENUM('member','lead','manager') DEFAULT 'member',
  allocation_pct DECIMAL(5,2) DEFAULT 100.00,
  effective_from DATE NULL,
  effective_to DATE NULL,
  status ENUM('active','inactive') DEFAULT 'active',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_team_member (team_id, employee_id),
  KEY idx_tm_emp (tenant_id, employee_id)
);

CREATE TABLE IF NOT EXISTS positions (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  department_id BIGINT UNSIGNED NULL,
  designation_id BIGINT UNSIGNED NULL,
  grade_id BIGINT UNSIGNED NULL,
  job_level_id BIGINT UNSIGNED NULL,
  location_id BIGINT UNSIGNED NULL,
  code VARCHAR(30) NULL,
  title VARCHAR(160) NOT NULL,
  description VARCHAR(500),
  openings INT UNSIGNED DEFAULT 1,
  filled INT UNSIGNED DEFAULT 0,
  employment_type ENUM('full_time','part_time','contract','intern','consultant') DEFAULT 'full_time',
  status ENUM('planned','open','on_hold','closed') DEFAULT 'open',
  opened_on DATE NULL,
  closed_on DATE NULL,
  created_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_position_code (tenant_id, code),
  KEY idx_position_status (tenant_id, status)
);

-- ---------- Global permission registry ----------
-- The single source of truth for every permission string in the product.
-- pkey is the wire format: "module.action" or "module.action:scope".
CREATE TABLE IF NOT EXISTS permissions (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  pkey VARCHAR(120) NOT NULL,
  module VARCHAR(60) NOT NULL,
  action VARCHAR(60) NOT NULL,
  base_key VARCHAR(120) NOT NULL,              -- module.action (no scope)
  label VARCHAR(120) NOT NULL,
  description VARCHAR(255),
  category VARCHAR(60),
  supports_scope TINYINT(1) DEFAULT 0,
  is_system TINYINT(1) DEFAULT 1,              -- 0 = platform-added at runtime
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_perm_key (pkey),
  KEY idx_perm_module (module),
  KEY idx_perm_base (base_key)
);

-- ---------- Permission groups (reusable bundles) ----------
CREATE TABLE IF NOT EXISTS permission_groups (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NULL,               -- NULL = system group template
  code VARCHAR(60) NOT NULL,
  name VARCHAR(120) NOT NULL,
  description VARCHAR(255),
  is_system TINYINT(1) DEFAULT 0,
  status ENUM('active','inactive') DEFAULT 'active',
  created_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_permgroup (tenant_id, code),
  KEY idx_pg_tenant (tenant_id)
);

CREATE TABLE IF NOT EXISTS permission_group_permissions (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NULL,
  group_id BIGINT UNSIGNED NOT NULL,
  permission_id BIGINT UNSIGNED NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_pgp (group_id, permission_id),
  KEY idx_pgp_group (group_id)
);

-- ---------- Normalised role permissions ----------
-- roles.permissions (JSON) remains the authoritative fast path; these tables
-- hold the same grants plus group membership so roles can be composed.
CREATE TABLE IF NOT EXISTS role_permissions (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NULL,
  role_id BIGINT UNSIGNED NOT NULL,
  permission_id BIGINT UNSIGNED NOT NULL,
  granted_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_role_perm (role_id, permission_id),
  KEY idx_rp_tenant (tenant_id)
);

CREATE TABLE IF NOT EXISTS role_permission_groups (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NULL,
  role_id BIGINT UNSIGNED NOT NULL,
  group_id BIGINT UNSIGNED NOT NULL,
  granted_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_role_group (role_id, group_id),
  KEY idx_rpg_tenant (tenant_id)
);

-- ---------- User ↔ role assignment (multi-role) ----------
CREATE TABLE IF NOT EXISTS user_roles (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  role_id BIGINT UNSIGNED NOT NULL,
  is_primary TINYINT(1) DEFAULT 0,
  assigned_by BIGINT UNSIGNED NULL,
  assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_user_role (user_id, role_id),
  KEY idx_ur_tenant (tenant_id, user_id)
);

-- ---------- Direct (per-user) permissions, allow or deny ----------
CREATE TABLE IF NOT EXISTS user_direct_permissions (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  permission_id BIGINT UNSIGNED NOT NULL,
  effect ENUM('allow','deny') DEFAULT 'allow',
  reason VARCHAR(255),
  granted_by BIGINT UNSIGNED NULL,
  granted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_user_perm (user_id, permission_id),
  KEY idx_udp_tenant (tenant_id, user_id)
);

-- ---------- Configurable employee relationships ----------
CREATE TABLE IF NOT EXISTS employee_relationship_types (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NULL,               -- NULL = system type
  code VARCHAR(60) NOT NULL,
  name VARCHAR(120) NOT NULL,
  description VARCHAR(255),
  is_primary_type TINYINT(1) DEFAULT 0,        -- 1 = may hold the single primary link
  is_system TINYINT(1) DEFAULT 0,
  sort_order INT UNSIGNED DEFAULT 100,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_er_type (tenant_id, code)
);

CREATE TABLE IF NOT EXISTS employee_relationships (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  employee_id BIGINT UNSIGNED NOT NULL,         -- the subordinate
  related_employee_id BIGINT UNSIGNED NOT NULL, -- the manager / mentor / partner
  relationship_type_id BIGINT UNSIGNED NOT NULL,
  effective_from DATE NULL,
  effective_to DATE NULL,
  is_primary TINYINT(1) DEFAULT 0,
  notes VARCHAR(255),
  created_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_emp_rel (employee_id, relationship_type_id, related_employee_id),
  KEY idx_rel_target (tenant_id, related_employee_id),
  KEY idx_rel_emp (tenant_id, employee_id)
);

-- ---------- Generic custom-field engine ----------
CREATE TABLE IF NOT EXISTS custom_field_definitions (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  entity_type VARCHAR(40) NOT NULL,             -- employee | department | team | position | expense | leave | candidate | asset | project
  field_key VARCHAR(60) NOT NULL,
  label VARCHAR(120) NOT NULL,
  description VARCHAR(255),
  field_type ENUM('text','textarea','number','decimal','currency','percentage','date','datetime','time',
                  'email','phone','url','checkbox','radio','dropdown','multi_select','file','image')
                  NOT NULL DEFAULT 'text',
  required TINYINT(1) DEFAULT 0,
  default_value VARCHAR(255),
  placeholder VARCHAR(120),
  help_text VARCHAR(255),
  min_value DECIMAL(18,4) NULL,
  max_value DECIMAL(18,4) NULL,
  regex_pattern VARCHAR(255),
  options_source VARCHAR(60) NULL,             -- 'static' | master_data category code
  visibility JSON NULL,                         -- {showInList, showInDetail, readOnlyRoles: []}
  allowed_role_codes JSON NULL,                 -- null = all roles may write
  allowed_department_ids JSON NULL,
  display_order INT UNSIGNED DEFAULT 100,
  status ENUM('active','inactive') DEFAULT 'active',
  created_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_custom_field (tenant_id, entity_type, field_key),
  KEY idx_cfd_entity (tenant_id, entity_type, status)
);

CREATE TABLE IF NOT EXISTS custom_field_options (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  field_id BIGINT UNSIGNED NOT NULL,
  option_value VARCHAR(120) NOT NULL,
  option_label VARCHAR(120) NOT NULL,
  sort_order INT UNSIGNED DEFAULT 100,
  status ENUM('active','inactive') DEFAULT 'active',
  UNIQUE KEY uq_cf_option (field_id, option_value)
);

CREATE TABLE IF NOT EXISTS custom_field_values (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  entity_type VARCHAR(40) NOT NULL,
  entity_id BIGINT UNSIGNED NOT NULL,
  field_id BIGINT UNSIGNED NOT NULL,
  field_key VARCHAR(60) NOT NULL,
  value_text VARCHAR(1000) NULL,
  value_number DECIMAL(18,4) NULL,
  value_date DATE NULL,
  value_json JSON NULL,
  updated_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_cfv (entity_type, entity_id, field_id),
  KEY idx_cfv_tenant (tenant_id, entity_type)
);

-- ---------- Form builder ----------
CREATE TABLE IF NOT EXISTS custom_forms (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  form_key VARCHAR(60) NOT NULL,
  name VARCHAR(160) NOT NULL,
  entity_type VARCHAR(40) NOT NULL,
  description VARCHAR(500),
  version INT UNSIGNED DEFAULT 1,
  status ENUM('draft','published','unpublished') DEFAULT 'draft',
  is_system TINYINT(1) DEFAULT 0,              -- system forms lock mandatory fields
  created_by BIGINT UNSIGNED NULL,
  published_at DATETIME NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_custom_form (tenant_id, form_key)
);

CREATE TABLE IF NOT EXISTS custom_form_sections (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  form_id BIGINT UNSIGNED NOT NULL,
  title VARCHAR(160) NOT NULL,
  description VARCHAR(255),
  sort_order INT UNSIGNED DEFAULT 100,
  visibility JSON NULL,
  UNIQUE KEY uq_form_section (form_id, title)
);

CREATE TABLE IF NOT EXISTS custom_form_fields (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  form_id BIGINT UNSIGNED NOT NULL,
  section_id BIGINT UNSIGNED NULL,
  field_id BIGINT UNSIGNED NULL,               -- → custom_field_definitions
  field_key VARCHAR(60) NOT NULL,
  label VARCHAR(120) NOT NULL,
  field_type VARCHAR(30) NOT NULL,
  required TINYINT(1) DEFAULT 0,
  default_value VARCHAR(255),
  placeholder VARCHAR(120),
  options JSON NULL,
  validation JSON NULL,
  visibility JSON NULL,                         -- {roleCodes: [], condition: {...}}
  is_locked TINYINT(1) DEFAULT 0,              -- mandatory system/security field
  sort_order INT UNSIGNED DEFAULT 100,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY idx_cff_form (form_id, sort_order)
);

-- ---------- Generic master data ----------
CREATE TABLE IF NOT EXISTS master_data_categories (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  code VARCHAR(60) NOT NULL,
  name VARCHAR(120) NOT NULL,
  description VARCHAR(255),
  entity_binding VARCHAR(40) NULL,             -- e.g. leave_type, asset_category
  is_system TINYINT(1) DEFAULT 0,
  status ENUM('active','inactive') DEFAULT 'active',
  created_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_md_category (tenant_id, code)
);

CREATE TABLE IF NOT EXISTS master_data_items (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  category_id BIGINT UNSIGNED NOT NULL,
  code VARCHAR(60) NULL,
  name VARCHAR(160) NOT NULL,
  description VARCHAR(500),
  metadata JSON NULL,
  status ENUM('active','inactive') DEFAULT 'active',
  sort_order INT UNSIGNED DEFAULT 100,
  effective_from DATE NULL,
  effective_to DATE NULL,
  created_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_md_item (category_id, code),
  KEY idx_mdi_tenant (tenant_id, category_id)
);

-- ---------- Module configuration, feature flags, menus, widgets ----------
CREATE TABLE IF NOT EXISTS module_configurations (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  module_key VARCHAR(60) NOT NULL,             -- employees, payroll, recruitment, …
  name VARCHAR(120) NOT NULL,
  category VARCHAR(60) DEFAULT 'hr',
  enabled TINYINT(1) DEFAULT 1,                -- disabling never deletes data
  settings JSON NULL,
  available_from_plan VARCHAR(60) NULL,
  updated_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_module (tenant_id, module_key)
);

CREATE TABLE IF NOT EXISTS feature_flags (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  flag_key VARCHAR(60) NOT NULL,
  name VARCHAR(120) NOT NULL,
  description VARCHAR(255),
  value_type ENUM('boolean','number','string') DEFAULT 'boolean',
  default_value VARCHAR(255) DEFAULT '0',
  is_core TINYINT(1) DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_flag (flag_key)
);

CREATE TABLE IF NOT EXISTS company_feature_flags (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  flag_key VARCHAR(60) NOT NULL,
  enabled TINYINT(1) DEFAULT 0,
  value VARCHAR(255) NULL,
  updated_by BIGINT UNSIGNED NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_company_flag (tenant_id, flag_key)
);

CREATE TABLE IF NOT EXISTS menu_items (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  menu_key VARCHAR(80) NOT NULL,               -- stable key, not the route
  label VARCHAR(120) NOT NULL,
  icon VARCHAR(60) NULL,
  parent_key VARCHAR(80) NULL,
  route VARCHAR(160) NULL,
  target VARCHAR(20) DEFAULT 'internal',       -- internal | external
  sort_order INT UNSIGNED DEFAULT 100,
  required_permission VARCHAR(120) NULL,       -- presentation only — API still gates
  visible TINYINT(1) DEFAULT 1,
  is_system TINYINT(1) DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_menu_item (tenant_id, menu_key)
);

CREATE TABLE IF NOT EXISTS dashboard_widgets (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  widget_key VARCHAR(80) NOT NULL,
  title VARCHAR(120) NOT NULL,
  module VARCHAR(60) NULL,
  config JSON NULL,
  sort_order INT UNSIGNED DEFAULT 100,
  required_permission VARCHAR(120) NULL,
  visible TINYINT(1) DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_widget (tenant_id, widget_key)
);

-- ---------- Workflow extensions (builder + governance) ----------
CREATE TABLE IF NOT EXISTS workflow_versions (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  workflow_id BIGINT UNSIGNED NOT NULL,
  version INT UNSIGNED NOT NULL,
  snapshot JSON NOT NULL,
  status ENUM('draft','pending_approval','approved','active','expired','archived') DEFAULT 'draft',
  change_note VARCHAR(255),
  created_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_wf_version (workflow_id, version)
);

CREATE TABLE IF NOT EXISTS workflow_approval_rules (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(160) NOT NULL,
  description VARCHAR(255),
  entity_type VARCHAR(60) NULL,
  conditions JSON NULL,                         -- [{field, op, value}]
  steps JSON NOT NULL,                         -- [{name, approver:{type,value}, parallelGroup, slaHours, mandatory}]
  is_system TINYINT(1) DEFAULT 0,
  status ENUM('active','inactive') DEFAULT 'active',
  created_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS workflow_actions (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  workflow_id BIGINT UNSIGNED NOT NULL,
  step_order INT UNSIGNED NOT NULL DEFAULT 0,   -- 0 = on completion
  action_type ENUM('notify','update_field','webhook','create_task','auto_approve') NOT NULL,
  config JSON NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY idx_wfa_wf (workflow_id, step_order)
);

CREATE TABLE IF NOT EXISTS workflow_sla_rules (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  workflow_id BIGINT UNSIGNED NOT NULL,
  step_name VARCHAR(120) NOT NULL,
  sla_hours INT UNSIGNED DEFAULT 48,
  remind_after_hours INT UNSIGNED NULL,
  escalate_to JSON NULL,                        -- [{type, value}]
  active TINYINT(1) DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_wf_sla (workflow_id, step_name)
);

-- ---------- Configuration versioning ----------
CREATE TABLE IF NOT EXISTS config_versions (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  config_key VARCHAR(80) NOT NULL,              -- payroll, leave_policy, attendance_policy, salary_structure, benefits
  module VARCHAR(60) NULL,
  version INT UNSIGNED NOT NULL,
  status ENUM('draft','pending_approval','approved','active','expired','archived') DEFAULT 'draft',
  config JSON NOT NULL,
  notes VARCHAR(255),
  effective_from DATE NULL,
  effective_to DATE NULL,
  created_by BIGINT UNSIGNED NULL,
  approved_by BIGINT UNSIGNED NULL,
  published_at DATETIME NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_config_version (tenant_id, config_key, version),
  KEY idx_cv_status (tenant_id, config_key, status)
);

-- ---------- Security policies, invitations, access requests ----------
CREATE TABLE IF NOT EXISTS security_policies (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NULL,               -- NULL = platform default
  policy_key VARCHAR(80) NOT NULL,              -- password.min_length, session.max_per_user, mfa.required, ip.allowlist…
  policy_value JSON NOT NULL,
  description VARCHAR(255),
  updated_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_policy (tenant_id, policy_key)
);

CREATE TABLE IF NOT EXISTS ip_restrictions (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  cidr VARCHAR(64) NOT NULL,
  scope ENUM('allow','deny') DEFAULT 'allow',
  applies_to ENUM('login','admin','api','all') DEFAULT 'all',
  note VARCHAR(255),
  active TINYINT(1) DEFAULT 1,
  created_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_ip (tenant_id, cidr, applies_to)
);

CREATE TABLE IF NOT EXISTS user_invitations (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  email VARCHAR(190) NOT NULL,
  name VARCHAR(120) NOT NULL,
  role_id BIGINT UNSIGNED NULL,
  employee_id BIGINT UNSIGNED NULL,
  invited_by BIGINT UNSIGNED NULL,
  token_hash VARCHAR(128) NOT NULL,
  status ENUM('pending','accepted','expired','revoked') DEFAULT 'pending',
  expires_at DATETIME NOT NULL,
  accepted_at DATETIME NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY idx_inv_tenant (tenant_id, status),
  KEY idx_inv_email (email)
);

CREATE TABLE IF NOT EXISTS access_requests (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  permission_id BIGINT UNSIGNED NULL,
  permission_key VARCHAR(120) NULL,
  scope VARCHAR(40) NULL,
  reason VARCHAR(500),
  status ENUM('pending','approved','rejected','cancelled') DEFAULT 'pending',
  decided_by BIGINT UNSIGNED NULL,
  decided_at DATETIME NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY idx_ar_tenant (tenant_id, status)
);

-- ---------- Platform: plans, settings, tenant lifecycle ----------
CREATE TABLE IF NOT EXISTS platform_plans (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  plan_key VARCHAR(40) NOT NULL,
  name VARCHAR(80) NOT NULL,
  description VARCHAR(255),
  price_monthly DECIMAL(12,2) DEFAULT 0,
  employee_limit INT UNSIGNED DEFAULT 200,
  module_keys JSON NULL,                       -- null = all modules
  feature_limits JSON NULL,
  active TINYINT(1) DEFAULT 1,
  sort_order INT UNSIGNED DEFAULT 100,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_plan (plan_key)
);

CREATE TABLE IF NOT EXISTS platform_settings (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  skey VARCHAR(80) NOT NULL,
  svalue JSON NOT NULL,
  updated_by BIGINT UNSIGNED NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_platform_setting (skey)
);

-- ---------- Company onboarding wizard progress ----------
CREATE TABLE IF NOT EXISTS company_onboarding (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  current_step VARCHAR(60) DEFAULT 'company',
  completed_steps JSON NULL,
  skipped_steps JSON NULL,
  data JSON NULL,
  status ENUM('in_progress','completed','abandoned') DEFAULT 'in_progress',
  completed_at DATETIME NULL,
  started_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_onboarding (tenant_id)
);

-- ============================================================
-- ADMIN AUDIT VIEW
-- Administrative actions share the immutable audit_logs table (one trail, one
-- place to look). The `admin_audit_logs` view that exposes it with the
-- administration-oriented shape is created by src/scripts/migrate.js, after the
-- audit_logs columns it projects exist.
-- ============================================================

-- Column additions for existing tables are applied programmatically by
-- src/scripts/migrate.js (COLUMN_ADDITIONS) so both MySQL 8 and MariaDB work.

SET FOREIGN_KEY_CHECKS = 1;
