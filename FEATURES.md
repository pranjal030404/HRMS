# Arthvex HRMS v2 — Features & Access Guide

A multi-tenant HRMS platform: one **Platform Super Admin** manages companies (tenants); each company gets its own isolated workspace with roles, employees, attendance, leave, payroll, recruitment and more.

Implements the *Arthvex HRMS — Complete Product Specification v2.0* (Sept 2026). LMS / learning management is intentionally **out of scope** — it belongs to the standalone Arthvex LMS, which connects through the API contract described in §Integrations below.

**Stack:** Node.js + Express + MySQL (backend) · React + Vite (frontend) · JWT auth · permission-based access control (`module.action[:scope]`, scopes: own / team / department / company).

---

## 1. Login Types (Roles)

| # | Login Type | Main Purpose | Typical Access |
|---|------------|--------------|----------------|
| 1 | **Administrator — Console** (`platform_super_admin`) | Full platform + company control (via `/admin`) | Everything — every permission, every module (including Travel, Workforce, AI, Integrations even if disabled per company), cross-tenant Companies console, real data access when bound to a company |
| 2 | **Platform Super Admin** (`platform_super_admin`) | System / platform management (no company bound) | Cross-tenant view/provisioning; HR pages may be empty when not scoped to a specific tenant |
| 3 | **Company Owner** (`company_owner`) | Full company control | Everything in their company except platform management; manages users, roles, settings |
| 4 | **HR Admin** (`hr_admin`) | Manage employees & HR operations | Employees, org structure, attendance, leave, documents & letters, performance, recruitment, onboarding/exit, assets, announcements, reports |
| 5 | **Payroll Admin** (`payroll_admin`) | Salary & payroll processing | Payroll runs, salary structures, statutory rules (PF/ESI/PT/TDS), tax declarations, payslips, bank files, loans |
| 6 | **Finance/Admin** (`finance_admin`) | Financial operations | Billing & GST invoices, expense reimbursement, payroll (view), reports |
| 7 | **Manager** (`manager`) | Manage their direct reports | Team attendance & leave approvals, team expenses, performance reviews, recruitment, onboarding/exit |
| 8 | **Department Head** (`department_head`) | Department-level management | All employees/approvals in departments they head (employee records, attendance, leave, expense approvals, performance, reports) |
| 9 | **Recruiter** (`recruiter`) | Recruitment management | Jobs/requisitions, candidates, interviews, offers, recruitment analytics (+ own self-service) |
| 10 | **Employee** (`employee`) | Self-service | Attendance punch-in/out, leave requests, expenses, loans, payslips, documents, tickets, profile |
| 11 | **Auditor** (`auditor`) | Read-only compliance review | View employees, attendance, leave, payroll, expenses, billing, reports, audit logs — no edits |

Roles are permission sets (editable per company in **Settings → Users & roles**). Menus, pages and API endpoints all gate on permissions, so custom roles work out of the box.

---

## 2. Dummy Credentials (Demo Data)

### Administration Console (`http://localhost:5173/admin`)
| Email | Password | Role | Notes |
|---|----------|------|-------|
| `admin@arthvex.com` | `Admin@12345` | Platform Super Admin (bound to Arthvex) | Every permission, every module, real data, cross-tenant Companies console |

### Employee & Manager Login (`http://localhost:5173/login`)
| Email | Password | Role | Notes |
|---|----------|------|-------|
| `super@arthvex.com` | `Password@123` | Platform Super Admin | Cross-tenant (no company bound) |
| `owner@arthvex.com` | `Password@123` | Company Owner | Full company rights |
| `hr@arthvex.com` | `Password@123` | HR Admin | — |
| `payroll@arthvex.com` | `Password@123` | Payroll Admin | — |
| `finance@arthvex.com` | `Password@123` | Finance/Admin | — |
| `manager@arthvex.com` | `Password@123` | Manager | Manages Diya Patel & team |
| `depthead@arthvex.com` | `Password@123` | Department Head | Heads Sales |
| `recruiter@arthvex.com` | `Password@123` | Recruiter | — |
| `employee@arthvex.com` | `Password@123` | Employee | Linked to Diya Patel |
| `auditor@arthvex.com` | `Password@123` | Auditor | Read-only |

Demo dataset: company *Arthvex Technologies Pvt Ltd* (Bengaluru + Pune offices), 16 employees across 6 departments, 30 days of biometric attendance, pending leave/expense/regularization requests, a loan, goals & reviews, open requisitions with candidates, assets, helpdesk tickets, announcements, a GST invoice, a drafted payroll run for last month — **plus v2 demo data**: skills matrix, career paths, development plans, talent pools, succession plans, salary bands, an active increment cycle with pending reviews, a bonus plan, benefit plans & enrollments, an anonymous pulse survey with responses, a live poll, a recognition wall, suggestions, an HR case with confidential notes, travel requests with advance & bookings, headcount plans, projects & submitted timesheets, two live workflows (with a pending manager approval), an LMS integration connection, training records & certifications synced from LMS, login events, and referrals.

