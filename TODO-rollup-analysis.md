# TODO — Rollup pipeline analysis (2026-07-10)

Untracked scratch file — do not commit. Findings from a full read of the
metrics rollup pipeline (`packages/services/src/metrics/`: compute.ts,
cascade.ts, batcher.ts, rollup.ts, recalc.ts, archive.ts, bucket.ts, sync.ts).
Context: Postgres on PlanetScale, resource-constrained — round-trips,
pooled-connection pressure, and vacuum debt matter more than raw CPU.
Companion docs: ADR 0006 "Flagged for review" section
(`apps/docs/src/app/internal/adrs/0006-metric-bucket-field-definitions/page.mdx`)
and `TODO-version-audit.md` (version-table audit).

Architecture summary (what the tick does, every 5s, unconditionally):
1. `batchDurationRollup` — durations for all stations with an open
   StationStateLog entry (1 discovery query + 1 query/station, CONCURRENCY 10)
2. `cascadeJobRollup` per station — JOB HOUR upsert + JOB SHIFT re-sum
3. `syncExpectedCyclesFromJobs` per station — job-clipped expected* → STATION HOUR
4. `cascadeStationShiftDay` per station — HOUR→SHIFT/DAY re-sum, guarded by
   IS DISTINCT FROM
5. `cascadeParentRollup` per site — STATION→WORKCENTER/SITE re-sum, guarded
Plus: per-cycle `incrementHourCounts` (hot path, one UPDATE), per-disposition
badItems increment, `updateTimeBased`/`recalcAll` on transitions/edits/job
change, 60s worker (scaffolding + stale recalc + archival).
Do NOT add an event-driven skip to the tick — duration KPIs advance with
elapsed time (see CLAUDE.md metrics pipeline invariants / batcher.ts comment).

---

## 0. FIXED 2026-07-10 (uncommitted): archival clobbered expected*/expectedItems

**Was:** `archiveSiteBuckets` in `packages/services/src/metrics/archive.ts`
froze STATION buckets before copy to MetricBucketLog by calling
`computeDurationsForBucket(..., standardCycle, /* itemsPerCycle */ 1)` and
writing back `expectedCycles`, `expectedItems`, `elapsedExpectedCycles`,
`elapsedExpectedItems` — overwriting the job-clipped values maintained by
`syncExpectedCyclesFromJobs` with a naive station-level recompute. For any
job with >1 item per cycle, archived `expectedItems` was undercounted
(halved at 2/cycle). Shift-recap reads MetricBucketLog first → historical
reporting saw the corrupted values.

**Fix applied:** freeze update now writes ONLY the five duration fields
(runSeconds, downSeconds, plannedDownSeconds, unplannedDownSeconds,
elapsedPlannedProductionSeconds); expected* fields keep their tick-maintained
job-accurate values. tsc passes.

**Still to do:**
- Verify via integration test (`packages/services/src/metrics/README.md`
  Integration Test section; needs local DB) — multi-item job (itemsPerCycle=2),
  let the hour close + archive, assert MetricBucketLog.expectedItems matches
  the pre-archive live value.
- Historical data already archived with wrong expectedItems is NOT repaired
  by this fix. Optional backfill: for affected MetricBucketLog STATION rows,
  re-derive expectedItems from JOB-entity rows in the same window
  (SUM of JOB HOUR expectedItems per station-hour), or accept the history.

## 1. cascadeParentRollup: 24h re-aggregation scan every 5s + comment/code mismatch

`packages/services/src/metrics/cascade.ts` `cascadeParentRollup` (~line 1033):
docstring says "Covers current + previous hour"; code scans
`mb."startTime" >= hour_start - INTERVAL '24 hours'` across ALL granularities
for ALL stations in the site, every 5s. The IS DISTINCT FROM guard suppresses
writes/emissions but not the read: recursive workcenter CTE + full 24h
GROUP BY per tick, ~99% unchanged rows.

**Proposed:** aggregate only windows containing station buckets with
`updatedAt > now() - 2×tick` (the hot set), plus a periodic full 24h pass
(e.g. every 60s, or piggyback on the archive worker) for self-healing of
completed shifts before archival. Also fix whichever is wrong: comment or
window.

## 2. Tick fan-out is O(stations) round-trips × 3 phases

Phases 2–4 are one-query-per-station (`cascadeJobRollup` is 2 queries:
bucket resolve + big CTE). ~4N queries per tick at CONCURRENCY 10
(`TICK_CONCURRENCY`, batcher.ts). Fine at ~20 stations; at 100–200 stations
this competes with API traffic for pooled connections on PlanetScale.

**Proposed:** collapse phases 3 and 4 each into ONE set-based statement over
all stations (pass station ids as an array; deterministic lock order via
ORDER BY entityId to avoid the deadlocks that motivated per-station writes).
cascadeJobRollup is harder (per-station planner hints were deliberate — see
its comments about bound parameters vs CTE params) but its bucket-resolve
pre-query could be batched. Target: ~5 statements per tick regardless of N.

## 3. Vestigial Redis dirty-bucket queue — delete

