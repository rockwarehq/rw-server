# 0002 – Database Access Boundary for the API App

- **Status:** Accepted (amended 2026-08-18 — see Amendment below)
- **Date:** 2026-07-08
- **Deciders:** Michael Lindenau

## Context

`@rw/services` is the business-logic layer: services own domain rules, return `{ data }` or `{ error, code }` (they never throw), and every mutation flows through them. Most oRPC routers in `apps/api/src/rpc/` follow this. A handful of routers, however, query Prisma directly — `logs.ts`, `events.ts`, `metrics.ts`, `operator.ts`, `shift-recap.ts` — all for complex, read-only reporting and aggregation (dynamic filter allowlists, shift-clamped downtime computation, bucket queries).

Forcing those reads through service functions would mean either duplicating a query-builder abstraction in the service layer or smearing one reporting concern across two packages, for no gain in safety: reads cannot corrupt state.

An audit of every direct-Prisma call in `apps/api/src/rpc/` (2026-07-08) found **zero writes** — no `create`, `update`, `upsert`, `delete`, `$executeRaw`, or `$transaction`. All direct access is read-only.

## Decision

We will keep writes strictly behind `@rw/services`: any RPC or REST handler that mutates state calls a service function. Complex **read-only** reporting/aggregation queries may use Prisma directly from RPC handlers when a service pass-through would add indirection without value.

The current sanctioned exceptions are `src/rpc/logs.ts`, `events.ts`, `metrics.ts`, `operator.ts`, and `shift-recap.ts`. Adding a new exception is a code-review decision, not a default.

Outside the RPC layer, `seed.ts` (bootstrap script), `edge.ts` (gateway protocol), and `src/auth/` (IAM resolution) also access Prisma directly by design.

## Consequences

- Reporting queries stay colocated with their endpoint and are fast to iterate on.
- The rule is greppable: `prisma.<model>.create|update|delete` in `apps/api/src/rpc/` is a review flag.
- Read queries in the API app do not benefit from service-layer reuse; if the same report is ever needed from `apps/workers`, the query moves to a service then.

## Alternatives Considered

- **Move all reads behind services** — large mechanical refactor, higher regression risk, and the service layer gains nothing from owning single-consumer reporting queries.
- **Move writes only** — already the state of the world (the audit found no direct writes); this ADR records it as a rule rather than an accident.

## Amendment (2026-08-18): direct-Prisma reads must carry authorization scope

The original rationale — "reads cannot corrupt state" — is true but incomplete:
reads can *leak* state. With centralized authorization (RW-156) every read must
be scoped to the caller's accessible sites, including the sanctioned
direct-Prisma routers. The exception list stands; the obligation on its members
changes.

**Decision.** Any handler-level Prisma read MUST:

1. Obtain scope from the policy layer before touching the database —
   `authorize(iam, { permission, scope })` when the input names a site or
   resource, `authorizeList(iam, { permission, requestedSiteId? })` otherwise.
   Authorization runs **before** any `findUnique`/`findUniqueOrThrow`, so
   resource existence is never disclosed to an unauthorized caller.
2. Apply the scope to every query: a literal `siteId` equality where the input
   requires a site, or `scopeWhere(scope)` (from `@rw/auth/iam/policy`) merged
   into the Prisma `where` via `AND` for open-ended lists. Queries are
   single-site by design: `scopeWhere` yields exactly one `siteId` (the
   requested or token-active site); tokens without site context are denied.
3. Carry the authorized `siteId` predicate on lookups of related entities
   (stations, workcenters, shift instances) so a valid site plus a foreign
   resource id cannot read across sites.

`operator.ts` is exempt from user-permission checks: it is display-principal
driven, and identity is bound to the display row (stricter than site scope).
`events.ts` ingest is processor-secret gated. Both are recorded in the
policy-coverage exclusion list with rationale.

**Enforcement.** The authorization coverage test
(`apps/api/test/policy-coverage.test.ts`) fails CI for any RPC procedure whose
handler lacks an inline `authorize`/`authorizeList` call and is not on the
commented exclusion list. This is why policy calls must appear lexically inside
handler bodies rather than behind local helpers. Scope application on
individual queries remains a review obligation, backed by the reporting
integration tests.

**Consequences.**

- Rows outside the caller's accessible sites vanish from searches — intended.
- Scoping is query-free per check: the auth plugin resolves a permission
  snapshot once per request, so gating reporting reads adds no DB round-trips.
- Cross-site probe attempts (valid `siteId`, foreign `stationId`) return
  empty/NOT_FOUND rather than data.