Payroll demo data worth trying first: a **submitted arrears adjustment** awaiting payroll approval, a bonus plan with awards in `proposed`/`approved` states (approving one books a payroll adjustment automatically), an approved-but-unpaid expense claim, and an internal non-billable project that acts as the default sink for non-billable time.

**Demo API key** (for the `/api/v1` public API, shown in Integrations → API Keys): `akv1_arthvex_demo_key_2026_lms_sync_0001`

---

## 3. Feature List by Module

### Dashboard
- Role-aware stats: headcount, present today, on leave, pending approvals, payroll cost
- Hiring trend & recent hiring activity (recruitment-enabled companies)
- Announcements feed, pending-approval inbox, quick links

### Employees (HR)
- Employee directory with search/filter by department, designation, location, status
- Full employee profile: personal, job, shift & work mode, PAN/Aadhaar/bank (encrypted, masked for non-privileged roles)
- Create employee → auto-creates portal login with temp password (`must change on first login`)
- Edit with audit trail; org-chart reporting hierarchy (`manager_id`, `reporting_head_id`)
- Timeline events: joined, transfers, manager changes, status changes
- Salary history (CTC, structure, components per revision)
- CSV bulk import + downloadable template
- Scope-aware: company-wide for HR, department for heads, team for managers

### Organization (master data)
- Departments (with department head), designations, grades, locations, cost centres
- Shifts (timings, grace, half-day rules, weekly offs, overtime flag)
- Holiday calendar per location, Indian states lookup

### Attendance
- Daily attendance register (per-employee punch grid) & monthly register view
- Punch-in / punch-out with late minutes, worked hours, source (biometric/web/system)
- Regularization requests (missed punches) + approval workflow
- Biometric/CSV import, month locking, auto-absent setting, device key

### Leave
- Leave types with accrual rules (monthly/quota), carry-forward, encashment, gender-specific (ML/PL), notice & proof rules, negative balance policy
- Apply with day breakdown (full/half days), working-day pricing, holiday/weekly-off skipping
- Balance tracking (opening, accrual, used, pending, carry-forward, lapse) + year-end carry-forward job
- Approve/reject/cancel with comments, notifications; team & department leave calendars

### Payroll (India statutory)
- Payroll runs: calculate → submit → approve → lock → pay lifecycle, per-month with month-days basis
- Salary components (earnings, deductions, employer contributions) with formulas (e.g. `BASIC * 0.40`)
- Salary structures assigned per employee; proration
- Statutory: PF, ESI, Professional Tax (state-wise), TDS (new & old regime slabs, rebate, cess), LWF — versioned, effective-dated rules
- Payslips (PDF-ready) per employee; bank advice file generation
- **Payroll adjustments** — arrears, back-pay, corrections, bonus and F&F booked as immutable, auditable records (never mutated in place). Draft → submit → approve/reject with maker–checker, filters, CSV export, and a per-run trail of every adjustment and reimbursement a locked run applied
- **One-time lines on the payslip** are rendered separately from base components so `gross + reimbursements + adjustments − deductions = net` always reconciles
- **Reimbursements** are non-taxable, sit outside gross, and are picked up by the next run regardless of the month the expense was incurred in
- **Statutory returns** built from locked-run snapshots (nothing is recomputed, so a return always reconciles with the payslips): PF ECR / Challan cum return, ESI contribution return, state-wise Professional Tax, and TDS deposits with an annual 26Q-style reconciliation
- **Bank reconciliation** per run — net pay vs bank file, flagging employees with no/partial bank details, zero net and unpaid status
- Statutory and reconciliation figures are also available as register reports with CSV export
- Employee tax declarations (80C etc.) with finance review

### Expenses & Loans
- Expense categories with monthly limits & receipt rules; claim submission with receipt upload
- Approval workflow (manager → department head → finance), reimbursement tracking
- Loans & advances: EMI schedule, outstanding tracking, payroll integration

### Documents & Letters
- Employee document vault (upload, verify, expiry tracking)
- Company document library with versioning & employee acknowledgement
- Letter generation from templates (experience letters etc.) with merge fields

### Performance
- Review cycles (annual/quarterly) with draft → active → closed lifecycle
- Goals/KPIs with weightage, progress %, manager comments
- Reviews: self-review submission → manager rating → final rating
- Department-scoped visibility for department heads

### Recruitment
- Requisitions (job openings): department, location, openings, experience band, budget CTC, hiring manager, publish
- Candidate pipeline with stages (applied → screening → interview → offer), resume upload, source & expected CTC tracking
- Interview scheduling with feedback capture
- Offers: create, send, accept/reject; convert accepted offer → employee record
- Recruitment analytics (open requisitions, hiring trend)