`batcher.ts`: `batchedMetricsUpdate()` LPUSHes a dirty marker per cycle
completion (called from cycle.ts hot path); `combinedTick()` RPOPs the whole
list and discards it (~lines 289–295, "consumed but not needed"). Per-cycle
Redis writes + unbounded drain loop buying nothing.

**Proposed:** remove batchedMetricsUpdate's Redis push (and its cycle.ts call
site + MetricsUpdateRequest plumbing if now unused) and the drain loop.
Check nothing else reads `metrics:dirty-buckets`.

## 4. Write churn on MetricBucket — vacuum pressure levers

Every active station rewrites HOUR (+SHIFT, +DAY, + parents per site) every
5s because elapsed durations always advance; guards can't suppress. Each
rewrite recomputes 7 generated columns and leaves a dead tuple. Archival
keeps the table tiny (good), but autovacuum still churns.

**Cheap levers (no refactor):**
- `ALTER TABLE "MetricBucket" SET (fillfactor = 70)` — updated columns are
  unindexed, so updates go HOT if pages have slack. Do the same for
  MetricBucketLog only if its update pattern warrants (it mostly gets
  INSERT+DELETE... actually rollup.ts updates archived rows on late recalc —
  keep default there unless observed).
- Raise `COMBINED_TICK_MS` (env, batcher.ts) to 15–30s — publishes and
  writes scale down linearly; wall displays won't notice.
**Bigger option (architecture change, evaluate later):** stop persisting
in-progress duration KPIs every tick — compute current-bucket durations at
read/publish time and persist only on state transitions and bucket close.
Cuts steady-state writes ~90% but requires a compute-on-read path for
anything querying MetricBucket directly for the current hour.

## 5. rollup.ts (recalc path) is chatty — use guarded upserts

`packages/services/src/metrics/rollup.ts`: per affected window it runs a
live+archive UNION sum (`sumBucketsInWindowWithStdCycle`), a live+archive
UNION skip-unchanged read (`upsertBucket` ~line 895), then the upsert —
repeated per parent entity via `sumEntityBucketsInWindow`. A recalcAll over
an 8h shift with a workcenter chain ≈ 60–90 round-trips. Not hot (job
changes/edits/replay), but replay/backfill feels it.

**Proposed:** replace read-before-write with single-statement upserts guarded
by IS DISTINCT FROM (pattern already proven in cascade.ts upd_shift/upd_day),
and batch the per-window sums (one query grouped by window instead of one per
window). Note: rollup.ts also carries ADR 0006 flag #4 (idealCycleSeconds
rounding drift defeats skip-unchanged — unify rounding to make guards
effective).

## 6. archive.ts is an N+1 loop — set-based rewrite

`archiveSiteBuckets`: full-row findMany of candidates, per-bucket duration
recompute + UPDATE, per-station rollupBuckets, re-read all rows, createMany,
deleteMany. Runs every ~60s; tolerable but slow and was the home of bug #0.

**Proposed (when touching next):** one CTE chain — recompute durations from
StationStateLog for all frozen station-hours (the SQL already exists in
cascade.ts `dur` CTE), UPDATE, INSERT INTO MetricBucketLog SELECT, DELETE —
2–3 statements per site total. Keep the "freeze durations only" rule from
fix #0.

## 7. Cross-referenced open flags (tracked elsewhere, listed for completeness)

- Dead `batchCountRollup` with contradictory badItems/badCycles semantics —
  delete (ADR 0006 flag #1).
- `syncExpectedCyclesFromJobs` zeroes expected* when no JOB HOUR rows match —
  skip UPDATE instead (ADR 0006 flag #3).
- Negative quality clamp decision (ADR 0006 flag #2).
- Job re-version mid-assignment desync (TODO-version-audit.md #1).

## 8. TimescaleDB — verdict: NO for rollups; native partitioning instead

Analysis 2026-07-10, for future reference:
- **Blocking:** timescaledb extension is not in PlanetScale's supported set;
  full features (compression, continuous aggregates) are license-restricted
  to self-host/Timescale Cloud. Adopting it = leaving PlanetScale or running
  a second database.
- **Semantic mismatch:** continuous aggregates need fixed-width time_bucket.
  Our buckets are shift-aligned variable-width (partial hours at shift
  boundaries, per-workcenter schedules, business-date anchors), duration KPIs
  clip open-ended state periods against now() and job windows, and backdated
  mutations (downtime edits/splits, recalcAll) are routine. Caggs can't
  express this; we'd keep all custom logic and use Timescale as dumb storage.
- **What to do instead when raw tables grow:** native declarative
  partitioning (works on PlanetScale) by month on `Cycle`,
  `StationStateLog`, `MetricBucketLog` — partition pruning, DROP PARTITION
  retention, smaller indexes. Revisit a dedicated TSDB only for immutable
  fixed-interval telemetry (e.g. NATS/livestore point history at full
  resolution), where ClickHouse / partitioned PG are also competitive.

## Explicitly fine as-is (don't "optimize")

- Per-cycle hot path: one indexed UPDATE inside the existing cycle tx.
- Unconditional tick (see invariant note at top).
- Live/archive table split with UNION reads preferring live.
- IS DISTINCT FROM emission guards; DB-generated OEE ratio columns.
