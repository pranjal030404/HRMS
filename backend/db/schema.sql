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
  employer_contrib JSON,
  gross DECIMAL(12,2) DEFAULT 0,
  total_deductions DECIMAL(12,2) DEFAULT 0,
  net_pay DECIMAL(12,2) DEFAULT 0,
  employer_cost DECIMAL(12,2) DEFAULT 0,
  inputs_snapshot JSON,                        -- attendance/leave/loan inputs used (for reproducibility)
  remarks VARCHAR(255),
  UNIQUE KEY uq_pi (run_id, employee_id),
  KEY idx_pi_emp (employee_id)
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
  separation_id BIGINT UNSIGNED NOT NULL,
  component VARCHAR(120) NOT NULL,             -- Leave encashment, Notice pay recovery, Gratuity...
  ftype ENUM('payment','recovery') DEFAULT 'payment',
  amount DECIMAL(12,2) NOT NULL,
  remarks VARCHAR(255)
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

SET FOREIGN_KEY_CHECKS = 1;