### Assets
- Asset register (laptops etc.) with category, serial, purchase info
- Assignment & return workflow with condition tracking

### Helpdesk (Tickets)
- Employees raise tickets (IT/payroll/HR categories) with attachments, priority, SLA due time
- Comment threads; ticket handlers move status (open → in progress → resolved)

### Announcements
- Company-wide announcements with pinning (shown on dashboards & portal)

### Onboarding & Exit (Lifecycle)
- Onboarding task lists per new hire (assign, complete)
- Separation/resignation workflow: approval, department-wise clearance checklist, FnF (full & final) items, completion

### Reports & Admin
- Catalogued reports with company/team scoping and CSV export
- Settings: attendance, payroll, workflow, SMTP/notification configuration
- Company profile & white-label branding (logo, primary color, login tagline)
- Users & roles management (create users, change roles, enable/disable, edit permission sets)
- Audit log of every sensitive action (actor, before/after, IP, user agent)

### Administration Center (`/administration`)
Tenant-scoped back office; every section is gated server-side and hidden from the nav if you lack the permission.
- **Dashboard** — company counts, modules on/off, security posture, org health, recent admin activity
- **Organization builder** — departments, business units, locations, designations, grades, cost centres with headcount/vacancy roll-up, plus an org **health** check (departments without a head, positions without a department, orphaned custom fields)
- **Teams** — team CRUD + membership (members are employees, not logins)
- **Positions** — CRUD + **pipeline** (current incumbents and internal candidates)
- **Users & access** — logins, temporary passwords (shown once), email invitations & revoke, role assignment, direct grants/denies, sessions, password reset, pending access requests
- **Roles** — system roles read-only; create/edit custom roles from the permission matrix, attach permission groups, compare two roles (common / only-in-A / only-in-B / scope differences), clone a role
- **Permissions** — full catalog with module, scope and legacy aliases; matrix view
- **Access review** — my effective access, any user's access (incl. explicit denies and scoped resources), and a *explain this permission* view
- **Modules & features** — per-company module toggles; a disabled module returns `403`; reset to catalog default
- **Security** — overview (users, MFA, sessions, failed logins), keyed policies with reset, IP restrictions
- **Configuration history** — versioned config snapshots with rollback (rollback writes a new version)
- **Bulk, import & export** — bulk ops on up to 500 selected records (out-of-company rows reported as skipped), CSV import with **dry run** and per-row rejection reasons, CSV export per data set
- **Audit trail** — append-only log with filters, activity charts and CSV export
- **Custom fields & forms** — define fields on employees/departments/positions/…, plus custom forms with sections
- **Master data** — company-defined lists (cost centres, certifications, shift patterns) with categories and items
- **Workflows** — approval chains with publish, version restore and in-flight impact check, plus approval rules
- **Companies** (platform admins only) — provision a tenant with its system roles and first owner in one transaction

Full guide: [`docs/administration-center.md`](docs/administration-center.md)

### Billing (Finance)
- Customers, GST invoices (CGST/SGST/IGST, intra/inter-state), payments, PDF invoice
- Billing summary & receivables

### Employee Self-Service Portal
- Portal home, My Profile (edit requests to HR), My Attendance (punch, history, regularize)
- My Leave (apply, balances, history), My Payslips, My Documents, My Expenses (claims & receipts)
- Notifications bell (in-app + email events)

### Platform Admin (Super Admin only)
- Create companies (tenant + admin user + seeded roles), suspend/activate tenants
- Feature flags & plan per tenant, platform-wide file access

---

## 3b. v2 Modules (spec 2.0 expansion)

### Talent & Succession
- Skills catalogue + employee skills matrix (proficiency, years, verification)
- Career paths (technical/management tracks with step-by-step competencies)
- Development plans with mentor, timeline and progress tracking
- Talent pools (employees + candidates) with membership management
- Succession planning: critical positions, risk, successor readiness (ready now → 3-5 years)
- Certifications with expiry tracking + training records imported from the LMS

### Engagement
- Surveys (pulse/annual) with configurable anonymity, rating & open-text questions, results dashboards
- Polls with live vote counts; one vote per employee
- Recognition wall: kudos / badges / rewards with points, feed on dashboards & portal
- Anonymous-or-named suggestion box with HR triage status & notes

### Employee Relations (restricted access)
- HR cases (grievance / complaint / disciplinary / harassment) with severity, assignment, resolution
- Investigation notes with internal vs **HR-only confidential** visibility; full audit history
- Disciplinary actions (verbal/written warning, show cause, suspension, PIP, termination) with acknowledgement

