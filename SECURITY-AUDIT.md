# ARTHVEX HRMS — security & hardening audit

Scope of this pass: authorization chain, tenant lifecycle enforcement, limit metering, API keys,
configuration safety, error handling. Every fix below has a regression test in
`backend/tests/hardening.test.js` or `backend/tests/platform-roles.test.js`.

## Architecture as implemented
- **Two domains.** Platform operators (`users.tenant_id IS NULL`) and tenant users. Platform roles are
  rows in `roles` (`tenant_id NULL, role_type='platform'`); built-ins are code-defined, custom ones
  (`platform_custom_*`) are created in the console and can never exceed their creator's permissions.
- **Reaching tenant data.** Operators have no standing access; `supportAccess.assertTenantReach` needs a
  live, reasoned, expiring session and logs each read against it.
- **Request chain.** authenticate → module gate (entitlement + configuration) → permission/scope →
  resource ownership in SQL (`tenant_id = ?`) → limit check → write.
- **Entitlements.** One resolver (`services/entitlements.js`): plan → override → subscription state.
- **Audit.** Platform audit (`platformAudit`) and tenant audit (`audit`), both written by the server.

## Fixed in this pass
| # | Finding | Severity | Fix |
|---|---------|----------|-----|
| 1 | `requireTenantWritable` was defined but never mounted: a suspended / past-due company could still change records on every route that did not happen to check a usage limit. | High | Global write gate in `app.js` (reads stay open, auth/platform/v1 exempt). |
| 2 | Employee-cap race: check-then-insert let simultaneous requests exceed the cap (3 admitted with headroom 1) and collide on generated employee codes (500s). | High | `limits.withTenantLock` (MySQL named lock per company+resource) around employee, capped-master-data and user creation. |
| 3 | Raw SQL error text (`dbError`) returned to clients. | Medium | Development only; production returns a generic message. |
| 4 | Production could boot with the published development JWT/encryption secrets. | High | `config/env.js` refuses to start in production without real secrets. |
| 5 | API keys had no expiry; trial / grace-period companies were wrongly refused. | Medium | `api_keys.expires_at` (migration), enforced on every call; `expiresInDays` on creation; trial/past_due/grace allowed. |
| 6 | No whole-API rate limit (auth only). | Medium | Production-only per-IP limiter (`API_RATE_LIMIT`, default 600/min). |
| 7 | **Super Admin could write to any company with no support session** through ~58 administration routes (`writeTenantId` is synchronous and never checked reach). | High | Router-level gate in `administration/index.js`: any `tenant_id` addressing another company needs a live session; a `read_only` session cannot write; every call is logged against the session. |
| 8 | Four call sites did `const { supportAccess } = require(...)` but the module exports plain functions, so those cross-tenant reach checks threw a 500 instead of answering. | Medium | Imports corrected. |
| 9 | Document upload, requisition and payroll-run creation were check-then-insert. | Medium | Run under the same per-company lock. |
| 10 | No structured logs or measured health. | Low | One JSON line per production API request (request id, company, user, status, ms; no bodies/tokens); `GET /platform/health` reports real DB latency, webhook outcomes and queue sizes. |

| 11 | Public assets (photos, logos, announcements) were served to any signed-in user of any company. | Medium | Ownership is proved from the referencing row; unreferenced files are not served. |
| 12 | Administration employee import inserted directly and bypassed the `employees.max` cap; per-data-set write permission was displayed but never enforced. | High | Whole-batch cap check, per-data-set permission check, per-company lock; dry run (default) writes nothing. CSV importer on `/employees` also runs under the lock. |
| 13 | The lifecycle sweeper could run on several instances at once. | Medium | Non-blocking MySQL named lock; other instances skip the tick. |
| 14 | Platform MFA defaulted to off everywhere. | Medium | On by default when `NODE_ENV=production`; a saved policy always wins; dev/test unchanged. |
| 15 | **AI assistant** answered company-wide questions (who is on leave, attendance, headcount, payroll) to holders of `own`/`team` scope. | High | Requires company-wide scope; refuses with the permission needed. Platform accounts get a clear refusal. |
| 16 | **Payroll:** unpaid leave spanning two months was charged in full to both; mid-month joiners/leavers were paid the full month; surcharge slabs compounded. | High | Per-day/pro-rated leave split, `daysOutsideEmployment` proration, single highest surcharge band. Unit tests in `payroll-maths.test.js`. |
| 17 | **PF return** omitted the employer's EPF share (12% − 8.33% EPS) from the remittance total, under-stating it by 3.67% of PF wages. | High | `employerEpfShare` added to the liability and total. |
| 18 | Frontend: tenant screens rendered for staff with no permission, and platform accounts landed on empty tenant pages. | Low (server enforced) | Route guards mirror the navigation permissions; platform accounts are redirected to the console. |


| 19 | `renewPeriods` renewed subscriptions whose owner had asked to cancel at period end. | High | Such subscriptions are cancelled at period end instead (data untouched). |
| 20 | Plan change was not previewed and not serialised; two concurrent provisioning calls could race for a subscription. | Medium | `plan-preview`; per-company lock on create; DB-level `uq_live_sub`. |
| 21 | Production secret guard accepted the example values published in `.env.example`; `db:seed` could wipe a production database; login page showed demo credentials in any build. | High | Guard rejects published values and the example DB password; seed refuses in production without an explicit override; demo hint is dev-build only. |
| 22 | `/account` (support, cancel) was blocked by the suspended-company write gate — a company in billing trouble could not contact ARTHVEX. | Medium | `/account` exempted deliberately. |
| 23 | Payment webhooks did not exist; there was no idempotency or replay protection for provider events. | — (new) | Signed, replay-windowed, `UNIQUE(provider,event_id)`, `UNIQUE(provider,provider_ref)`; tested for duplicate delivery, re-sent references, bad/stale signatures, over-payment, refunds. |

## Verified already correct (existing tests)
Cross-tenant IDOR on detail/update/delete/bulk/analytics/workflows; file downloads resolve the owning
tenant from the database; platform admin cannot read tenant data without support access; module
disable blocks the API, not just the menu and keeps data; dependency engine; overrides expire;
lifecycle transitions are guarded; deletion needs re-authentication and is audited.

## Remaining risks / TODO (not changed)
- `users.email` is globally UNIQUE (login is by email alone), so one address cannot hold logins in two companies.
- Webhook replay protection is the consumer's responsibility; there is no secret-rotation UI.
- Tenant pages for modules that mix personal and company views (expenses, loans, performance, documents) are
  not route-guarded on the frontend because the same page serves both; the API enforces scope.
- Statutory rules are data-driven; correctness depends on the rule parameters configured per company
  (e.g. PF `employerRate` is assumed to include the EPS share, as in the seed data). Marginal relief on the
  income-tax rebate is not modelled.
- EDLI is reported as 0 (not computed). Other statutory returns (ESI, PT, TDS, bank reconciliation) were
  read but not independently recomputed.
- Not audited: the remaining v2 modules' business rules (talent, benefits, workforce, engagement),
  PDF generation, and email/notification delivery.
