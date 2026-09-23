# Spike: Basecamp-bucket access control

**Throwaway branch. Do not merge.** This explores what our access control
would look like if it worked like Basecamp's buckets: every row lives in
exactly one bucket, your access is the list of buckets you are in, and
that's the whole model. No permission strings anywhere.

## What was built

- `Bucket` + `BucketAccess` tables (`packages/db/schema/iam.prisma`, spike
  section) with a migration that bootstraps buckets from existing data and
  compiles today's roles + workcenter grants into bucket memberships.
- One evaluator file (`packages/auth/src/iam/buckets.ts`, ~230 lines): one
  snapshot loader, **one resolver**, **one gate** (`authorizeBucketTier`),
  two visibility helpers. This file replaces, for the converted slice: the
  permission catalog, the implication rules, 54 per-kind policy resolvers,
  and the role/grant evaluators.
- A converted vertical slice: station get/update/changeJob, order
  list/create, product list, gateway update, the bare site tree, plus a new
  `bucket.list` / `bucket.members` admin surface.
- `apps/api/test/bucket-spike.test.ts`: 8 passing tests against a dedicated
  database (`rw_bucket_spike`) exercising the whole model.

## The shape of the model

| Bucket kind | What lives in it | Who's usually in it |
| --- | --- | --- |
| one per **workcenter** | stations, cycles, downtime, calls, comments | operators (WORK), cell leads (MANAGE), viewers (VIEW) |
| **Office** (one per plant) | orders, customers, scheduling, stock | planners (WORK), members (VIEW) |
| **Library** (one per plant) | products, materials, tools, jobs-as-definitions, status reasons, labels | *everyone in any bucket at the plant, automatically (VIEW)* |
| **Config** (one per plant) | gateways, datasources, graph, integrations | engineers (MANAGE) |

Three tiers: `VIEW < WORK < MANAGE`. Workspace ownership (`owner:all`) and
Rockware staff bypass buckets entirely, like the Basecamp account owner.

Access questions become one sentence: *"Is Maria in the Line 2 bucket, and
at what tier?"* The admin UI is a roster per bucket (`bucket.members`), and
a user's whole access story is `bucket.list`.

## What felt great in code

1. **One gate.** Every converted handler is
   `authorizeBucketTier(iam, { ref, tier })`. No choosing a permission key,
   no wondering whether reads should be `production:read` or
   `configuration:read` — the decision was made once, when the data was
   assigned to a bucket. The month of call-site mapping this repo just did
   (iterations 3–5) was exactly the cost of NOT having that property.
2. **One resolver.** `resolveBucket()` (a switch with 4 arms) stands in for
   `policy-resolvers.ts`'s 54 kinds. With a real `bucketId` column it would
   be a single indexed lookup for every row type, forever.
3. **The admin surface collapses.** Roles, role assignments, workcenter
   grants, and the `/users/me` permission expansion become two queries:
   my buckets, this bucket's members.
4. **The Library hook.** "Everyone at the plant can read the catalogs"
   stopped being a special `authorizeReferenceRead` code path and became a
   membership rule.

## What broke, honestly

1. **The escape hatch is the load-bearing wall.** Today,
   `workcenterId IS NULL` means "readable site-wide" — and a census of all
   117 models shows **53% of the schema lives in that hatch** (36
   site-anchored models + 26 catalogs), while only 19% anchors to a
   workcenter. Buckets have no hatch. The spike's answer (Office / Library /
   Config buckets per plant) works, but it means most of the "bucket" model
   is really three site-wide areas — closer to our current site scoping
   than to Basecamp's many-small-projects world.
2. **Unbucketed rows become invisible to everyone.** A station with no
   workcenter, a gateway in the unassigned pool: no bucket → `NOT_FOUND`,
   even for the workspace owner (test: "the escape hatch is gone"). Real
   adoption must either forbid unhomed rows (make `workcenterId` required,
   give the pool an HQ bucket) or reinvent the hatch — and reinventing the
   hatch is how you end up back where you started.
3. **The stamp is not the owner.** Fact rows carry `workcenterId` as a
   nullable, drifting BI stamp: `station.move` re-points a station without
   touching 9 fact tables' history, and job-history amendment re-stamps old
   rows from the station's *current* workcenter. Promoting the stamp to the
   access key forces a decision nobody has had to make yet: when a machine
   moves cells, does its history move buckets (operators lose their own
   past) or stay (the new cell can't see the machine's history)? Basecamp
   never faces this because recordings don't migrate between projects.
4. **Shared rows with no single home.** A site-level `ShiftInstance` is one
   row serving every workcenter; `ProductStock` is keyed by site+product;
   SITE-grain metric rollups aggregate every bucket; `DocumentLink` can
   point one document at targets in several workcenters. One-bucket-per-row
   has no honest answer for these — they'd all migrate to site-area buckets,
   further shrinking the "project-like" part of the model.
5. **Aggregation is the workload.** Reports, shift recap, metrics rollups,
   and the nine site-wide log-search endpoints all deliberately span
   buckets. Basecamp's UI rarely aggregates across projects; a factory's UI
   does it constantly. Every one of those surfaces would need
   "union of my buckets" query narrowing — buildable (the
   `bucketWorkcenterIds` helper is the seam), but it is most of the
   adoption cost and none of the elegance.

## What the spike faked

- Rows don't carry `bucketId`; the resolver derives the bucket from
  existing ownership columns. Real adoption = a `bucketId` column + backfill
  on every content table, plus bucket creation hooks on site/workcenter
  create (the test mirrors the hook manually).
- No per-request snapshot caching (the gate loads fresh per call).
- Devices keep today's site binding instead of real bucket binding.
- Staff SUPPORT became a full bypass; a real design needs a read-only
  ceiling the bypass flag can't express.
- Aggregation surfaces were left on the existing policy.

## Verdict

The bucket model is genuinely better at the two things Basecamp built it
for: **explaining access** ("who's in this bucket") and **enforcing it
cheaply** (one gate, one resolver). It is genuinely worse at the two things
a factory system does all day: **site-wide aggregation** and **rows whose
home moves or is shared**. The census says this schema is a site-anchored
system with a workcenter-shaped floor slice — which is why the honest
bucket design here collapses to "three site areas + workcenter projects",
and that is functionally the model the 8-key simplification already
shipped, expressed as containers instead of keys.

**If this direction is ever wanted for real**, the incremental path exists
and is cheap to start: (1) add `bucketId` + creation hooks and dual-write
it alongside today's model, (2) move the admin/sharing UI to
buckets-as-the-surface (compiling to roles/grants underneath — no evaluator
risk), (3) only then consider swapping the evaluator, domain by domain, the
same way the vocabulary migration was done. Step 2 alone captures most of
the UX win ("who's in this bucket") with none of the data-model risk.

## Running it

```sh
psql .../rockware -c 'CREATE DATABASE rw_bucket_spike'
cd packages/db && DATABASE_URL=.../rw_bucket_spike DATABASE_URL_MIGRATION=.../rw_bucket_spike pnpm prisma migrate deploy
pnpm --filter @rw/db prisma:generate && pnpm build
cd apps/api && TEST_DATABASE_URL=.../rw_bucket_spike DATABASE_URL=.../rw_bucket_spike pnpm vitest run test/bucket-spike.test.ts
```
