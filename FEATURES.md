# Arthvex HRMS — Features & Access Guide

A multi-tenant HRMS platform: one **Platform Super Admin** manages companies (tenants); each company gets its own isolated workspace with roles, employees, attendance, leave, payroll, recruitment and more.

**Stack:** Node.js + Express + MySQL (backend) · React + Vite (frontend) · JWT auth · permission-based access control (`module.action[:scope]`, scopes: own / team / department / company).

---

## 1. Login Types (Roles)

| # | Login Type | Main Purpose | Typical Access |
|---|------------|--------------|----------------|
| 1 | **Platform Super Admin** (`platform_super_admin`) | System / platform management | Everything — create companies, suspend tenants, platform-wide view |
| 2 | **Company Owner** (`company_owner`) | Full company control | Everything in their company except platform management; manages users, roles, settings |
| 3 | **HR Admin** (`hr_admin`) | Manage employees & HR operations | Employees, org structure, attendance, leave, documents & letters, performance, recruitment, onboarding/exit, assets, announcements, reports |
| 4 | **Payroll Admin** (`payroll_admin`) | Salary & payroll processing | Payroll runs, salary structures, statutory rules (PF/ESI/PT/TDS), tax declarations, payslips, bank files, loans |
| 5 | **Finance/Admin** (`finance_admin`) | Financial operations | Billing & GST invoices, expense reimbursement, payroll (view), reports |
| 6 | **Manager** (`manager`) | Manage their direct reports | Team attendance & leave approvals, team expenses, performance reviews, recruitment, onboarding/exit |
| 7 | **Department Head** (`department_head`) | Department-level management | All employees/approvals in departments they head (employee records, attendance, leave, expense approvals, performance, reports) |
| 8 | **Recruiter** (`recruiter`) | Recruitment management | Jobs/requisitions, candidates, interviews, offers, recruitment analytics (+ own self-service) |
| 9 | **Employee** (`employee`) | Self-service | Attendance punch-in/out, leave requests, expenses, loans, payslips, documents, tickets, profile |
| 10 | **Auditor** (`auditor`) | Read-only compliance review | View employees, attendance, leave, payroll, expenses, billing, reports, audit logs — no edits |

Roles are permission sets (editable per company in **Settings → Users & roles**). Menus, pages and API endpoints all gate on permissions, so custom roles work out of the box.

---

## 2. Dummy Credentials (Demo Data)

> Load with: `cd backend && npm run db:reset` (recreates schema + demo data).
> **Password for every account: `Password@123`**

| Email | Role | Who |
|-------|------|-----|
| `super@arthvex.com` | Platform Super Admin | Platform Admin (no company) |
| `owner@arthvex.com` | Company Owner | Arthvex Owner |
| `hr@arthvex.com` | HR Admin | Priya Sharma (HR Manager, heads HR) |
| `payroll@arthvex.com` | Payroll Admin | Meera Kulkarni (Accountant) |
| `finance@arthvex.com` | Finance/Admin | Vivaan Joshi (Finance Manager) |
| `manager@arthvex.com` | Manager | Rahul Nair (Engineering Manager, heads Engineering) |
| `depthead@arthvex.com` | Department Head | Kiran Deshpande (Sales Head, heads Sales) |
| `recruiter@arthvex.com` | Recruiter | Riya Kapoor (HR) |
| `employee@arthvex.com` | Employee | Diya Patel (Software Engineer) |
| `auditor@arthvex.com` | Auditor | External Auditor |

Demo dataset: company *Arthvex Technologies Pvt Ltd* (Bengaluru + Pune offices), 16 employees across 6 departments, 30 days of biometric attendance, pending leave/expense/regularization requests, a loan, goals & reviews, open requisitions with candidates, assets, helpdesk tickets, announcements, a GST invoice, and a drafted payroll run for last month.

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
