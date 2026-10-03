# Arthvex HRMS v2 — Features & Access Guide

A multi-tenant HRMS platform: one **Platform Super Admin** manages companies (tenants); each company gets its own isolated workspace with roles, employees, attendance, leave, payroll, recruitment and more.

Implements the *Arthvex HRMS — Complete Product Specification v2.0* (Sept 2026). LMS / learning management is intentionally **out of scope** — it belongs to the standalone Arthvex LMS, which connects through the API contract described in §Integrations below.

**Stack:** Node.js + Express + MySQL / MariaDB (backend) · React + Vite (frontend) · JWT auth · permission-based access control (`module.action[:scope]`, scopes: own / team / department / company).

---

## 1. Login Types (Roles)

| # | Login Type | Main Purpose | Typical Access |
|---|------------|--------------|----------------|
| 1 | **Administrator — Console** (`platform_super_admin`) | Full platform control (via `/admin` and `/platform`) | All 28 `platform.*` permissions, cross-tenant company directory, provisioning, lifecycle, support access. **No tenant HRMS permission** — customer data is reached only through a Support Access session |
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

| 12 | **Platform Billing Admin** (`platform_billing_admin`) | ARTHVEX commercial operations | Plans, subscriptions, trials, add-ons, invoices, payments, refunds, usage, audit view. No HR data, cannot take support access |
| 13 | **Platform Support Admin** (`platform_support_admin`) | ARTHVEX customer support | Support tickets, support-access sessions, company directory, usage, security view. Cannot change billing |
| 14 | **Platform Security Admin** (`platform_security_admin`) | ARTHVEX security | Security policy, incidents, support visibility, audit export |
| 15 | **Platform Auditor** (`platform_auditor`) | Read-only oversight of the platform | Every platform read and export, no writes |
| 16 | **Custom platform roles** (`platform_custom_*`) | Narrow roles for other ARTHVEX staff | Created in Platform → Roles & permissions; limited to permissions the creator holds |

Roles are permission sets (editable per company in **Settings → Users & roles**). Menus, pages and API endpoints all gate on permissions, so custom roles work out of the box.

---

## 2. Dummy Credentials (Demo Data)

### Administration Console (`http://localhost:5173/admin`)
| Email | Password | Role | Notes |
|---|----------|------|-------|
| `admin@arthvex.com` | `Admin@12345` | Platform Super Admin (bound to Arthvex) | 28 `platform.*` permissions + the cross-tenant company directory. Holds **no** tenant HRMS permission — to work inside Arthvex, sign in as `owner@arthvex.com` |

### Platform Console (`http://localhost:5173/platform`)
Sign in at `/admin` or `/login`; an account with no company bound lands here instead of the HRMS.

| Email | Password | Role | Notes |
|---|----------|------|-------|
| `super@platform.arthvex.com` | `Platform@123` | Platform Super Admin | Everything: provisioning, lifecycle, exports, deletion |
| `billing@platform.arthvex.com` | `Platform@123` | Platform Billing Admin | Plans, subscriptions, usage, audit |
| `support@platform.arthvex.com` | `Platform@123` | Platform Support Admin | Support Access, company directory, usage, security |
| `security@platform.arthvex.com` | `Platform@123` | Platform Security Admin | Security posture, support visibility, audit export |
| `auditor@platform.arthvex.com` | `Platform@123` | Platform Auditor | Reads everything, writes nothing |

No platform role holds any tenant HRMS permission. Reaching a customer's records
requires a Support Access session — reasoned, time-boxed, and every request under
it (reads included) is written to that customer's audit trail.

### Customer Company Logins
| Email | Password | Role | Plan / State |
|---|---|---|---|
| `planthead@demomfg.com` | `Password@123` | Company Owner (Ramesh Kulkarni) | Growth · active |
| `owner@demostartup.com` | `Password@123` | Company Owner | Trial · trialing (intentionally over its 25-employee limit, so limit enforcement is visible) |

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

## 2b. Platform Control Plane

The layer above tenants. Full reference: [`docs/platform-control-plane.md`](docs/platform-control-plane.md).

