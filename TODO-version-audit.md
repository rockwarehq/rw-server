# TODO — Version-table audit findings (2026-07-10)

Untracked scratch file — do not commit. Findings from an audit for the bug
class: "aggregate over a time window filtered by a *specific* version
(snapshotted or current) instead of matching all versions of the parent
entity." Original instance (already fixed): job counts during a shift only
matched the current JobVersion, so a job re-versioned mid-shift lost counts.
The fix pattern — match cycles via `JobVersion.jobId` (any version) — is in
place in `packages/services/src/metrics/compute.ts` (queryAndTallyCycles),
`cascade.ts` (cycle_stats CTE), and both disposition-attribution paths.

Related but separate: ADR 0006 ("Flagged for review" section,
`apps/docs/src/app/internal/adrs/0006-metric-bucket-field-definitions/page.mdx`)
lists metrics-pipeline flags (dead batchCountRollup, negative quality clamp,
syncExpectedCyclesFromJobs zeroing, idealCycleSeconds rounding drift).

---

## 1. Re-versioning a job while assigned desyncs JOB vs STATION KPIs (moderate — fix this one)

**Problem:** `update()` in `packages/services/src/job/job.ts` (~line 322)
creates a new `JobVersion` and repoints `Job.currentVersionId`, but does NOT
refresh the open `StationJobLog` row or split the open `StationStateLog`
entry. Those only happen on job *change*
(`splitOpenStateEntryForJobChange` in
`packages/services/src/facility/station/state.ts`, called from
`facility/station/jobs.ts` and `facility/station/actions/jobchange.ts`).

**Effect when standardCycle is re-versioned mid-assignment:**
- New cycles are stamped with the NEW jobVersionId (cycle completion reads
  `j.currentVersionId` — `packages/services/src/cycle/cycle.ts` setup query
  ~line 102), so STATION-bucket `idealCycleSeconds`/performance use the new
  standard immediately.
- JOB buckets keep the OLD standard until the next job change: both the live
  tick (`cascade.ts` cascadeJobRollup `active_job` CTE reads
  `sjl."standardCycle"`) and `recalcAll` (JobFilter.standardCycle built from
  `StationJobLog.standardCycle`, `packages/services/src/metrics/recalc.ts`
  ~lines 130–186) use the StationJobLog snapshot.
- Result: JOB performance/expectedCycles disagree with STATION for the same
  window. Open StationStateLog entry also keeps the stale jobVersionId.

**Proposed fix:** In `job.update()`, when the job is currently assigned to
one or more stations (`Station.currentJobId = job.id`), treat the re-version
like a job change boundary per station, inside the same transaction:
1. Close the open `StationJobLog` row (`endTime = now`) and insert a new one
   with the new `jobVersionId` and new `standardCycle` snapshot.
2. Call `splitOpenStateEntryForJobChange(tx, stationId, now, newVersionId)`.
3. Fire `recalcAll(stationId, siteId, closedLog.startTime, now)` after commit
   (mirror what `actions/jobchange.ts` does, ~line 164).
Alternative (simpler, weaker): update the snapshots in place
(StationJobLog.standardCycle + jobVersionId, open state-log jobVersionId) —
loses the "which version was active when" boundary, so prefer close/reopen.

**Verify:** assign job to station → run cycles → `job.update({ standardCycle:
<new> })` → run more cycles → compare JOB SHIFT bucket vs STATION SHIFT bucket
`idealCycleSeconds`/`expectedCycles`; they should be consistent, and
StationJobLog should show two rows with the version boundary.
E2E harness: `apps/api/scripts/` metrics/e2e scripts (see
`packages/services/src/metrics/README.md` Integration Test section).

## 2. inventory.list RPC only filters by exact version IDs (latent footgun)

**Problem:** `inventoryListInputSchema` in `apps/api/src/rpc/inventory.ts`
(~line 22) accepts `productVersionId` / `jobProductVersionId` only — there is
no parent `productId` / `jobProductId` filter. Service:
`list()` in `packages/services/src/inventory/inventory.ts` (~line 265).
No caller passes these today (rw-ui checked 2026-07-10), but the first
consumer who passes `product.currentVersionId` meaning "all items of this
product" silently drops items produced under older versions — the original
bug class.

**Proposed fix:** add optional `productId` (and `jobProductId`) inputs that
filter via the relation (`where.productVersion = { productId }` /
`where.jobProductVersion = { jobProductId }`), keeping the exact-version
filters for genuine version-scoped queries. Add index if needed
(ProductVersion.productId is already FK-indexed).

## 3. materialUsageSearch groups by snapshotted version NAMES (minor)

**Problem:** `materialUsageSearch` in `apps/api/src/rpc/logs.ts`
(~lines 935–968) builds group keys from `item.cycle.jobVersion.name`,
`item.productVersion.name`, `pmb.materialVersion.name` (name strings from
each item's snapshotted versions). If a re-version renames a job/product/
material mid-range, one logical group splits into two rows (old name + new
name). No data lost — display fragmentation only.

**Proposed fix (if it bothers anyone):** group by parent IDs (jobId via
`jobVersion.jobId`, productId via `productVersion.productId`, materialId via
`materialVersion.materialId`) and label each group with the latest/current
name. Follow the pattern used by `materialLedger.usage()`
(`packages/services/src/inventory/material-ledger.ts`), which groups by
parent IDs and decorates with current-version names.

## 4. itemsPerCycle is always resolved live (deliberate — document or revisit)

**Problem/behavior:** items-per-cycle is computed from
`JobProduct.currentVersionId` (`JobProductVersion.quantity`, isActive=true)
everywhere: `queryItemsPerCycle` in `packages/services/src/metrics/recalc.ts`
(~line 160, comment says "queried live because products can change while a
job runs"), same join in `recalc.ts` ~line 527, `cascade.ts` job_meta
(~line 202) and batch queries (~lines 561, 698). Consequence: recomputing a
historical window (recalcAll, replay) values `expectedItems` /
`elapsedExpectedItems` with TODAY'S quantities — a mid-shift
JobProductVersion quantity change silently shifts already-closed hours'
expected numbers.

**If changing:** snapshot itemsPerCycle onto StationJobLog at assignment
(like standardCycle) and use the snapshot in all four query sites; combine
with finding #1's close/reopen so re-versions create a boundary. If keeping,
add the caveat to ADR 0006's Known caveats.

## 5. jobMetricsList returns composite entityId as "jobId" (not version-related)

**Problem:** `jobMetricsList` in `apps/api/src/rpc/shift-recap.ts`
(~line 258) returns `jobId: r.entityId`, but JOB-entity MetricBucket
`entityId` is the md5 composite `md5(stationId:job:jobId)` (see
`jobEntityId()` in `packages/services/src/metrics/cascade.ts` ~line 29), not
the real Job id. Fine as a React row key; will 404 if rw-ui ever links it to
a job detail page. The real jobId is not currently stored on the bucket row
except as `currentJobId` — either return `currentJobId` as `jobId`
(it is selected already on buckets) or parse from `path`
(`...station.{stationId}.job.{jobId}` suffix).
