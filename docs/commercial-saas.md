# ARTHVEX — commercial SaaS layer

This describes what the code does today. Anything not listed under "Implemented" is not implemented.

## Concepts (kept separate on purpose)
| Concept | Where | Notes |
|---|---|---|
| Plan | `platform_plans`, `plan_entitlements` | Data-driven; `plan_entitlements` rows carry `effective_from/until`. Plan *versions* are **not** implemented. |
| Add-on | `addons`, `tenant_addons` | `grants` JSON: `{key, increment}` for caps, `{key, value}` for booleans. Resolved in `services/entitlements.js`. |
| Subscription | `subscriptions` (+ `subscription_events`) | One live subscription per company, enforced by `uq_live_sub` (generated column + unique index). |
| Entitlement | resolver | platform default → plan → add-ons → tenant override. An override is the last word. |
| Usage / limits | `tenant_usage`, `services/usage`, `services/limits` | Caps are checked on the write path; creations run under a per-company lock. |
| Invoice / payment / refund | `subscription_invoices`, `subscription_payments(kind)` | Integer-paise arithmetic; row-locked; over-payment refused. |
| Payment provider event | `payment_provider_events` | `UNIQUE(provider, event_id)` makes webhooks idempotent. |
| Trial | `subscriptions.trial_*`, `converted_at` | ≤ 2 extensions of ≤ 30 days, reason required, guard is atomic in SQL. |
| Cancellation | `subscriptions.cancel_*` | Immediate or at period end; never deletes data. |

## Subscription states (`services/subscriptions.js`, `TRANSITIONS`)
`trialing → active | cancelled | expired | suspended` · `active → past_due | grace_period | suspended | cancelled | expired` ·
`past_due ⇄ grace_period → active | suspended | cancelled | expired` · `suspended → active | past_due | cancelled | expired` ·
`cancelled → active` (re-subscribe) · `expired → active | cancelled`.

What a state allows for the company (enforced by one global gate in `app.js` + `entitlements.readOnly`):
* **Always:** sign in, read every record including payroll history, export, raise ARTHVEX support tickets (`/api/account`).
* **trialing / active / past_due / grace_period:** normal operation.
* **suspended / cancelled / expired:** read-only — every non-GET request outside `/auth`, `/platform`, `/v1`, `/account` is refused with 402.
* Billing state never switches a module off; it only stops writes.

## Downgrade policy
`POST /platform/subscriptions/:id/plan-preview` lists every cap the company already exceeds and every module it would lose.
Applying the change keeps all records; anything over a new cap stays but nothing more can be added (`assertWithinLimit`).
The preview is stored on the subscription event and an operator notification is created.

## Payments
* `services/payments.js` defines a provider interface (`verify`, `parse`). Shipped adapter: **`signed`** (HMAC-SHA256,
  header `x-arthvex-signature: t=<ms>,v1=<hmac("<t>.<raw body>")>`, 5-minute replay window, secret `BILLING_WEBHOOK_SECRET`).
  **No gateway-specific adapter (Razorpay, Stripe…) ships**; adding one means adding an entry to `PROVIDERS`.
* Endpoint: `POST /api/billing-webhooks/:provider` (public; the signature is the authentication; raw body).
* Events: `payment.succeeded`, `payment.failed`, `refund.succeeded`. Duplicate event ids and re-sent provider references apply nothing.
* The UI never confirms a payment; only a verified event or an operator-recorded payment changes an invoice.
* GST: invoices carry `tax_pct`/`tax`; billing contacts carry a validated GSTIN. A CGST/SGST/IGST split is **not** implemented.

## Self-service (`/api/account`, company owners)
Subscription summary, usage vs limits, invoices (read-only), add-ons, cancel-at-period-end / withdraw, billing contacts,
setup health, data-quality (record ids only), and ARTHVEX support tickets (customers see customer-visible notes only).
Immediate cancellation, pricing and plan changes stay with ARTHVEX.

## Operations (platform)
Support tickets (+SLA policies in data; none are promised unless configured), incidents (root cause + resolution required to resolve),
maintenance windows (platform or one company; 503 + message for company users and API keys; platform staff never blocked),
platform notifications (deduplicated), retention targets (intent only — nothing is deleted automatically), health (`/platform/health`).

## Not implemented
Plan versioning/grandfathering · coupon/credit objects · per-employee/tiered pricing engine · automated tax split ·
platform email-template editor and email delivery of platform events (in-app only) · SSO · backup/restore tooling ·
distributed job queue · feature-flag percentage rollout.
