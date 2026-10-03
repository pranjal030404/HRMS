# ARTHVEX — operations runbook

## Environments
`NODE_ENV=development | production`. In production the server **refuses to start** while `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`,
`ENCRYPTION_KEY` or `DB_PASSWORD` are missing or equal to a value published in `.env.example`, or when CORS is `*`.
`db:seed` empties every table and refuses under `NODE_ENV=production` unless `ALLOW_DESTRUCTIVE_SEED=yes-wipe-everything`.
Demo credentials appear on the login page only in a development build.

## Health and monitoring
* `GET /health` — public liveness (no detail). `GET /api/platform/health` — operator-only: DB latency, webhook outcomes (24h), queue sizes.
* Production logs: one JSON line per API request (request id, company id, user id, status, ms). No bodies, headers or tokens.
* Background work: the lifecycle sweeper runs in the API process every 5 minutes under a MySQL named lock, so only one instance sweeps.
  It expires trials, escalates overdue subscriptions, ends cancel-at-period-end subscriptions, expires support sessions,
  runs data exports, schedules/purges deletions and raises usage alerts (hourly, deduplicated per month).

## Backup and disaster recovery — **infrastructure, not implemented in this repository**
The application does not take or restore backups and cannot see whether they succeeded. Required outside the repo:
1. **Database:** daily full + binary-log (point-in-time) backups of the MariaDB/MySQL instance, encrypted, stored off-host.
2. **Files:** `UPLOAD_DIR` (payslips, documents, resumes) backed up with the database — rows and files must restore to the same moment.
3. **Secrets:** `JWT_*`, `ENCRYPTION_KEY` held in a secret manager. **Losing `ENCRYPTION_KEY` makes stored PAN / Aadhaar / bank data unrecoverable.**
4. **Restore test:** restore to a scratch instance at least quarterly and run `npm test` against it.
5. **Targets:** RPO / RTO are decisions for the operator and the chosen infrastructure; none are asserted here.
Tenant recovery after a purge is not possible from the application: the deletion flow (grace period → purge) is irreversible by design.
Platform audit and billing records outlive a tenant purge (they hold `tenant_id` without a foreign key).

## Retention
`retention_policies` stores targets (audit ≥ 365 days, billing ≥ 2190 days, support-access log ≥ 365 days are enforced as floors).
Nothing is purged automatically except the deletion flow the Super Admin starts.

## Rate limits
Auth endpoints 50 / 15 min; whole API per IP 600 / min in production (`API_RATE_LIMIT`); public API keys are metered by plan (`api.requests.month`).
There is no separate limit yet for file uploads, imports or exports beyond their size caps and plan quotas.

## Known capacity observations (measured on a development machine, MariaDB 11)
One company with 50,000 employees: active-employee count 30 ms, setup-health 99 ms, data-quality 139 ms, employee page 2 ms,
name search 30 ms (full scan — there is no full-text index). Platform company list scales with the number of companies, not employees.
The hourly usage-alert pass walks every company (O(companies × entitlements) queries) — move it to a worker before several thousand tenants.
Not load-tested: concurrent users, large attendance/audit tables, payroll runs above a few thousand employees.
