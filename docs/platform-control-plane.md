# ARTHVEX Platform Control Plane

The layer **above** tenants. A tenant is a customer's company; the control plane
is ARTHVEX's own view of every company at once — what they bought, what they use,
whether they can still write, and (only ever through a reasoned, expiring session)
what is inside them.

Nothing in the control plane duplicates HRMS data. Where a control-plane row is
*about* a company, it carries `tenant_id`; everything else is platform-wide.

---

## 1. The shape of it

```
                      ┌────────────────────────────────────────┐
                      │        Platform Control Plane           │
   ARTHVEX staff ────▶│  /platform  (own shell, own chrome)     │
   (no tenant_id)     │  dashboard · companies · subscriptions  │
                      │  plans · entitlements · support · audit  │
                      └───────────────┬────────────────────────┘
                                      │  support access only
                    ┌─────────────────┴──────────────────┐
                    │  tenants (customer companies)     │
                    │  HRMS: employees, payroll, leave…  │
                    └────────────────────────────────────┘
```

A platform account is `users.tenant_id = NULL`. That single fact is the whole
security model: the control plane is cross-tenant by construction, and crossing
*into* a tenant requires Support Access.

### Roles

| Role | Holds | Notably cannot |
|---|---|---|
| `platform_super_admin` | all 28 `platform.*` permissions | — (but still no tenant HRMS permission) |
| `platform_billing_admin` | plans, subscriptions, usage, directory, audit | lifecycle changes, support access |
| `platform_support_admin` | support grant/revoke, directory, usage, security view | plans, subscriptions, lifecycle |
| `platform_security_admin` | security, support view, audit export | money, lifecycle, provisioning |
| `platform_auditor` | every `platform.*` read | every write |

`platform_super_admin` used to hold 187 permissions including all tenant HRMS
ones. It no longer does. That was the single most important correction in the
model: "can administer the platform" and "can read this customer's payroll" are
different claims, and the second one is only ever granted deliberately, briefly
and on the record.

---

## 2. Entitlement resolution

One function is the single source of truth: `services/entitlements.resolveTenant()`.

```
platform default  →  plan grant  →  active tenant override  →  subscription/tenant state
   (least specific)                              (most specific)
```

- **Unlimited** — no plan defines the key and there is no default, so it is unmetered.
- **`0`** — *not included*. A distinct state from "unlimited": the capability is refused.
- **Read-only** — a suspended, cancelled, past-due, grace or deletion-pending tenant keeps
  **read** access (their own payroll must stay visible) and loses every **write** (402).
- **Blocked** — the tenant is deleted; nothing is served at all.

Results are cached per tenant and invalidated whenever a plan, override or
lifecycle state changes.

`services/entitlements.explain(tenantId, key)` answers "why is this unavailable?"
and is what the UI's *Why?* button calls. `moduleAvailability(tenantId, key)`
answers the same question for a module and returns both `configured` (someone
switched it on) and `entitled` (the plan includes it) — because those are
genuinely different questions and conflating them is how companies end up with a
switched-on module that 402s on every request.

---

## 3. Limits are enforced on the write path

`module.action[:scope]` permission is not sufficient. A request must also clear:

| Gate | Effect when it fails |
|---|---|
| `authenticate` | 401 |
| `requirePermission(perm)` | 403 |
| `requireModuleEnabled(key)` | 403 — checks **config** *and* **entitlement** |
| `requireTenantWritable()` | 402 — reads still work |
| `limits.assertWithinLimit({entitlementKey, incoming})` | 402 |
| `requireEntitlement(key)` | 402 |

**Enforced** on: employee create + bulk import (`employees.max`), user creation
(`active_users.max`), admin grants (`admins.max`), org locations and legal entities, open
requisitions (`recruitment.jobs.max`), and the public API (`api.requests.month`, metered with
`X-RateLimit-*` response headers).

**Measured and displayed but *not* enforced**: `api_keys.max`, `webhooks.max`, `documents.stored`,
`storage.max_gb`, `payroll_runs.month`, `workflow.executions.month`, `ai.requests.month`. These
appear in the console and in `explain()` output, but nothing calls `assertWithinLimit` on the path
that creates them. Treat them as reporting only.

---

## 4. Module dependencies

`MODULE_DEPENDENCIES` is a graph, checked **before** any write so an invalid
combination fails at review time rather than half way through a transaction.
A dependent module cannot be enabled until its prerequisites are available; a
module that is not in the plan is refused with 402 and the entitlement named.
Disabling never deletes data — the row flips, history stays, re-enabling restores it.

---

## 5. Subscription lifecycle

`SUBSCRIPTION_STATUSES`: `trialing · active · past_due · grace_period ·
suspended · cancelled · expired`

