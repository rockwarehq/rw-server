# Permission simplification rollout

## Model

The permission catalog has eight customer-facing keys:

| Responsibility | Permissions |
| --- | --- |
| Production, including catalog and inventory | `production:read`, `production:write`, `production:admin` |
| Orders and scheduling | `planning:read`, `planning:write` |
| Technical setup | `configuration:read`, `configuration:write` |
| People/access and plant administration | `plant:admin` |

Write implies read. Production admin implies write/read at the same scope. `plant:admin` and `owner:all` are independent capabilities, not wildcards. Roles remain permission bundles; authorization never depends on a customer role's name.

Built-ins:

- **Plant Member:** `planning:read`; production visibility comes from workcenter access.
- **Planner:** `planning:write`; live production/report visibility still follows workcenter access.
- **Plant Engineer:** plant-wide `production:admin`, `planning:write`, `configuration:write`.
- **Plant Admin:** Engineer permissions plus `plant:admin`.
- **Company Administrator:** all capabilities and reserved company ownership, at workspace scope.

Internal Rockware SUPPORT/ENGINEER roles are separate from customer roles.

WORKCENTER custom roles may contain Production permissions. The existing View/Manage controls remain READ/WRITE grant records, evaluated only as local Production read/write. A narrower grant does not subtract from a broader one. Shared product/job/material/tool definition changes and manual plant-stock adjustments require plant authority; local production may update stock as an ordinary consequence of an authorized operation.

## Migrations

- `20260923000000_simplify_permissions` adds workcenter role assignments and backs up every existing role's exact permission array in `Role.legacyPermissions`. Built-in roles retain IDs. New presets are inserted. Custom-name collisions are preserved rather than promoted to system roles.
- Custom permissions migrate only when the complete prerequisite set for a new responsibility exists in the same role. There is no union of unrelated legacy grants. The mapping and missing prerequisites are described by `LEGACY_PERMISSION_MIGRATION_RULES` and checked against the SQL migration by tests. Partial bundles can lose capabilities and need explicit review.
- `20260923001000_terminal_comment_authorship` adds typed author/provenance fields and deleting-user attribution. Existing known User authors are preserved; missing historical authors remain UNKNOWN. A database trigger preserves author identity. Bound-station deletion is restricted until displays are explicitly reassigned or unassigned.
- Display IDs, bootstrap hashes, refresh tokens, site/station assignments and existing logon sessions are not rewritten by these migrations.

The historical migration chain includes PostgreSQL 18 named NOT NULL constraints; the full-chain integration tests use PostgreSQL 18.

## Preview before deployment

After building the new packages, run against an explicitly selected connection:

```sh
pnpm build
pnpm permissions:preview --help
DATABASE_URL="$PREVIEW_DATABASE_URL" pnpm permissions:preview
DATABASE_URL="$PREVIEW_DATABASE_URL" pnpm permissions:preview --json --workspace-id <uuid>
```

The script uses a read-only, repeatable-read transaction and works both before and after the migrations. It prints:

- Built-in and custom role changes, assignment scopes and missing prerequisites.
- Workcenter grant expansions being removed.
- Custom roles colliding with built-in names.
- Claimed terminal station/site bindings and IDs whose bootstrap credential is missing.

Credential values are never included. After migration, the preview uses backups to reconstruct the original mapping and shows current permissions separately. The script has no apply option.

Review the effective access changes before deployment, particularly:

1. Plant Members now need explicit workcenter grants for production visibility.
2. Workcenter WRITE no longer edits plant-wide schedules, catalog or technical configuration.
3. A partial legacy custom role may not satisfy a complete new permission group.
4. An existing custom role named Planner or Plant Engineer must be renamed before that built-in can be seeded.

Use deliberate role assignments for the target access. Do not promote old workcenter writers to Plant Engineer automatically.

## Already-provisioned terminals

### Preserved contracts

- Registration, claiming, display login, refresh rotation/grace, logout, IDs and bootstrap credentials.
- Existing DISPLAY JWT payloads; no new station or operator claims are required.
- A station assignment means fixed-station operation. A site-provisioned display with no station assignment may select any station in that site, including another workcenter.
- `Display.workcenterId` remains presentation metadata rather than an extra operating boundary.
- Published dashboard/picker reads retain their site-bound behavior.
- Basic operations and comment creation remain possible without employee identification.
- Historical job corrections remain approved terminal operations.
- The alternate-material selector remains a narrowly allowed shared-product operation. It validates same-site ownership and membership in the existing alternate group; the selection can affect other stations using that product.

There is no existing authoritative monitor/operator flag. This release does not infer a read-only device from a missing station assignment or absent attrs.

### Intentional behavioral changes

| Behavior | Client impact |
| --- | --- |
| Fixed-station mutation enforcement | A bound terminal operating a different station is denied. Explicitly unassign its station if the intended provisioning is site-wide. |
| No DISPLAY administrator bypass | Restricted call answers/mode actions require an eligible identified employee. Unrestricted actions still work terminal-only. |
| Validated employee attribution | Arbitrary `employeeId` input is no longer accepted as identity evidence. |
| Typed comment authors | Clients should render `author` and tolerate `createdBy: null` for Employee/Display authors. |
| Administrative comment deletion | Authorship alone no longer permits deletion; a USER needs scoped Production admin or Plant administration. |
| Station deletion protection | Station deletion returns 409 while displays remain bound, including races caught by the database FK. |

