# Arthvex HRMS

A production-grade, multi-tenant **Human Resource Management System** for Indian SMB / mid-market companies (10–200 employees, architected for more), built from the *Arthvex HRMS Product Requirements & Feature Specification*.

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
| `super@arthvex.com` | Platform Super Admin | Multi-tenant administration |

---

## Modules implemented

| Area | Highlights |
|---|---|
| **Multi-tenancy & auth** | Shared-schema tenancy with `tenant_id` on every table, JWT access + rotating refresh tokens (httpOnly cookie, revocation), brute-force rate limiting, optional per-tenant white-label branding (logo, colors, login page) applied as live CSS variables |
| **RBAC** | `module.action[:scope]` permissions (own/team/company), 7 seeded roles, editable per tenant, route + UI guards, sensitive-field masks (PAN/Aadhaar/bank encrypted AES-256-GCM) |
| **Organization** | Companies, locations, departments, designations, grades, cost centers, shifts (grace, half-day, weekly offs, OT), holiday calendars |
| **Employees** | Full master data, effective-dated salary revisions, timeline events, bulk CSV import with row-level validation + template, auto portal accounts, onboarding checklist, document vault with expiry tracking, custom fields |
| **Attendance** | Punch in/out, live daily register, monthly color grid, biometric CSV import **and** device push API (`POST /api/attendance/device-punch` with `X-Device-Key`), regularization workflow with punch replay, monthly lock before payroll |
| **Leave** | Configurable types/policies (accrual monthly/yearly/on-joining, carry-forward, encashment, sandwich rules, notice periods, gender-specific), deterministic reproducible balances, half-days, overlaps & blackout validation, approvals, team calendar, year-end carry-forward job |
| **Payroll** | Full pipeline **draft → calculated → submitted → approved → locked → paid** with maker-checker separation, attendance-driven LOP & payable days, overtime, salary structures with safe formula expressions, loan EMI deduction, expense reimbursement, validation exception queue, payslip PDFs, bank payment file export |
| **Statutory engine** | Versioned, effective-dated rules for **PF, ESI, PT (state-wise), TDS (new/old regime with rebates & cess), LWF** — seeded FY 2026-27 values; recalculation is deterministic so historical runs stay reproducible. Verify against current government notifications before production payroll |
| **Expenses & loans** | Claims with receipts & policy limits, approvals, payroll-triggered reimbursement; loans/advances with generated EMI schedules, pause/resume/close |
| **Talent** | Recruitment (requisitions → candidate kanban → interviews → offers → convert-to-employee), performance (cycles, goals/KPIs, self + manager reviews), onboarding task engine that auto-activates employees |
| **Offboarding** | Resignation submission, notice tracking, department clearance checklist, Full & Final statement builder, employee archive |
| **Documents** | Employee & company document vault, policy acknowledgement tracking, letter templates with merge fields → generated PDF letters |
| **Billing** | Customers, GST invoices with **server-side** CGST/SGST/IGST computation by place of supply, payments & part-payments, ageing, PDF invoices |
| **Reports** | 13 built-in reports (employee master, headcount, attendance daily/monthly, leave ledger, payroll register & variance, statutory summary, expenses, loans, invoices, document expiry, audit) with CSV export, permission-aware |
| **Dashboards** | Role-scoped KPIs, attendance donut, department bars, hiring trend, alerts (document expiry, birthdays, pending approvals) |
| **Helpdesk & comms** | Ticketing with SLA, internal notes; in-app notifications + event-driven email (SMTP configurable; logged as *skipped* when unset) with delivery logs |
| **Audit** | Append-only audit trail for every sensitive action (logins, salary changes, payroll transitions, exports, document access) |

## Security notes

- Tenant isolation enforced **server-side** on every query (never by UI filtering alone).
- Payslips, documents, receipts and invoices are only served through an authorized file route (`/api/files/...`) — URLs alone grant nothing.
- Locked payroll is immutable; salary changes are effective-dated and never rewrite locked runs.
- Sensitive exports (bank files, audit) are permission-checked and audited.
- Passwords are bcrypt-hashed; sessions revoke on password change.

## Project layout

```
hrms/
├── backend/
│   ├── db/schema.sql           # full MySQL schema (60+ tables)
│   ├── src/
│   │   ├── config/             # env + MySQL pool
│   │   ├── middleware/         # auth (JWT+RBAC), uploads, errors
│   │   ├── services/           # payroll engine, statutory engine, leave,
│   │   │                       # attendance, notifications, PDF, audit, settings
│   │   ├── routes/             # auth, org, employees, attendance, leave, payroll,
│   │   │                       # expenses, loans, documents, performance, recruitment,
│   │   │                       # assets, tickets, lifecycle, billing, reports, admin,
│   │   │                       # dashboard, platform, files
│   │   └── scripts/            # migrate.js, seed.js
│   └── uploads/                # payslips, invoices, letters, documents (gitignored)
├── frontend/src/
│   ├── components/             # Layout, DataTable, CrudPage, UI kit
│   └── pages/                  # admin pages + portal/ (employee self-service)
└── setup-db.sh
```

## Useful endpoints (for integrations)

- `POST /api/attendance/device-punch` — biometric device push (`X-Device-Key` header; demo key: `demo-device-key-2026`)
- `GET /api/reports/data?report=…&format=csv` — CSV exports
- `GET /api/payroll/runs/:id/bank-file` — bank payment CSV after payroll lock

## Known V1 boundaries (per spec roadmap)

- MFA/SSO, e-invoicing, government portal filing, WhatsApp/SMS and accounting integrations are structured for but not wired (export-ready approach as the spec recommends for V1).
- Email requires SMTP config in Settings → Notifications; without it everything still works with in-app notifications.
