# @rw/auth

Identity, tokens, and the centralized authorization policy for the Rockware platform.

There is no root export — every consumer imports a subpath:

```ts
import { authorize, authorizeList, scopeFilter } from "@rw/auth/iam/policy";
import { hashPassword } from "@rw/auth/password";
import { verifyAccessToken } from "@rw/auth/verify";
```

## Design constraints

- **One workspace per deployment.** The policy layer enforces permission + **site** scope only; workspace containment is vacuously true and costs zero queries.
- **`authorize` never throws.** Every check returns a verified grant or a typed denial; transports decide how a denial becomes an HTTP/oRPC error.
- **Token claims are never trusted for authorization.** The API auth plugin loads a per-request `BucketSnapshot`, so every policy check in a request is query-free.
- **JWT verification is DB-free.** `@rw/auth/verify` has no `@rw/db` import, so services with their own Prisma pool (e.g. livestore) can verify tokens without opening a second connection pool.

## Module map

| Subpath | Purpose |
| --- | --- |
| `iam/policy` | `authorize` / `authorizeList` / `authorizeAccessibleSites` — the authorization decision point |
| `iam/buckets` | The bucket model: `BucketSnapshot`, hook + cascade, pure tier evaluators |
| `iam/policy-resolvers` | `RESOLVERS` table — derives a row's site/workcenter from its id (~50 kinds) |
| `verify` | HS256 access-token sign/verify, per-audience HKDF keys, 15-min expiry |
| `tokens` | Rotating 7-day refresh tokens with reuse-theft detection (user + display) |
| `display-session` | Kiosk/display login, refresh, logout |
| `api-tokens` | Opaque `rw_app_` tokens — plaintext shown once, SHA-256 stored |
| `password` | bcrypt hash/compare |
| `secrets` | Opaque-secret generation, SHA-256 hashing, timing-safe compare |
| `context` | `IAMContext` and principal types (`USER`, `DISPLAY`, `APP`, …) |
| `env` | Fail-fast auth config (`JWT_SECRET` validation, key derivation) |

## Authorization

One call per protected operation: authorize a **tier** against a **scope**. The row's workcenter stamp picks its bucket — workcenter-stamped rows live in that cell's bucket, everything else is a plant thing.

```ts
authorize(iam, { tier: "VIEW", scope: { kind: "customer", id: input.id } });
// → SiteGrant | WorkspaceGrant | PolicyDenial
```

`ScopeRef` kinds:

| Scope | Meaning |
| --- | --- |
| `{ kind: "workspace" }` | Ownership-level action (workspace owners; staff unless `ownerOnly`) |
| `{ kind: "anySite" }` | VIEW: any visible site; higher tiers: held at ≥1 plant |
| `{ kind: "site", siteId, workcenterId? }` | Literal ids from input/params (workcenterId routes to that cell's bucket) |
| `{ kind: "order", id }`, … | A resource ref — its site/workcenter is resolved via `RESOLVERS` |

Denials carry a code, never an exception: `UNAUTHENTICATED`, `NO_WORKSPACE`, `NOT_FOUND`, `FORBIDDEN`. Resource resolution runs **before** the tier check, so a nonexistent id is `NOT_FOUND` and existence is never disclosed to an unauthorized caller.

### In an oRPC handler

The `grant()` adapter (`apps/api/src/rpc/authz.ts`) unwraps a grant or throws the mapped `ORPCError`:

```ts
export const get = authRequired.input(idInputSchema).handler(async ({ input, context }) => {
  grant(await authorize(context.iam, { tier: "VIEW", scope: { kind: "customer", id: input.id } }));
  return unwrap(await customerService.getById(input.id));
});
```

### List queries — single-site by design

A user works within one site, so list queries are never cross-site. `authorizeList` scopes to the requested site or, absent one, the token's active site. `bucketKind` says where the listed rows live: `"PLANT"` lists need plant membership at the tier; `"WORKCENTER"` (floor) lists give plant managers the whole floor and narrow the crew to their cells via `scope.workcenterIds` + `scopeWorkcenterWhere` (site-level rows stay readable — they are plant things):

```ts
export const list = authRequired.input(listInputSchema).handler(async ({ input, context }) => {
  const scope = grant(
    await authorizeList(context.iam, { tier: "VIEW", bucketKind: "PLANT", requestedSiteId: input.siteId }),
  );
  return customerService.list({ ...input, ...scopeFilter(scope) });
});
```

The one sanctioned multi-site shape is `authorizeAccessibleSites` (site picker / directory surfaces). REST handlers use `replyPolicyDenial()` (`apps/api/src/api/authz.ts`) instead of `grant()`:

```ts
const scope = await authorizeAccessibleSites(request.iam, {}); // membership visibility
if (!scope.ok) return replyPolicyDenial(reply, scope);
return site.list({ ...request.query, workspaceId: scope.workspaceId, siteIds: scope.siteIds });
```

## Access model — buckets

Rows live in containers; your access is the containers you are in. There is no permission vocabulary.

| Container | Tier | Meaning |
| --- | --- | --- |
| **Plant** (one per site) | VIEW | member: read all the common plant things (orders, catalogs, schedules, dashboards, equipment lists) |
| | MANAGE | write the plant and everything in it — cascades to every workcenter |
| | ADMIN | the reserved shelf: people, access administration, dangerous settings |
| **Workcenter** (one per cell) | VIEW | watch the cell's floor |
| | MANAGE | operate and configure the cell |

Two rules complete it: **any workcenter access makes you a plant member** (the hook), and **plant MANAGE implies MANAGE on every cell** (the cascade). Above the buckets sit exactly two bypasses, like Basecamp account roles: `WorkspaceMembership.workspaceRole = OWNER` (reserved ownership) and Rockware staff (SUPPORT reads everywhere, ENGINEER manages everywhere).

Buckets are DB rows born with their sites and workcenters; accesses are `BucketAccess` rows (membership ↔ bucket ↔ tier). `loadBucketSnapshot(userId, workspaceId)` captures ownership/staff standing and all accesses (hook and cascade applied) in three queries; the pure evaluators (`snapshotPlantTier`, `snapshotWorkcenterTier`, `snapshotVisibleSites`, `snapshotWorkcenterIds`) run against it without touching the DB. Displays and app tokens stay outside the model: simple site-bound token auth, unchanged.

## Tokens & sessions

- **Access tokens** — HS256, 15 minutes, per-audience keys derived from `JWT_SECRET` via HKDF (`rw-user`, `rw-display`).
- **Refresh tokens** — opaque, 7 days, rotated on use; presenting a rotated token outside the 60-second grace window revokes the whole family (theft detection).
- **Display sessions** — kiosks log in with a bootstrap secret and get the same rotating-refresh lifecycle.
- **API tokens** — `rw_app_<64 hex>`, plaintext returned exactly once, SHA-256 stored for O(1) lookup; v1 scope is `graph:read`.

## Development

```sh
pnpm --filter @rw/auth build   # tsc -b
pnpm --filter @rw/auth test    # vitest, runs against src (no build needed)
```

Policy tests inject fakes through `createPolicy(deps)` — no DB required.

## Further reading

- `docs/adrs/0002-database-access-boundary.md` — why handlers must obtain scope from the policy layer before touching the database.
- `apps/api/src/rpc/policy-coverage.ts` + `apps/api/test/policy-coverage.test.ts` — the coverage gate: every procedure/route must call the policy layer or be explicitly excluded with a reason.
