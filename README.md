# Arthvex HRMS v2

A production-grade, multi-tenant **Human Resource Management System** for Indian SMB / mid-market companies (10–200 employees, architected for more), built from the *Arthvex HRMS Complete Product Specification v2.0* — the full employee lifecycle from workforce planning and recruitment through onboarding, employment, time, leave, payroll, performance, compensation, engagement, service delivery, assets, travel, separation and analytics. Learning management is intentionally excluded (delivered by the standalone Arthvex LMS via the integration contract).

**Stack: React (Vite) · Node.js + Express · MySQL/MariaDB**

---

## Quick start

### 0. Prerequisites
- Node.js ≥ 18
- MySQL 8+ **or** MariaDB 10.6+ (a local instance is fine)

### 1. Database
Either run the system-DB setup (needs sudo):

```bash
sudo bash setup-db.sh        # creates db 'hrms' + user 'hrms_app' on port 3306
```

…or point `backend/.env` at any MySQL instance you control and create the database manually:

```sql
CREATE DATABASE hrms CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

`backend/.env` (already configured for this machine's user-level MariaDB on **port 3307**):

```ini
PORT=5050
DB_HOST=127.0.0.1
DB_PORT=3307            # change to 3306 for the system MySQL
DB_USER=hrms_app
DB_PASSWORD=HrmsApp@2026
DB_NAME=hrms
JWT_ACCESS_SECRET=…     # change in production
JWT_REFRESH_SECRET=…
ENCRYPTION_KEY=…        # 32-byte key for AES-256-GCM field encryption
CORS_ORIGIN=http://localhost:5173
```

### 2. Backend

```bash
cd backend
npm install
npm run db:migrate       # applies db/schema.sql (60+ tables)
npm run db:seed          # demo company, 14 employees, attendance, payroll, billing…
npm run dev              # API on http://localhost:5050
```

### 3. Frontend

```bash
cd frontend
npm install
npm run dev              # UI on http://localhost:5173 (proxies /api → :5050)
```

> If port 5173 is taken (as on this machine), Vite picks 5174 — use the URL it prints.

### 4. Log in

#### Administration console — `http://localhost:5173/admin`

A second entrance to the same app, for administrators. Password **`Admin@12345`**:

| Email | Role | What you can do |
|---|---|---|
| `admin@arthvex.com` | Administrator | **Everything** — every permission, every module (including Travel / Workforce / AI / Integrations even when a company has them switched off), plus the cross-tenant Companies console. Bound to Arthvex, so HR pages show real data |

It is a `platform_super_admin` bound to the demo company on purpose: a platform admin with no company can drive every tenant but sees empty HR pages, because those pages scope data by `req.user.tenant_id`.

#### Employee & manager sign-in — `http://localhost:5173/login`

All demo accounts use password **`Password@123`**:

| Email | Role | What you can do |
|---|---|---|
| `owner@arthvex.com` | Company Owner | Everything incl. payroll approve/lock |
| `hr@arthvex.com` | HR Admin | Employees, attendance, leave, docs, reports |
| `payroll@arthvex.com` | Payroll Admin | Salary structures, payroll runs, statutory rules |
| `finance@arthvex.com` | Finance/Admin | Billing, invoices, reimbursements |
| `manager@arthvex.com` | Manager | Team views + approvals (Rahul Nair) |
| `employee@arthvex.com` | Employee | Self-service portal (Diya Patel) |
| `auditor@arthvex.com` | Auditor | Read-only + audit log |
| `super@arthvex.com` | Platform Super Admin | Cross-tenant only, not bound to a company |

> `/admin` is a presentation of the same authentication, not a second identity store: it authenticates against `/api/auth/login` and reach is still decided by the account's role on the server. Signing in there with a non-admin account simply lands you in an app that shows only what that role allows.

---

## Modules implemented

