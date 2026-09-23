# Spike: Basecamp-bucket access control (v3 — Plant + Workcenter)

**Throwaway branch. Do not merge.** This explores access control architected
like Basecamp's buckets: rows live in containers, your access is the
containers you are in, and that's the whole model. No permission strings.

## The model (two containers, one ladder)

| Container | Who's in it | Tier | Meaning |
| --- | --- | --- | --- |
| **Plant** (one per site) | everyone at the plant | **member** (VIEW) | read all the common plant things: orders, customers, schedules, catalogs, taxonomy, jobs, stock, dashboards, documents, equipment lists |
| | | **MANAGE** | write the plant and everything in it — including every workcenter (the cascade) |
| | | **ADMIN** | the reserved shelf: people/rosters, access administration, dangerous settings |
| **Workcenter** (one per cell) | the crew | **VIEW** | watch this cell's floor |
| | | **WORK** | operate it (jobs, downtime, calls, comments) |

Completing rules:
- **Membership hook:** any workcenter access ⇒ plant member. "Everyone at
  the plant is a member" is literal, including grant-only crew.
- **Cascade:** plant MANAGE ⇒ MANAGE on every workcenter bucket at the
  site, with zero per-cell rows.
- **Floor visibility is crew membership**, not plant membership — same as
  the shipped target model.
- **Unhomed rows** (device pool, workcenter-less stations): workspace-owner
  territory. A rule in the gate, not a container.
- Workspace owners (Company Administrator) and staff bypass, like the
  Basecamp account owner.

Role translation from the shipped 8-key model is exact: Plant Member →
plant member · Plant Engineer → plant MANAGE · Plant Admin → plant ADMIN ·
WorkcenterGrant READ/WRITE → workcenter VIEW/WORK · Company Administrator
→ owner. **Two concepts replace eight keys + implication rules + grant
maps.**

## How the containers got here (the review trail)

- v1 shipped three site containers (Office / Library / Config) + workcenter
  buckets. Review found five placement problems: Library mixed two write
  audiences, jobs and stock were parked by default rather than by
  principle, consume-universal artifacts (dashboards) were scattered,
  people-administration had no container, and null-site rows were
  untouchable by anyone.
- A 6-kind fix (add People + HQ, split cleanly) solved all five but
  multiplied places — rejected: containers are supposed to be few.
- The keeper insight: **containers separate readers; tiers separate what
  members do.** At a plant there are only two read-worlds that matter —
  "everyone here" and "this cell's crew". That collapses every site
  container into ONE Plant bucket whose ladder (member / manage / admin)
  carries the write distinctions, with the reserved shelf handling the few
  admin-only reads (people data).

## What the code shows (all pinned by tests)

- The crew operates its cell, reads the plant's common things, configures
  nothing; configuring any station is plant MANAGE via the cascade — no
  per-cell grants for managers.
- A member reads orders and catalogs and sees no floor.
- MANAGE writes orders, equipment, and any station; rosters still deny.
- ADMIN reads rosters (`bucket/members`) on top of everything MANAGE has.
- The owner alone touches unhomed rows (pool gateway, workcenter-less
  station); for everyone else they don't exist.
- `bucket/list` shows the whole access story in one call — hook and
  cascade entries included.

## Deltas vs the shipped model (the price of two containers)

1. **Planner merges into plant MANAGE.** A three-step ladder has no
   "writes orders but not equipment" rung. If that role matters, the
   escape is one extra rung on the Plant ladder (WORK = planning writes) —
   a tier, not a container.
2. **Crew reads the order book** (membership hook makes them plant
   members). Arguably a feature: the floor sees what to produce.
3. **Members read equipment/config lists** (they're common things);
   changing them stays MANAGE.
4. **People data goes wholly behind ADMIN** — engineers no longer read the
   roster.

## What still fights the schema (unchanged from v1, still true)

- Fact-row `workcenterId` is a drifting BI stamp (`station.move` re-points
  without re-stamping 9 fact tables; job amendments re-stamp from current
  state). Crew-visible history vs moved machines needs a decision the key
  model never forced.
- One-row-many-buckets cases remain: site-level `ShiftInstance`,
  `ProductStock`, multi-target `DocumentLink`, SITE-grain metric rollups —
  though under v3 they all land naturally in the Plant bucket, which
  defuses most of them.
- Site-wide aggregation surfaces (reports, recap, metrics, log search)
  need "union of my workcenter buckets" narrowing (`bucketWorkcenterIds`
  is the seam). This is the bulk of real adoption work.

## What the spike fakes

Rows don't carry `bucketId` (the resolver derives it from existing
ownership columns); no per-request snapshot caching; devices keep site
binding instead of bucket binding; staff SUPPORT is a full bypass instead
of a read-only ceiling; aggregation surfaces stay on the existing policy.

## Verdict

v3 is the version worth taking seriously. It is *simpler than the shipped
model* (two containers and a ladder vs eight keys, implication rules and
grant maps), it translates the shipped built-ins exactly, and the
migration path is incremental: keep the shipped evaluator, put buckets on
top as the sharing/administration surface (compiling to roles + grants),
and only swap the enforcement underneath if the surface proves itself.

## Running it

```sh
psql .../rockware -c 'CREATE DATABASE rw_bucket_spike'
cd packages/db && DATABASE_URL=.../rw_bucket_spike DATABASE_URL_MIGRATION=.../rw_bucket_spike pnpm prisma migrate deploy
pnpm --filter @rw/db prisma:generate && pnpm build
cd apps/api && TEST_DATABASE_URL=.../rw_bucket_spike DATABASE_URL=.../rw_bucket_spike pnpm vitest run test/bucket-spike.test.ts
```