### Travel
- Travel requests (request → approval → advance → booking → settlement)
- Advance issuance, booking records (flight/train/cab/hotel), settlement with auto advance adjustment
- Travel analytics (spend, pending approvals, top destinations)

### Compensation & Benefits
- Salary bands per grade (min/mid/max) with band-position analytics
- Increment cycles: init reviews from current salaries → propose %/bonus/promotion → approve → **apply** (creates effective-dated salary revisions + optional promotion)
- Bonus plans & awards with budget tracking (proposed → approved → paid)
- Pay-equity analytics (avg CTC by designation/grade/gender with gap %)
- Benefit plans (insurance/allowance/wellness) with eligibility rules; enrollments with nominee data & coverage details; My Benefits in the portal

### Workforce Planning
- Quarterly headcount plans per department/designation with scenarios (base/aggressive/conservative)
- Planned vs actual headcount & workforce cost, variance, and an open-positions feed

### People Analytics (role-aware dashboards)
- Executive, HR, Recruitment, Attendance, Payroll, Performance, Compensation and Compliance dashboards (spec §13)
- KPI cards, trend tables and bar charts; permission-gated per dashboard

### Workflow & Automation engine
- Visual-light builder: trigger event → conditions → sequential approval steps (assignee by role / specific user / employee's manager) with SLA due dates
- Live triggers: `leave.submitted` (≥3 days), `travel.submitted`, `hr_case.created` + manual runs
- My Tasks approval inbox; approve/reject advances or fails the run; notifications at every step
- Approval delegations (out-of-office) between users

### Timesheets
- Projects (billable/non-billable) with bill & cost rates, and project members with allocation %
- Weekly timesheet grid (Mon–Sat) keyed to the week containing each day; future weeks and out-of-week entries are rejected
- Draft → submit → approve/reject with comments; approved sheets are read-only
- Validation warnings (e.g. billable time on a non-billable project) are surfaced to the employee instead of silently dropping hours
- **Period locks** (HR-only) freeze a week so nothing can be edited or actioned afterwards
- Scoped access everywhere: an employee sees only their own sheet, a manager their team, HR/owner/payroll the company — enforced on list, detail and action
- Analytics grouped by employee, department, project or week, with billable %, billable value, cost and margin; approved-only by default with an opt-in to include drafts, plus CSV export

### Notification Center
- Template management per event/channel with `{{variables}}` and live preview; overrides built-in defaults
- Delivery logs (sent / failed / skipped) with error detail
- Per-user notification preferences (in-app / email per event)

### Integrations & API platform
- Service **API keys** with scopes (`employee.read`, `employee.write`, `lms.sync`, …) — shown once at creation
- **Webhooks**: signed deliveries (`X-Arthvex-Signature` HMAC-SHA256 of `eventId.timestamp.body`), event IDs, automatic retry with exponential backoff, dead-letter status, manual retry, test fire
- Integration connections registry (biometric, banking, accounting, LMS, calendar, job boards…)
- Versioned public API **`/api/v1`** with consistent pagination and error envelopes, API-key auth, and **Idempotency-Key** replay protection on mutations
- **HRMS ↔ LMS contract (spec §10)**:
  - `GET /api/v1/lms/employees` — identity export (employee_id, external_employee_id, name, email, department, designation, status, manager)
  - `POST /api/v1/lms/completions` — course completions → training records
  - `POST /api/v1/lms/certifications` — certificate metadata with expiry
  - `POST /api/v1/lms/learning-evidence` — aggregated learning hours/skills
  - `employee.created` / `employee.exited` webhooks so the LMS can provision & suspend learners
- LMS sync status dashboard in the UI

### AI HR Assistant
- Natural-language Q&A over HR data (headcount, leave today, payroll cost, attendance, hiring funnel, document expiry, succession gaps) — **strictly scoped to the asking user's permissions, read-only**
- Anomaly detection (late-arrival spikes, payroll variance, overdue approvals)
- Draft generation (offer summary) and query history

### Security & sessions (spec §12)
- **MFA (TOTP)**: authenticator enrollment + verification step at login for opted-in users; disable requires password
- Session/device management: list active sessions, revoke individual devices or all others
- Login history with failed-attempt tracking and suspicious-login flagging
- Field-level AES-256-GCM encryption for PAN/Aadhaar/bank (existing), rate limiting, CSRF-safe cookie rotation

---

## 4. Quick Start

```bash
# 1. Database (MySQL) — configure backend/.env first, or run:
./setup-db.sh

# 2. Backend
cd backend && npm install
npm run db:reset     # migrate + demo seed (the credentials above)
npm run dev          # API on http://localhost:5000

# 3. Frontend
cd ../frontend && npm install
npm run dev          # app on http://localhost:5173
```

Seeding wipes and recreates demo data — don't run it against a database with real data.