| Area | Highlights |
|---|---|
| **Multi-tenancy & auth** | Shared-schema tenancy with `tenant_id` on every table, JWT access + rotating refresh tokens (httpOnly cookie, revocation), brute-force rate limiting, optional per-tenant white-label branding (logo, colors, login page) applied as live CSS variables |
| **RBAC** | `module.action[:scope]` permissions (own/team/company), 7 seeded roles, editable per tenant, route + UI guards, sensitive-field masks (PAN/Aadhaar/bank encrypted AES-256-GCM) |
| **Administration Center** | One tenant-scoped back office at `/administration` — org builder + health check, teams & positions pipeline, users & access (logins, invites, direct grants/denies, sessions), roles & permission groups with a role-comparison tool, effective-access preview/explain, per-company **module toggles** that 403 their API when off, security policies & IP restrictions, configuration version history, bulk/import/export with per-row rejection reasons, and the append-only audit trail. Cross-tenant company provisioning is gated on `platform.tenants.*` — see [`docs/administration-center.md`](docs/administration-center.md) |
| **Organization** | Companies, locations, departments, designations, grades, cost centers, shifts (grace, half-day, weekly offs, OT), holiday calendars |
| **Employees** | Full master data, effective-dated salary revisions, timeline events, bulk CSV import with row-level validation + template, auto portal accounts, onboarding checklist, document vault with expiry tracking, custom fields |
| **Attendance** | Punch in/out, live daily register, monthly color grid, biometric CSV import **and** device push API (`POST /api/attendance/device-punch` with `X-Device-Key`), regularization workflow with punch replay, monthly lock before payroll |
| **Leave** | Configurable types/policies (accrual monthly/yearly/on-joining, carry-forward, encashment, sandwich rules, notice periods, gender-specific), deterministic reproducible balances, half-days, overlaps & blackout validation, approvals, team calendar, year-end carry-forward job |
| **Payroll** | Full pipeline **draft → calculated → submitted → approved → locked → paid** with maker-checker separation, attendance-driven LOP & payable days, overtime, salary structures with safe formula expressions, loan EMI deduction, expense reimbursement, validation exception queue, payslip PDFs, bank payment file export |
| **Statutory engine** | Versioned, effective-dated rules for **PF, ESI, PT (state-wise), TDS (new/old regime with rebates & cess), LWF** — seeded FY 2026-27 values; recalculation is deterministic so historical runs stay reproducible. Verify against current government notifications before production payroll |
| **Payroll adjustments** | Arrears, back-pay, corrections, bonus and F&F settlements booked as **immutable, auditable** records rather than edits to a locked run. Draft → submit → approve/reject with maker–checker, filters + CSV export, and a per-run trail of the adjustments and reimbursements a locked run actually applied |
| **Statutory returns & reconciliation** | PF ECR / Challan cum return, ESI contribution return, state-wise PT and TDS-with-annual-reconciliation — all built from **locked-run snapshots** rather than recomputed, so a return always reconciles with the payslips. Plus per-run bank reconciliation (net pay vs bank file, missing/partial bank details, zero net, unpaid) |
| **Expenses & loans** | Claims with receipts & policy limits, approvals, payroll-triggered reimbursement; loans/advances with generated EMI schedules, pause/resume/close |
| **Talent** | Recruitment (requisitions → candidate kanban → interviews → offers → convert-to-employee), performance (cycles, goals/KPIs, self + manager reviews), onboarding task engine that auto-activates employees |
| **Offboarding** | Resignation submission, notice tracking, department clearance checklist, Full & Final statement builder, employee archive |
| **Documents** | Employee & company document vault, policy acknowledgement tracking, letter templates with merge fields → generated PDF letters |
| **Billing** | Customers, GST invoices with **server-side** CGST/SGST/IGST computation by place of supply, payments & part-payments, ageing, PDF invoices |
| **Reports** | 18 built-in reports (employee master, headcount, attendance daily/monthly, leave ledger, payroll register & variance, statutory summary, PF ECR, ESI, state-wise PT, TDS, bank reconciliation, expenses, loans, invoices, document expiry, audit) with CSV export, permission-aware |
| **Dashboards** | Role-scoped KPIs, attendance donut, department bars, hiring trend, alerts (document expiry, birthdays, pending approvals) |
| **Helpdesk & comms** | Ticketing with SLA, internal notes; in-app notifications + event-driven email (SMTP configurable; logged as *skipped* when unset) with delivery logs |
| **Audit** | Append-only audit trail for every sensitive action (logins, salary changes, payroll transitions, exports, document access) |

## v2 modules (per the Complete Product Specification 2.0)

| Area | Highlights |
|---|---|
| **Talent & Succession** | Skills matrix, career paths, development plans with mentors & progress, talent pools, succession planning (criticality, risk, successor readiness), certifications with expiry + LMS-imported training records |
| **Engagement** | Anonymous pulse/annual surveys with results dashboards, live polls, recognition wall (kudos/badges/rewards with points), suggestion box with HR triage |
| **Employee Relations** | HR cases (grievance/complaint/disciplinary/harassment) with severity & assignment, confidential HR-only investigation notes, disciplinary actions with acknowledgement |
| **Travel** | Request → approval → advance → booking → settlement lifecycle with auto advance adjustment, travel analytics |
| **Compensation & Benefits** | Salary bands per grade, increment cycles (init → propose → approve → **apply** creates effective-dated revisions + promotions), bonus plans & awards, pay-equity analytics, benefit plans with eligibility rules, enrollments with nominee data |
| **Workforce Planning** | Quarterly headcount plans with scenarios, planned-vs-actual cost & headcount, vacancy feed |
| **People Analytics** | 8 role-aware dashboards (Executive, HR, Recruitment, Attendance, Payroll, Performance, Compensation, Compliance) |
| **Workflow engine** | Trigger → conditions → sequential approval steps with SLA; live triggers on leave/travel/HR-case events; My Tasks inbox; approval delegations |
| **Timesheets** | Billable/non-billable projects with bill & cost rates, project members with allocation %, Mon–Sat weekly grids keyed to the week, submit → approve workflow, HR-only period locks, scope-enforced list/detail/action, and analytics by employee/department/project/week with billable value, cost and margin |
| **Notification Center** | Template overrides with variables & preview, delivery logs, per-user event preferences |
| **Integrations & API** | Scoped API keys, signed webhooks (HMAC-SHA256 + retry/dead-letter), integration registry, versioned **`/api/v1`** public API with idempotency keys, full **HRMS ↔ LMS sync contract** (identity export, completions, certifications, learning evidence, exit webhooks) |
| **AI HR Assistant** | Permission-scoped natural-language Q&A, anomaly detection, draft generation — read-only, fully audited |
| **Security v2** | TOTP MFA with login challenge, device/session management with revocation, login history & suspicious-login detection |

