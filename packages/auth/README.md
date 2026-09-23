# @rw/auth

Identity, tokens, and access checks for the Rockware platform.

There is no root export — every consumer imports a subpath:

```ts
import { AccessDenied, type Access } from "@rw/auth/iam/access";
import { hashPassword } from "@rw/auth/password";
import { verifyAccessToken } from "@rw/auth/verify";
```

## Design rules

- **One workspace per deployment.** Checks look at the tier and the **site** only.
- **Ask the caller, like Basecamp's `Current.person`.** The API's auth plugin works out who is calling once per request (`current`) and gives every handler an `access` object to ask.
- **A "no" throws.** Every check throws `AccessDenied`. Each transport turns it into its wire error in one place.
- **Never trust token claims for access.** The plugin loads the caller's bucket rows once per request (one query), so later checks need no more queries.
- **JWT checks never touch the database.** `@rw/auth/verify` has no `@rw/db` import, so services with their own Prisma pool (like livestore) can check tokens without opening a second pool.

## Module map

| Subpath | Purpose |
| --- | --- |
| `iam/access` | `Access`, `UserAccess`, `DeviceAccess`, `Person`, `loadPerson`, `AccessDenied` |
| `iam/rows` | Where a row lives: site (and workcenter) for ~50 row kinds |
| `context` | `Current`: who is calling (user, display, or API token) |
| `verify` | HS256 access-token sign/verify, per-audience HKDF keys, 15-min expiry |
| `tokens` | Rotating 7-day refresh tokens with reuse-theft detection (user + display) |
| `display-session` | Kiosk/display login, refresh, logout |
| `api-tokens` | Opaque `rw_app_` tokens — plaintext shown once, SHA-256 stored |
| `password` | bcrypt hash/compare |
| `secrets` | Opaque-secret generation, SHA-256 hashing, timing-safe compare |
| `env` | Fail-fast auth config (`JWT_SECRET` validation, key derivation) |

## Checking access in a handler

```ts
// one row: find where it lives, then check the tier there
await context.access.require("MANAGE", { statusReason: input.id });

// a site (create flows)
await context.access.require("MANAGE", { site: input.siteId });

// lists: always one site; floor lists narrow the crew to their cells.
// Spread the whole scope so the crew filter can't be left behind.
const scope = context.access.list("VIEW", input.siteId, "WORKCENTER");
return station.list({ ...input, ...scope });

// owner-only, "at some plant", and plain yes/no
context.access.requireOwner();
context.access.requireSomewhere("ADMIN");
if (context.access.can("MANAGE", { site: siteId })) { /* … */ }
```

- **Always `await` `require`.** It looks up the row first. A forgotten `await` would skip the check, so the coverage test fails the build when one is missing.
- **Missing rows are `NOT_FOUND`.** The row lookup runs before the tier check, so an unknown id says "not found" and a caller never learns more than that.
- **Rows with no site** (unassigned gateways, workspace documents) follow the "somewhere" rule. Reading needs any site. Changing needs the tier at some plant.
- **REST handlers** use `request.access` the same way. Use `currentUser(request)` for the signed-in user.

## Access model — buckets

Rows live in containers. Your access is the containers you are in.

| Container | Tier | Meaning |
| --- | --- | --- |
| **Plant** (one per site) | VIEW | member: read the common plant things (orders, catalogs, schedules, dashboards, equipment lists) |
| | MANAGE | write the plant and everything in it, every workcenter included |
| | ADMIN | people, access, and dangerous settings |
| **Workcenter** (one per cell) | VIEW | watch the cell's floor |
| | MANAGE | operate and configure the cell |

A `Person` holds only the rows they were given. Two rules are worked out at check time:

- **Membership rule.** Any workcenter access makes you a plant member (plant VIEW).
- **Cascade rule.** Plant MANAGE means MANAGE on every cell at that site.

Two kinds of people skip the buckets, like Basecamp's account roles:

- **Workspace owners** (`WorkspaceMembership.workspaceRole = OWNER`).
- **Rockware staff.** SUPPORT reads everywhere; ENGINEER manages everywhere.

**Displays and API tokens** stay outside buckets. They are bound to one site. A display may do anything at its site that its procedures allow. An API token may only read.

### Plant data vs workcenter data

- **Plant data** is shared by every workcenter at the plant: jobs, products, tools, materials, orders, customers, reason codes, shift patterns. Everyone at the plant can see it, crew included, so they can pick a job or look up a part. Only plant members change it.
- **Workcenter data** is what happens on the floor (cycles, state logs, calls, inventory made, dispositions) plus the stations themselves. It is checked on its workcenter, so crew see and change only their own workcenters' data.
- **Using plant data on the floor** is checked where the write lands. For example, `station.changeJob` needs MANAGE on the station's workcenter; the job only has to be in the same plant. Crew never need edit rights on the job.
- **Which jobs show up at which station** is not an access question. Labels and station label filters decide that.

`iam/rows.ts` groups every row kind under these headings. When you add a kind whose rows carry a `workcenterId` (on the row or its station), return it there; otherwise the row is checked as plant data.

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

Access tests build a `Person` directly and pass a fake row lookup, so no database is needed.

## Further reading

- `docs/adrs/0002-database-access-boundary.md` — why handlers must obtain scope from the policy layer before touching the database.
- `apps/api/src/rpc/policy-coverage.ts` + `apps/api/test/policy-coverage.test.ts` — the coverage gate. Every procedure and route must ask `access` (awaited) or be excluded with a reason.
