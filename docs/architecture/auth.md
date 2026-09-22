# Auth & IAM

Authentication and authorization split across two layers: `packages/auth` owns tokens, IAM context, and RBAC; `apps/api/src/auth/` owns the Fastify wiring (plugin, session routes).

## Principals

Every request resolves to an `IAMContext` (`packages/auth/src/context.ts`) with one of five principals:

| Principal | Who | Token | Scope |
| --- | --- | --- | --- |
| `USER` | Human user | 15-min access JWT + 7-day refresh token | workspace, optional site |
| `DISPLAY` | Shop-floor display device | Display JWT | bound to one site (+ optional dashboard/workcenter/station) |
| `APP` | Customer integration | Opaque `rw_app_…` API token | workspace + site, read-only (`graph:read`) |
| `WORKER` | Internal process | — | internal |
| `UNKNOWN` | Failed/absent auth | — | none |

The Fastify auth plugin (`apps/api/src/auth/plugin.ts`) runs as a preHandler on every request: it inspects the `Authorization` header, routes by token shape (`rw_` prefix → API-token lookup, otherwise JWT verify), hydrates the principal from the DB (user status, workspace membership, site access), and sets `request.iam`.

## JWT design (`packages/auth/src/verify.ts`)

Hardened in the `feat(auth)` commit series (`229ca44`…`de91f01`):

- **Startup secret validation** (`env.ts`): production boot crashes unless `JWT_SECRET` is set, ≥ 32 chars, and not the dev default. No silent fallback.
- **Algorithm pinning**: HS256 only — no alg-confusion attacks.
- **Per-principal keys**: signing keys are HKDF-derived from the master secret per audience (`rw-auth:<audience>:v1`), so a user token can never verify as a display token.
- **`iss`/`aud`/`exp`/`iat` enforced** on every verify.
- **Expired vs invalid distinguished** — clients get `TOKEN_EXPIRED` (refresh and retry) vs `TOKEN_INVALID` (re-login).

## Refresh tokens (`packages/auth/src/tokens.ts`)

- Stored only as SHA-256 hashes; 7-day expiry; rotation on every `/auth/refresh`.
- **Reuse detection with family revocation**: presenting an already-rotated token means the family is compromised — all refresh tokens for that user are revoked and every device re-authenticates.
- Login and password-change endpoints are rate-limited (brute-force protection config in `apps/api/src/config.ts`; user lockout state on the `User` model).

## API tokens (`packages/auth/src/api-tokens.ts`)

Opaque `rw_app_`-prefixed tokens for customer integrations: SHA-256 hash lookup (O(1)), workspace+site-scoped, v1 scope is read-only `graph:read`, `lastUsed` updated at most every 5 minutes (fire-and-forget). Rejections don't reveal whether a token exists. The livestore app verifies these without opening a second DB pool (prisma-free verifier).

## Secrets hygiene (`packages/auth/src/secrets.ts`)

- `safeEqual()` — SHA-256 both sides, then `timingSafeEqual`; used anywhere a shared secret is compared (e.g. gateway tokens in `apps/api/src/edge.ts`).
- Opaque tokens use deterministic SHA-256 (fast lookup); **user passwords use bcrypt** — different tools for different jobs.

## RBAC

Roles remain database-backed permission bundles, including customer-defined roles. The code-defined registry in `packages/auth/src/iam/permissions.ts` exposes eight customer permissions:

| Family | Permissions | Scope |
| --- | --- | --- |
| Production | `production:read`, `production:write`, `production:admin` | Plant or workcenter |
| Planning | `planning:read`, `planning:write` | Plant |
| Technical setup | `configuration:read`, `configuration:write` | Plant |
| Plant administration | `plant:admin` | Plant |

Workspace assignments extend the applicable permissions across their company. `owner:all` remains a reserved company-ownership capability. Write implies read; Production admin implies write/read at the same scope. `plant:admin` and ownership are independent capabilities, not implicit permission wildcards.

Built-in site roles are **Plant Member** (planning reads and shared references), **Planner** (planning write), **Plant Engineer** (plant-wide Production admin, Planning write, Configuration write), and **Plant Admin** (Engineer plus Plant administration). Plant Engineers can delete production comments but cannot invite users or assign access. Internal `SystemRole.ENGINEER` and `SUPPORT` are separate, code-managed staff roles.

`RoleAssignment` supports WORKSPACE, SITE and WORKCENTER roles. Workcenter custom roles can contain Production permissions only. The existing `WorkcenterGrant.READ/WRITE` controls are shortcuts for scoped Production read/write; they confer no plant-wide planning, catalog, inventory, or configuration writes. Grants are additive, and workcenter grants never flow upward into plant authority.

The API loads a permission snapshot once per authenticated request. Handlers obtain proven resource/list scope from `authorize` and `authorizeList`. Read queries, reporting and live subscriptions apply the workcenter predicate as well as the site predicate. `authorizeReferenceRead` is an explicit exception for shared catalog, stock summaries and directory data; it must not authorize live production history. Site entry uses membership visibility rather than a technical-resource permission.

## Operator terminals and employees

Operators need no User account. A claimed Display authenticates using its existing device credentials. Its operational authority is defined by `packages/auth/src/iam/terminal.ts`:

- A display assigned to a station can perform station-owned mutations only there.
- A site-provisioned display without a station assignment may choose any station in that site. `workcenterId` is presentation metadata, not a further restriction.
- Existing published/dashboard/picker reads remain site-bound.
- Supported terminal actions include job selection, historical job corrections, downtime, calls, modes, dispositions and comments. The approved alternate-material selector is an explicit shared-product exception; it does not grant general catalog editing.
- Account-user administrative checks never succeed just because a request comes from a Display.

Employee attribution is optional for ordinary operations and comment creation. `operatorSessionId` identifies an active session belonging to the authenticated display/site. Identity can follow station selection without moving the session's attendance station. A legacy `employeeId` is accepted only when it resolves to exactly one matching active session. Employee and site-access status are rechecked. Employee-number/badge identification is recorded as IDENTIFIED, PIN verification as VERIFIED, and account identity as ACCOUNT; a generic name remains terminal identity. These distinctions do not introduce a universal PIN requirement.

## Comments

Comments have an immutable User, Employee, Display, or historical UNKNOWN author, separately from source-display provenance. Existing `createdById`/`createdBy` fields remain available for User authors; clients should render the additive `author` object for all author types.

- Creation from a terminal requires no employee identification.
- Editing requires the same resolved author and access to the comment's location. An enabled identification method suffices; commenting introduces no extra PIN requirement. The same terminal can edit its terminal-authored comment after an employee identifies themselves, but device provenance cannot edit person-authored comments.
- New User-authored comments snapshot their employee link where one exists, allowing the same identified person to edit through a permitted terminal. Historical comments do not infer authorship from links added later.
- Deletion is a soft-delete by a USER holding plant-scoped `plant:admin` or scoped `production:admin`. Deleting another author's comment does not permit rewriting it. The deleting user is recorded.

## Migration and client rollout

See [Permission simplification rollout](permission-simplification.md) for the read-only preview command, custom-role mapping, terminal compatibility changes, deployment order and verification.

## Session flow (app-side, `apps/api/src/auth/session.ts`)

`login()` → access + refresh pair; `refreshSession()` → rotate; `logout()` → revoke + audit log; `switchWorkspace()`/`switchSite()` re-issue the access token with new scope claims. Auth-relevant actions (login success, password change, token creation, …) are recorded in `AuditLog` with actor, IP, and user agent.