| Area | What exists |
|---|---|
| **Entitlements** | A 51-entry catalogue (boolean feature switches, numeric caps, metered quantities) resolved in exactly one place: `platform default → plan grant → tenant override → subscription state`. A value of `0` means *not included*, which is distinct from *unlimited* |
| **Plans** | trial / starter / growth / business / enterprise / custom, each editing through the catalogue. Editing a plan re-resolves every tenant on it immediately and requires a reason. Legacy plan names (`standard`, `professional`, `basic`, `pro`) alias onto real plans |
| **Subscriptions** | An explicit transition graph — an illegal jump such as `cancelled → active` is refused. Every move writes a subscription event, a lifecycle-history row *and* a platform audit row |
| **Tenant lifecycle** | `provisioning · trial · active · past_due · grace_period · suspended · cancelled · archived · deletion_pending · deleted`. Suspended and cancelled are **read-only, not locked out**: the company keeps reading its own payroll, every write returns 402 |
| **Usage metering** | Counters derived from source tables (so they cannot drift) plus metered increments, with a per-tenant, per-period history. Enforcement happens on the write path, not as an advisory warning |
| **Module dependencies** | A graph checked *before* any write, so an invalid combination fails at review time rather than mid-transaction. Disabling a module never deletes data |
| **Provisioning wizard** | One transaction: tenant, roles, first legal entity, subscription, module set and the owner's account — or nothing at all |
| **Support Access** | Reason (≥10 chars), type, ticket reference, duration capped at 8 hours. Reads are logged, not just writes. `expires_at` is `NOT NULL`; there is no permanent-session row to create |
| **Platform audit** | Append-only, with before/after values, reason, actor, role, IP and request id. Deliberately separate from the tenant `audit_logs`, because it answers a different question: *what did ARTHVEX do* |

### Enforced on the write path today
`employees.max` (create, both imports) · `active_users.max` · `admins.max` · `locations.max` ·
`legal_entities.max` · `recruitment.jobs.max` · `api_keys.max` · `webhooks.max` · `documents.stored` ·
`storage.max_gb` · `payroll_runs.month` · `workflow.executions.month` · `ai.requests.month` ·
`api.requests.month` (metered at the API boundary, with `X-RateLimit-*` response headers).
Capped creations run under a per-company lock, so simultaneous requests cannot exceed a cap.

### Known gaps in metering
Counters for `storage.max_gb` depend on upload paths recording file size; confirm on your data before relying on it for billing.

---

## 2c. Platform Console (`/platform`)

A separate application shell for ARTHVEX staff, with its own navigation (grouped Overview / Customers / Access & security,
collapsible, remembers its state), breadcrumb header, company search, loading skeletons, empty and error states.

