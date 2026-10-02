# Administration Center

The Administration Center is the tenant-scoped back office of Arthvex HRMS. It is where a
company's own HR administrator manages logins, roles, permissions, org structure,
modules, security policy, bulk data and the audit trail — without touching the database.

Base path: `frontend → /administration/*` · `backend → /api/administration/*`

> Cross-tenant work (provisioning other companies) lives in the same UI under
> **Companies**, but it is gated on `platform.tenants.*` and is deliberately *not*
> reachable through the company's own `administration.access.*` permissions.

---

## 1. Sections

`GET /api/administration/meta` is the contract the UI renders from. Each entry carries
`key`, `path`, `label`, `permission` and `accessible`:

| Section | Path | Gate |
|---|---|---|
| Administration Center (dashboard) | `/administration` | `administration.view` |
| Organization Builder | `/administration/organization` | `administration.organization.view` |
| Teams | `/administration/teams` | `administration.organization.view` |
| Positions | `/administration/positions` | `administration.organization.view` |
| Users & Access | `/administration/users` | `administration.users.view` |
| Roles | `/administration/roles` | `administration.roles.view` |
| Permissions | `/administration/permissions` | `administration.permissions.view` |
| Access Review | `/administration/access` | `administration.access_preview.view` |
| Companies | `/administration/tenants` | `platform.tenants.view` |
| Workflows | `/administration/workflows` | `administration.workflows.view` |
| Custom Fields & Forms | `/administration/customization` | `administration.custom_fields.view` / `administration.forms.view` |
| Master Data | `/administration/master-data` | `administration.master_data.view` |
| Modules & Features | `/administration/modules` | `administration.modules.view` |
| Security | `/administration/security` | `administration.security.view` |
| Configuration History | `/administration/config` | `administration.config.view` |
| Bulk, Import & Export | `/administration/data` | `administration.bulk.manage` |
| Onboarding | `/administration/onboarding` | `administration.onboarding.view` |
| Audit Trail | `/administration/audit` | `administration.audit.view` |

**How access is enforced.** The frontend hides anything `accessible: false`, but that is
only a convenience. Every endpoint re-checks the permission server-side, so a user who
types a URL they are not entitled to gets `403`, not data. `AdminSection` in
`frontend/src/pages/administration/shared.jsx` is the client-side mirror of the server.

---

## 2. Users, roles and permissions

**Users & Access** (`/administration/users`)
- List with search and filters; open a user for roles, direct grants/denies, sessions and
  effective access.
- Create a login — the API returns a **temporary password shown once**; the user must
  change it at first login.
- Invite by email — returns an accept token/link valid for 7 days; revoke a pending invite.
- Assign roles, replace role assignments, grant/deny individual permissions, issue a
  password reset, revoke sessions.
- Pending access requests are listed here and can be approved or rejected.

**Roles** (`/administration/roles`)
- System roles are read-only; `protected` roles cannot be edited or deleted.
- Create or edit a custom role from the permission matrix (module → permission → scope).
- Attach **permission groups** to a role instead of hand-picking hundreds of permissions.
- Compare any two roles (`common` / `onlyInA` / `onlyInB` / `scopeDifferences`).
- Clone a role to branch a variant without touching the original.
- A role you do not hold cannot be edited — the API reports `beyondYourAccess`.

**Permissions** (`/administration/permissions`)
- The full catalog with module, base permission, scope and legacy aliases.
- The **matrix** view (module → base permissions → scopes) drives the role editor.

**Access Review** (`/administration/access`)
- *My access* — the caller's own effective permissions.
- *By user* — any user's effective access, including explicit denies and scoped resources.
- *Explain* — why a specific permission is present or absent.

---

## 3. Organization

- **Builder** — departments, business units, locations, designations, grades and cost
  centres, with headcount and vacancy roll-ups, plus an org **health** check that reports
  departments without a head, positions without a department and orphaned custom fields.
- **Teams** — team CRUD and membership (members are *employees*, never logins).
- **Positions** — CRUD plus a **pipeline** view: who fills the position today and the
  internal candidates for it.

---

## 4. Modules & Features

`/administration/modules` lists the module catalog with its category and default state.
Toggling a module writes a per-company feature flag; `POST /administration/modules/:key/reset`
restores the default. Disabling a module makes its API return `403`:

```json
{ "error": "REQUEST_ERROR", "message": "The travel module is disabled for this company" }
```

A module with no stored configuration falls back per module to the catalog default, so a
partially configured tenant never loses access to features it never opted out of.

---

## 5. Security

`/administration/security`
- **Overview** — users, MFA adoption, active sessions, failed logins.
- **Policies** — keyed settings (`audit.retention_days`, `password.*`, `session.*`, …).
  Each can be edited, and any non-default value can be reset to the default.
- **IP restrictions** — allow/deny rules evaluated by the auth middleware.

---

## 6. Configuration history

`/administration/config` snapshots a configuration key before it changes. Each version keeps
the module, the JSON payload and who changed it; a version can be rolled back, which writes
a *new* version rather than deleting history.

---

## 7. Bulk, import & export

`/administration/data`
- **Bulk operations** — apply an operation to up to 500 selected records
  (e.g. `assign_role:<roleId>`, `reset_password:…`). Records outside the company are
  reported as skipped, never silently modified.
- **Import** — paste CSV (or send rows) for a data set. Always **dry-run first**:
  the response reports `received`, `valid`, `created` and a `rejected[]` list with a
  per-row reason. Partial imports are therefore never a mystery.
- **Export** — CSV download per data set; each data set is gated on its read permission.

---

## 8. Audit trail

`/administration/audit` is the append-only log of administrative actions: actor, role,
action, module, entity, IP, request id and outcome, filterable by module/actor/action/entity
and date range, with a CSV export. Activity charts come from `/administration/audit/stats`.

---

## 9. Seeded demo data

`npm run db:seed` (destructive — it rebuilds demo data) provisions a company owner, HR,
payroll, finance and auditor logins plus the Administration Center fixtures: 27 modules,
13 roles, 24 permission groups, 3 invitations, 3 access requests, IP restrictions,
configuration versions, approval rules, relationship types and open org-health issues.

Passwords for all seeded logins are `Password@123` (see `FEATURES.md` §2).

---

## 10. Implementation map

```
backend/src/routes/administration/
├── index.js            meta + health, mounts the subrouters
├── access.js           roles, permission groups, catalog/matrix, access preview & explain
├── users.js            users, roles, direct grants/denies, invitations, sessions, requests
├── organization.js     structure, health, teams (+members), positions (+pipeline), relationships
├── platform.js         modules, menus, widgets, security, onboarding, config versions, tenants
├── operations.js       dashboard, bulk, import/export, audit (+stats/export)
├── customization.js    custom fields, custom values, forms
├── masterdata.js       master-data categories & items
├── workflows-config.js workflows, versions/publish/rollback, SLA rules, approval rules
└── _shared.js          tenant guards, CRUD helper, validation, paging, audit

frontend/src/pages/administration/
├── shared.jsx          meta context, AdminShell, AdminSection, loaders, Toggle, PageHeader
└── Dashboard · Organization · Teams · Positions · Users · Roles · Permissions
    AccessReview · Companies · Modules · Security · ConfigHistory · Onboarding
    Audit · DataOps · Workflows · Customization · MasterData
```

Permissions, aliases and the module catalog live in `backend/src/utils/permissions.js`;
effective-permission resolution and cache invalidation in `backend/src/services/rbac.js`.
The security suite covering this area is `backend/tests/admin-security.test.js`
(`npm run test:admin`).