`TENANT_STATUSES`: `provisioning · trial · active · past_due · grace_period ·
suspended · cancelled · archived · deletion_pending · deleted`

`services/subscriptions.transition()` is the only path that moves a subscription,
and it walks an explicit transition graph — an illegal jump such as
`cancelled → active` is refused rather than silently applied. Every move writes a
`subscription_events` row **and** a `platform_audit_logs` row **and** a
`tenant_status_history` row, because billing, the customer and an auditor each
reconcile against a different one.

The two state machines are deliberately separate: a tenant can be archived while
still holding a live subscription record, and a subscription can be past due while
the tenant keeps working through a grace period.

---

## 6. Support Access

The only way ARTHVEX reaches a customer's data.

- A session has a `reason` (≥10 chars), a type (`read_only`,
  `tenant_administration`, `configuration`), a `ticket_ref` and a duration
  (capped at 8 hours server-side regardless of what is asked).
- `expires_at` is `NOT NULL`. There is no "permanent" row to create.
- **Reads are logged.** Browsing a customer's configuration is exactly what a
  later audit must be able to reconstruct, so it is written to
  `support_access_logs` rather than inferred from the fact that it was permitted.
- Control-plane *actions* on a customer (status change, override, plan change,
  export, deletion request) deliberately do **not** require a session — they are
  ARTHVEX acting *on* the customer, are permission-gated and fully audited, and
  requiring a session would mean an operator cannot suspend a company that is
  refusing to pay.
- `assertTenantReach()` throws 404 for a tenant user reaching sideways, and 403
  with `details.requiresSupportAccess` for a platform user with no session — which
  is what the console turns into a one-click "Take support access" panel.

---

## 7. Console routes

| Route | Permission | Screen |
|---|---|---|
| `/platform` | `platform.dashboard.view` | MRR, lifecycle donut, consumption, breaches, security alerts, failing connectors |
| `/platform/companies` | `platform.tenants.view` | Directory + provisioning wizard (super admin only) |
| `/platform/companies/:id` | `platform.tenants.view` | Overview · Modules · Entitlements · Usage · Subscription · Data & lifecycle |
| `/platform/subscriptions` | `platform.subscriptions.view` | All subscriptions, MRR, status filters |
| `/platform/plans` | `platform.plans.view` | Plan list + entitlement matrix editor (requires a reason; re-resolves every tenant on that plan) |
| `/platform/entitlements` | `platform.entitlements.view` | Catalogue × plan matrix · platform-wide breach list |
| `/platform/support-access` | `platform.support.view` | Sessions, grant, revoke, per-session action log |
| `/platform/audit` | `platform.audit.view` | Append-only trail, category filters, before/after detail, CSV export |

The control plane has its **own shell**, outside the tenant `Layout`: an operator
has no company, no employee record and no employee navigation, and drawing the
HRMS chrome would imply access they do not have.

---

## 8. Operators, platform security, billing, company tabs

- **Operators** (`/platform/operators`): create/disable/re-role platform staff, reset MFA. Roles are
  platform-only; self-edits and a missing reason are refused; disabling revokes sessions.
- **Platform security** (`/platform/security`): policy in `security_policies` with `tenant_id IS NULL`
  (MFA required, IPv4 allowlist, max session age), enforced at login and on every console request. A change
  that would lock the caller out is refused. Separate from any company's own security settings.
- **Billing** (`/platform/invoices`, Subscription tab): edit discount/price/trial, issue one invoice per
  period (integer-paise maths), record payments (bounded, row-locked), void. An overdue invoice moves an
  active subscription to `past_due` in the lifecycle sweep; settling it restores `past_due`/`grace_period`
  but never a `suspended` one. Invoice tables survive a tenant purge.
- **Company tabs**: Users, Roles, Security, Branding, Domains (real DNS TXT check), Integrations, Audit,
  Support, Configuration (diff + rollback-as-new-version). All sit behind Support Access; writes also refuse a
  `read_only` session and require a reason.
- **Files**: `/api/files` resolves the owning tenant from the referencing row. Another company gets 404;
  platform staff need a support session; unreferenced files are not served.
- **Audit export** is streamed server-side, uncapped, formula-escaped, and itself audited.

## 9. Known gaps

1. **No payment gateway.** Payments are recorded manually; `external_ref` is the hook.
2. **Photos/logos/announcements** under `/api/files` are served to any authenticated user (no owner table).
3. **Domain SSL** is a status field only; nothing provisions certificates or routes by hostname.
4. **No platform MFA enrolment screen**; the policy blocks un-enrolled operators with a clear error and
   enrolment uses the existing `/auth/mfa/*` endpoints.
5. **UI not click-tested in a browser** (extension unavailable); it builds, and the API behind each screen is tested.