| Page | What it does |
|---|---|
| **Dashboard** | Company, MRR, employee, at-risk, support-session, limit-breach, security-alert and integration-failure figures, plus a live **system health strip** (API uptime, DB latency, 24h webhook outcomes, deletion and export queues) — measured values only |
| **Companies** | Server-side search (name, slug, ID, owner email, domain) and filters (state, plan, industry, subscription, dates, activity, employee count); sortable table with column toggles; provisioning wizard |
| **Company detail** | KPI strip; tabs for Overview, Modules, Entitlements, Usage & limits, Subscription, Users, Roles, Security, Branding, Domains, Integrations, Audit, Support access, Configuration, Data & lifecycle |
| **Edit / delete company** | Edit profile (reason required, audited with before/after). Delete with a grace period (cancellable) or **immediately** (Super Admin only: reason + slug typed back + password; refused while a live subscription exists; a tombstone row is kept for the audit trail) |
| **Subscription tab** | Change plan with a **downgrade preview**, change state, edit terms, issue invoice, **extend / convert trial**, **cancel now or at period end**, **attach / remove add-ons** |
| **Subscriptions · Invoices & payments** | Server-paged sortable tables; record payment, void, **refund** |
| **Plans · Entitlements & usage** | Plan editing re-resolves every company on the plan; usage and limit breaches |
| **Support tickets** | ARTHVEX's own customer support: priority, status, assignee, SLA (only where a policy is configured), internal vs customer-visible notes, resolution required to close, **request support access from the ticket** |
| **Support access** | Time-limited, reasoned sessions with a ticket reference; every request under a session is logged; a read-only session cannot write |
| **Operators** | Platform staff accounts; role assignment; MFA reset |
| **Roles & permissions** | Role cards, a permission matrix, and **create / edit / delete custom platform roles** (cannot exceed the creator's own permissions; cannot delete a role still in use; built-ins are protected) |
| **Operations** | In-app alerts (trial ending, payment failed, limit near / reached, plan changed, cancellation requested, incidents), **incident tracking** (severity, systems, timeline, root cause + resolution to resolve), **maintenance windows** (platform-wide or per company) |
| **Platform security · Audit log** | Platform MFA / IP allow-list / session-age policy; append-only audit with filters |

Company-level **role management from the console**: create, edit and delete a company's custom roles inside a support-access
session (recorded in both audit trails).

---

## 2d. Commercial layer (plans → billing → lifecycle)

Reference: [`docs/commercial-saas.md`](docs/commercial-saas.md).

- **Add-ons** — purchasable extras with `grants` (cap increments or feature switches) layered into the entitlement resolver:
  `platform default → plan → add-ons → tenant override`. One live attachment per add-on per company.
- **Trials** — start, extend (≤ 2 times, ≤ 30 days, reason required, atomic), convert to paid (idempotent), expire, with
  extension count / reason / converted-at recorded. Operators are alerted 3 days before a trial ends.
- **Payments** — a provider abstraction (`services/payments.js`) with a **signed webhook** (`POST /api/billing-webhooks/signed`,
  HMAC-SHA256, 5-minute replay window). Idempotent on the provider's event id and on its payment reference; supports
  `payment.succeeded`, `payment.failed`, `refund.succeeded`. The UI never marks a payment successful by itself.
  *No gateway-specific adapter (Razorpay / Stripe) ships — only the generic signed webhook.*
- **Invoices & refunds** — integer-paise arithmetic, row-locked payment application, over-payment and over-refund refused,
  a refund re-opens a paid invoice; tax percentage and a validated GSTIN on billing contacts.
- **Downgrades** — `plan-preview` lists every cap already exceeded and every module that would be lost; records are always kept,
  nothing further can be added until usage is back under the cap or the plan is upgraded.
- **Cancellation** — immediate or at period end, with reason / requested-by / effective date; withdrawable before it takes effect;
  never deletes data; the lifecycle sweeper ends it at the period end instead of renewing.
- **Grace and suspension** — past due → grace period → suspended. The company can always sign in, read every record, export, and
  contact ARTHVEX; writes are refused with 402 by one global gate.
- **Maintenance mode** — a window blocks company users and API keys with the message and end time; platform staff are never blocked;
  only the Super Admin can schedule one.
- **Usage alerts** — warning / limit notifications to operators and in-app to company owners, once per month per condition.
- **Support SLA policies, retention targets, billing contacts, platform notifications, incidents** — all stored as data;
  nothing is promised or deleted unless configured.

### Company self-service — "Plan & billing" (`/account`, company owners)
Plan, status and trial days left · usage versus limits (with add-ons) · invoices (read-only) · cancel at period end / keep subscription ·
**Setup health** (company setup, payroll readiness with the exact reason payroll cannot run, security) ·
**Data quality** (record IDs and codes only — no pay or identity data) · billing / finance / legal / technical contacts ·
raise and follow ARTHVEX support tickets (only customer-visible notes are shown).

---

## 2e. Security & reliability hardening

Full findings with tests: [`SECURITY-AUDIT.md`](SECURITY-AUDIT.md). Operations and backup guidance: [`docs/operations-runbook.md`](docs/operations-runbook.md).

- **Tenant lifecycle enforcement** — suspended / past-due / cancelled companies are read-only on *every* write route (one global gate), not only routes that check a limit.
- **Support-access gate** — any administration request naming another company needs a live session; read-only sessions cannot write; each call is logged against the session.
- **Concurrency** — per-company locks around employee, capped-table, user-seat, document, requisition, payroll-run and import creation; one live subscription per company enforced by the database.
- **Secrets & environments** — production refuses to start with missing or published example secrets; `db:seed` refuses in production without an explicit override; demo credentials are shown only in a development build; the whole API is rate-limited in production; SQL error text is never returned in production.
- **API keys** — expiry (`expiresInDays`), revocation, trial / grace-period companies served, maintenance-aware.
- **Files** — photos, logos and announcements are served only to the owning company.
- **Platform MFA** — on by default in production (saved policy always wins).
- **Sweeper** — one instance sweeps at a time (MySQL named lock).
- **AI assistant** — company-wide answers require company-wide scope; own/team holders are refused.
- **Imports** — administration employee import now honours the employee cap and its own write permission; dry-run (the default) writes nothing.
- **Payroll & statutory** — unpaid leave split across months, mid-month joiner / leaver proration, single highest surcharge band, and the **employer EPF share** added to the PF return total (unit-tested).
- **Frontend guards** — tenant routes check the same permissions as the navigation; platform accounts are redirected to the console.
- **Observability** — structured request log in production, `GET /api/platform/health`, request ids.

### Not implemented (be aware)
Plan versioning / grandfathering · coupons and credits · tiered / per-employee pricing engine · CGST/SGST/IGST split on ARTHVEX's own
invoices · platform email-template editor and email delivery of platform alerts · SSO · backup / restore tooling (infrastructure) ·
distributed job queue · percentage feature rollout.

### Tests
`cd backend && npm test` — 187 tests: tenant isolation, platform role separation, entitlements and overrides, billing and webhook
idempotency, trial / cancellation / downgrade, add-ons, support tickets and access, maintenance, identity lifecycle,
concurrency at caps, imports, files, AI scoping, payroll and statutory arithmetic. Run `node src/scripts/migrate.js` after pulling.

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
- Create, edit, suspend/activate and delete companies (see §2c); feature flags and plan per tenant
- Everything under the Platform Console (§2c) and commercial layer (§2d); platform-wide file access still requires a support session

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

Seeding wipes and recreates demo data — don't run it against a database with real data. It refuses to run when `NODE_ENV=production`
unless `ALLOW_DESTRUCTIVE_SEED=yes-wipe-everything` is set. After pulling new code run `node src/scripts/migrate.js`.
For payment webhooks set `BILLING_WEBHOOK_SECRET`; for production set real `JWT_*`, `ENCRYPTION_KEY` and `DB_PASSWORD` (see `backend/.env.example`).