Functioning terminals do not require re-provisioning. A device with a pre-existing missing/lost bootstrap credential is a separate recovery case; do not force credential rotation as part of this change.

## Employee identity contract

Employee-attributed actions accept optional `operatorSessionId`. The server validates an active session on the authenticated display and its site, and rechecks the employee's current status and site access. Employee-number/badge methods produce IDENTIFIED assurance; PIN produces VERIFIED assurance. A generic-name session retains terminal ownership.

Identity follows station selection within a site-provisioned terminal. The session's station is attendance metadata and is not required to equal the current action's station. Every action independently validates terminal target scope. Switching station does not rewrite attendance; ending a session ends its use as identity evidence.

For older clients, `employeeId` remains accepted only if exactly one active matching session exists on that display/site. No session is selected implicitly when no actor is requested. Ambiguous, foreign, ended or inactive identity contexts are rejected with 403 and a machine-readable reason such as `OPERATOR_SESSION_REQUIRED`, `OPERATOR_SESSION_INVALID` or `OPERATOR_EMPLOYEE_MISMATCH`.

These are action denials, not device-authentication failures. Clients should prompt for the appropriate identity context without clearing bootstrap credentials or initiating a new claim. Normal 401 handling still refreshes display access tokens.

Account users act as their authenticated User. An optional linked Employee can supply attribution; an unrelated or inactive plant Employee link does not remove the User's account authority. Explicitly claiming another employee is rejected.

## Comment ownership

- Terminal-only create requires no identification; the UI may encourage identification.
- User, Employee and Display authors are recorded independently of source-display provenance.
- The same identified person may edit their own comments; editing introduces no additional mandatory PIN challenge.
- A terminal can edit its own terminal-authored comment after an employee identifies themselves. Merely using the source terminal does not permit editing a person-authored comment.
- New User comments snapshot an existing employee link. Legacy User comments are not reassigned based on later account/profile links.
- Administrative deletion is soft deletion and records `deletedById`. Plant Engineer includes Production admin and can delete within the plant. Workcenter Manage and terminals cannot delete comments. Administrators cannot rewrite another author's comment.

## Client and deployment order

The account access response keeps its existing structural fields, but permission strings change. Roles can now have scope WORKCENTER and carry `workcenterId`. `/users/me` includes effective per-workcenter permissions from both shortcut grants and custom-role assignments. Flat site permissions deliberately exclude workcenter-only grants.

1. Run the preview and resolve role/name-collision decisions.
2. Update account navigation/action gates to the eight keys. Keep terminal actions separate from account permission gates.
3. Update terminal attribution/author rendering, retain acting identity across station selection, and handle explicit 403 reasons.
4. Coordinate the new API/live server release with both migrations. The checked-in migration performs the permission conversion: deploying it alone ahead of old authorization code is not a supported rolling-deploy strategy. Use a coordinated cutover or a separately tested compatibility release if continuous mixed-version service is required.
5. Run seeding to ensure built-in presets, and verify representative Member, Planner, Engineer, Admin and terminal flows.

This repository contains server and client contracts, not the terminal UI application. Terminal-client adoption must be checked in that application before enforcement. The current raw-ID-to-active-session adapter supports compatible older clients without restoring arbitrary identity or administrator bypasses.

## Read-scope limits

Account-user reports, metrics, historian, native entity reads and graph/live subscriptions enforce workcenter scope. Legacy historical rows with null ownership stamps fall back to actual station ownership; explicit historical stamps remain authoritative.

Scoped users cannot access unprovable raw point/tag ownership, dynamic whole-site/job aggregates, or graph facet queries without an enforceable ownership contract. Grant plant-wide production access only when intended. DISPLAY/APP published graph reads retain their site-scoped contracts; APP requires the existing `graph:read` token scope and never gains user permissions.

Livestore revalidates USER membership/grants. Published-graph ownership checks have a bounded five-second cache with invalidation on revalidation/UI changes; token validation has its separate bounded cache.

## Verification

Relevant suites include IAM policy/assignment/migration tests, API `terminal-compatibility`, `permission-migration`, account/workcenter authorization tests, and service/historian/Livestore scope tests.

Run database suites against isolated PostgreSQL 18 databases. API global setup migrates and seeds `TEST_DATABASE_URL`; service/historian integration fixtures use `DATABASE_URL`. Use different databases when running those suites concurrently so fixture users cannot cause API bootstrap to skip the seeded account.

```sh
pnpm build
pnpm --filter @rw/auth test
TEST_DATABASE_URL="$API_TEST_DATABASE_URL" DATABASE_URL="$API_TEST_DATABASE_URL" pnpm --filter @rw/api test
DATABASE_URL="$SERVICE_TEST_DATABASE_URL" pnpm --filter @rw/services test
DATABASE_URL="$SERVICE_TEST_DATABASE_URL" pnpm --filter @rw/historian test
pnpm --filter @rw/livestore test
```