> LMS / learning management remains **out of scope** by design (spec §21) — it is delivered by the separate Arthvex LMS product and integrated via the `/api/v1/lms/*` endpoints and webhooks above.

## Security notes

- Tenant isolation enforced **server-side** on every query (never by UI filtering alone).
- Payslips, documents, receipts and invoices are only served through an authorized file route (`/api/files/...`) — URLs alone grant nothing.
- Locked payroll is immutable; salary changes are effective-dated and never rewrite locked runs.
- Payroll adjustments are append-only: arrears, back-pay and corrections are booked as their own audited records and reach a payslip only when a locked run applies them, so a locked run never needs to be edited or reopened.
- Sensitive exports (bank files, audit) are permission-checked and audited.
- Passwords are bcrypt-hashed; sessions revoke on password change.

## Project layout

```
hrms/
├── backend/
│   ├── db/schema.sql           # full MySQL schema (100+ tables)
│   ├── src/
│   │   ├── config/             # env + MySQL pool
│   │   ├── middleware/         # auth (JWT+RBAC), uploads, errors
│   │   ├── services/           # payroll engine, statutory engine, leave,
│   │   │                       # attendance, notifications, workflow engine,
│   │   │                       # webhook emitter, PDF, audit, settings
│   │   ├── routes/             # auth, org, employees, attendance, leave, payroll,
│   │   │                       # expenses, loans, documents, performance, recruitment,
│   │   │                       # assets, tickets, lifecycle, billing, reports, admin,
│   │   │                       # dashboard, platform, files
│   │   │                       # v2: talent, engagement, relations, travel,
│   │   │                       #     compensation, benefits, workforce, analytics,
│   │   │                       #     timesheets, workflow, notifications, ai,
│   │   │                       #     integrations (admin + public /api/v1)
│   │   └── scripts/            # migrate.js, seed.js
│   └── uploads/                # payslips, invoices, letters, documents (gitignored)
├── docs/
│   └── administration-center.md # Administration Center guide
├── frontend/src/
│   ├── components/             # Layout, DataTable, CrudPage, UI kit
│   └── pages/                  # admin pages + portal/ (employee self-service)
│                                  # administration/ = Administration Center
└── setup-db.sh
```

## Useful endpoints (for integrations)

- `POST /api/attendance/device-punch` — biometric device push (`X-Device-Key` header; demo key: `demo-device-key-2026`)
- `GET /api/admin/data?report=…&format=csv` — register reports & CSV exports
- `GET /api/payroll/runs/:id/bank-file` — bank payment CSV after payroll lock
- `GET /api/payroll/adjustments?status=…&format=csv` — payroll adjustment register
- `GET /api/payroll/runs/:id/adjustments` — adjustments + reimbursements applied by a run
- `GET /api/payroll/returns/{pf-ecr|esi|pt|tds}?year=&month=` (or `?fy=2026-27&quarter=Q1`) — statutory returns, CSV via `&format=csv`
- `GET /api/payroll/runs/:id/reconciliation` — bank reconciliation for a run
- `GET /api/admin/data?report=statutory-pf-ecr|statutory-esi|statutory-pt|statutory-tds|payroll-reconciliation` — same figures as register reports
- `/api/v1/*` — versioned public API for external services (API key via `Authorization: Bearer` or `X-Api-Key`; send `Idempotency-Key` on mutations):
  - `GET /api/v1/employees` · `GET /api/v1/employees/:id` · `POST /api/v1/employees`
  - `GET /api/v1/lms/employees` (identity export for the standalone LMS)
  - `POST /api/v1/lms/completions` · `POST /api/v1/lms/certifications` · `POST /api/v1/lms/learning-evidence`
  - Demo key: `akv1_arthvex_demo_key_2026_lms_sync_0001`

## Known V2 boundaries (per spec roadmap)

- SSO (OIDC/SAML) has a config table (`sso_configs`) but no redirect flow wired yet.
- Email requires SMTP config in Settings → Notifications; without it everything still works with in-app notifications, and deliveries log as *skipped*.
- Statutory rules are seeded for FY 2026-27 — verify against current government notifications before running real payroll.
- Statutory returns read the statutory values snapshotted onto each payroll item at calculation time. Runs locked **before** those snapshots existed will report zero for the newer components (notably EPS), so re-run or backfill them before filing.
- ESI returns are produced per financial quarter; with no committed payroll in the selected quarter the return is legitimately empty rather than an error.
- AI assistant is rule-based (deterministic, permission-scoped SQL) — swap in an LLM provider behind the same `/api/ai` contract if desired.
