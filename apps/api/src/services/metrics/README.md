# Metrics Service

Real-time OEE (Overall Equipment Effectiveness) metric bucket system.
Tracks cycle counts, durations, and computed ratios across a
station -> workcenter -> site entity hierarchy, with per-job breakdowns.

## Architecture Overview

```
Cycle Event ──► updateCountBased ──► rollupBuckets ──► onBucketsChanged
                  │                      │
                  │ (atomic increment    │ (HOUR→SHIFT, HOUR→DAY,
                  │  + duration recomp)  │  STATION→WORKCENTER→SITE)
                  │                      │
                  ▼                      ▼
State Transition ► updateTimeBased ──► rollupBuckets ──► onBucketsChanged
                  │
                  │ (duration KPI recomp)
                  │
Job Change ─────► recalcAll ──────────► rollupBuckets ──► onBucketsChanged
                  │
                  │ (full KPI replacement)
                  │
                  ▼
              recomputeJobBucketsForRange
                  │
                  │ (JOB entity upserts)
                  ▼
              rollupBuckets (JOB mode)
```

All three entry points (`updateCountBased`, `updateTimeBased`, `recalcAll`)
share the same pipeline: `computeBucketFromEvents` -> write base buckets ->
`rollupBuckets` -> `recomputeJobBucketsForRange` -> rollup JOB buckets ->
`onBucketsChanged`.

## Data Model

### MetricBucket Table

Defined in `prisma/schema/metric.prisma`. Each row represents the KPI
state for one entity at one time-granularity window.

**Identity columns:**

| Column | Type | Description |
|--------|------|-------------|
| `siteId` | UUID | Owning site |
| `entityType` | Enum | `STATION`, `WORKCENTER`, `SITE`, `JOB` |
| `entityId` | UUID | The entity being tracked |
| `entityName` | String | Human-readable name (e.g. "Press #1") |
| `path` | String | Dotted hierarchy path (e.g. `site.{id}.workcenter.{id}.station.{id}`) |
| `granularity` | Enum | `MINUTE`, `HOUR`, `SHIFT`, `DAY` |
| `granularityName` | String | Human label (e.g. "Hour", "Shift 1", "Day") |
| `startTime` | DateTime | Start of the time window (UTC) |
| `durationSeconds` | Int | Window length in seconds |

**Unique constraint:** `(entityType, entityId, granularity, startTime)`

**KPI columns (all Int, default 0):**

| Group | Columns |
|-------|---------|
| Counting | `totalCycles`, `goodCycles`, `badCycles`, `totalItems`, `goodItems`, `badItems`, `expectedCycles`, `expectedItems` |
| Duration (seconds) | `runSeconds`, `downSeconds`, `plannedDownSeconds`, `unplannedDownSeconds`, `plannedProductionSeconds` |
| Time (seconds) | `idealCycleSeconds`, `totalCycleSeconds` |
| Elapsed | `elapsedExpectedCycles`, `elapsedExpectedItems`, `elapsedPlannedProductionSeconds` |
| Display | `currentStandardCycle` (Decimal, nullable) |

**Computed columns (PostgreSQL GENERATED ALWAYS AS, read-only):**

| Column | Formula | Type |
|--------|---------|------|
| `availability` | `runSeconds / elapsedPlannedProductionSeconds` | Decimal(7,6) nullable |
| `performance` | `idealCycleSeconds / runSeconds` | Decimal(7,6) nullable |
| `quality` | `goodCycles / totalCycles` | Decimal(7,6) nullable |
| `oee` | `availability * performance * quality` (inlined) | Decimal(7,6) nullable |

All four return `NULL` when the denominator is zero.

### Hierarchy & Rollup Structure

```
        SITE (sum of all stations)
         │
    WORKCENTER (sum of child stations)
         │
      STATION (base computation from raw events)
         │
        JOB (same station events, filtered to job's active period)
```

**Granularity rollup:** HOUR (base) -> SHIFT -> DAY.

**Entity rollup:** STATION -> WORKCENTER (chain) -> SITE.

JOB buckets are derived from the same station events but filtered/clipped
to the job's `StationJobLog` active period. JOB only has time rollups
(HOUR->SHIFT->DAY), no entity rollups.

### Shift-Aligned Hour Buckets

Hour buckets are NOT clock-aligned. They align to the shift schedule:

```
Shift 1: 06:30 - 15:00 UTC  (8.5 hours)
Shift 2: 15:00 - 22:45 UTC  (7.75 hours)
Shift 3: 22:45 - 06:30+1 UTC (7.75 hours)

Hour grid: 06:30, 07:30, 08:30, ..., 14:30, 15:00, 15:30, 16:30, ...
```

At shift boundaries, hour buckets are **partial** (e.g. 14:30-15:00 is
1800s, not 3600s). The anchor for the hour grid is the first shift's
`startTime` on the business date (queried from `ShiftInstance`).

When no shift schedule exists, falls back to 24 clock-aligned hours.

## File Reference

| File | Lines | Purpose |
|------|-------|---------|
| `index.ts` | ~76 | Public barrel re-exports |
| `compute.ts` | ~582 | **Core computation.** Queries raw `Cycle` + `StationStateLog` events for a station+window, tallies all KPIs. Pure, stateless, no DB writes. |
| `recalc.ts` | ~619 | **Entry points.** `updateCountBased` (cycle events), `updateTimeBased` (state transitions), `recalcAll` (full recompute). All handle JOB entities automatically. |
| `rollup.ts` | ~631 | **Cascading rollups.** HOUR->SHIFT/DAY (time), STATION->WORKCENTER/SITE (entity). Idempotent replace, not increment. |
| `bucket.ts` | ~215 | **Scaffolding.** Creates empty bucket rows so zero-activity periods appear in queries. Triggers shift-boundary job scheduling. |
| `shift.ts` | ~489 | **Shift resolution.** DB-driven via `ShiftInstance` table. Workcenter-level overrides with site-level fallback. Business-date anchor resolution. |
| `hierarchy.ts` | ~222 | **Entity hierarchy.** Walks workcenter ancestor chain, builds dotted paths, resolves entity names. |
| `sync.ts` | ~259 | **Change notification.** `BucketSnapshot` type, `flattenChanges()` -> `{ path, value }[]`, `onBucketsChanged()` stub. |

## KPI Key Classification

Three constant arrays in `compute.ts` classify the 18 additive KPI fields:

| Array | Fields | Used by |
|-------|--------|---------|
| `ADDITIVE_KPI_KEYS` (18) | All KPI fields | Rollup summation, `recalcAll` full replacement |
| `DURATION_KPI_KEYS` (10) | `runSeconds`, `downSeconds`, `plannedDownSeconds`, `unplannedDownSeconds`, `plannedProductionSeconds`, `idealCycleSeconds`, `totalCycleSeconds`, `elapsedPlannedProductionSeconds`, `elapsedExpectedCycles`, `elapsedExpectedItems` | `updateTimeBased` and `updateCountBased` Step 2 (partial recompute via `extractDurationKPIs`) |
| `COUNT_KPI_KEYS` (8) | `totalCycles`, `goodCycles`, `badCycles`, `totalItems`, `goodItems`, `badItems`, `expectedCycles`, `expectedItems` | Type narrowing only; not used for write logic |

**Non-additive field:** `currentStandardCycle` is excluded from all three
arrays. In rollups it takes the latest sub-bucket's value (not summed).

## Entry Point Details

### updateCountBased(stationId, siteId, timestamp, itemsCount)

Called from: `cycle.ts` on every cycle completion.

1. **Ensure buckets** exist (SHIFT + HOUR scaffolding rows)
2. **Atomic increment** `totalCycles` +1, `totalItems` +itemsCount on
   HOUR and SHIFT buckets across the full entity hierarchy
   (STATION + WORKCENTER chain + SITE)
3. **Recompute duration KPIs** on the HOUR+STATION bucket via
   `computeBucketFromEvents` (writes `DURATION_KPI_KEYS`)
4. **Emit** full HOUR+STATION snapshot (read-back for generated columns)
5. **Rollup** SHIFT+STATION, DAY+STATION, then entity rollups
   (WORKCENTER, SITE) for all affected granularities
6. **Recompute JOB buckets** for active job logs overlapping this hour

### updateTimeBased(stationId, siteId, startTime, endTime)

Called from: state transitions (UP->DOWN, DOWN->UP), background heartbeat
(every 60s for stations with open state-log entries).

1. **Resolve affected base buckets** in the time range
2. **Recompute duration KPIs** on each HOUR+STATION bucket
   (writes `DURATION_KPI_KEYS`)
3. **Emit** full HOUR+STATION snapshots
4. **Rollup** SHIFT/DAY + WORKCENTER/SITE
5. **Recompute JOB buckets** for active job logs in the range

### recalcAll(stationId, siteId, startTime, endTime)

Called from: job change action (for the closed job's full time range).

1. **Resolve affected base buckets** in the time range
2. **Full KPI replacement** on each HOUR+STATION bucket
   (writes all `ADDITIVE_KPI_KEYS` + `currentStandardCycle`)
3. **Emit** full HOUR+STATION snapshots
4. **Rollup** SHIFT/DAY + WORKCENTER/SITE
5. **Recompute JOB buckets** for active job logs in the range

## Shift Resolution (shift.ts)

Shift times come from the `ShiftInstance` table (pre-materialized rows
with absolute UTC start/end times and businessDate).

**Resolution priority** (for all entity types):
1. Workcenter-level `ShiftInstance` (if the entity has a `workcenterId`)
2. Site-level `ShiftInstance` (`workCenterId IS NULL`)
3. No shift found -> fallback to clock-aligned hours

**Key functions:**

| Function | Description |
|----------|-------------|
| `getShiftForEntity(entityType, entityId, siteId, timestamp)` | Find which shift a timestamp falls in |
| `getHourBucketsForShift(shift, anchorMs)` | Generate shift-aligned hour buckets (partial at boundaries) |
| `getHourBucketsForEntity(entityType, entityId, siteId, timestamp, tz)` | Full hour grid for the shift containing `timestamp` |
| `resolveHourBucketForEntity(...)` | Find the single hour bucket containing `timestamp` |
| `getShiftInstancesForRange(siteId, wcId, start, end)` | Bulk query for shift instances in a range |
| `getLocalMidnightUTC(date, timezone)` | DAY bucket start (local midnight expressed in UTC) |

**Overlapping assignments:** When multiple `ShiftAssignment` records
produce overlapping `ShiftInstance` rows for the same time window, the
instance from the assignment with the latest `rotationStartDate` wins.
All 8 `ShiftInstance` queries in `shift.ts` use
`orderBy: { assignment: { rotationStartDate: "desc" } }` as a tiebreaker.
For `findMany` queries, `distinct: ["startTime"]` deduplicates so only
the newest assignment's instance is kept per time slot.

**Business-date anchor:** The hour grid ticks from the first shift's
`startTime` on the business date. `getAnchorTime()` queries the
earliest `ShiftInstance` on the same `businessDate` as the current shift,
using the same workcenter-then-site resolution priority.

## Change Notification (sync.ts)

Every MetricBucket write emits a `BucketChange` containing a full
`BucketSnapshot` (23 fields: 18 additive KPIs + `currentStandardCycle` +
4 computed OEE ratios).

**Emission path format:**
```
{entityHierarchyPath}.{GRANULARITY}.{epochSeconds}.{columnName}
```

Example:
```
site.abc.workcenter.def.station.ghi.HOUR.1773243000.totalCycles -> 5
site.abc.workcenter.def.station.ghi.HOUR.1773243000.availability -> 1.0
```

`flattenChanges()` converts `BucketChange[]` into `KeyValue[]`
(`{ path: string, value: number | null }`).

**All 7 write sites now emit:**

| Write site | File | Emits? |
|------------|------|--------|
| Scaffolding `createMany` | bucket.ts | Yes (all-zero snapshot) |
| Count increment `upsert` | recalc.ts | Yes (via post-Step-2 read-back) |
| Duration `updateMany` (count path) | recalc.ts | Yes (via read-back) |
| Duration `updateMany` (time path) | recalc.ts | Yes (via read-back) |
| Full replacement `updateMany` | recalc.ts | Yes (via read-back) |
| JOB `upsert` | recalc.ts | Yes (upsert returns row) |
| Rollup `upsert` | rollup.ts | Yes (upsert returns row) |

## Background Workers

### metric-bucket-ensure (every 60s)

In `src/queues/background-workers.ts`. Two jobs:

1. **Safety-net bucket scaffolding:** Finds all distinct entities with
   existing MetricBucket rows, calls `ensureBuckets()` for each at `now`.
   Catches missed shift-boundary jobs.

2. **Stale duration recalc:** Finds stations with open `StationStateLog`
   entries (no `endTime`, `updatedAt` > 30s ago), calls `updateTimeBased()`
   for each. This keeps `runSeconds`, `downSeconds`, and all elapsed
   fields (`elapsedPlannedProductionSeconds`, `elapsedExpectedCycles`,
   `elapsedExpectedItems`) fresh for live dashboards.

### shift-bucket-create (self-perpetuating delayed job)

In `src/queues/metric-buckets.ts`. A BullMQ delayed-job chain:

1. When a shift boundary fires, creates empty SHIFT+HOUR buckets for the
   entity via `ensureBuckets()`.
2. Schedules the *next* shift boundary as a new delayed job.
3. Uses deterministic job IDs (`shift-{entityType}-{entityId}`) so
   repeated calls replace rather than stack.

## Integration Test

`scripts/test-metrics.ts` is the primary correctness test.

**Scenario:** 11 cycles on one station over ~2.5 hours, crossing a shift
boundary (Shift 1 at 15:00 -> Shift 2), with one downtime period
(14:40-15:05), a job change (A->B at 15:20), and 2 active JobProducts
per job (itemsPerCycle=2).

**Run:**
```bash
pnpm build:ts
node dist/scripts/test-metrics.js --clean
```

**Verifies 107 invariants** covering:
- Cycle counts per HOUR/SHIFT/DAY bucket
- Downtime slicing across shift and hour boundaries
- Rollup summation (SHIFT = sum of HOUR, DAY = sum of SHIFT)
- JOB entity isolation (cycles only in job's active period)
- Cross-entity consistency (JOB A + JOB B = STATION)
- WORKCENTER and SITE match STATION (single-station test)
- `expectedCycles` = `floor(plannedProductionSeconds / standardCycle)`
- `totalItems` = `totalCycles * itemsPerCycle`
- `currentStandardCycle` propagation (latest sub-bucket wins)
- All four OEE ratios (exact numeric assertions)
- `oee = availability * performance * quality` identity

## Utility Scripts

### backfill-bucket-paths.ts

One-off script to populate `path`, `entityName`, and `granularityName`
on existing MetricBucket rows that were created before those columns
existed.

```bash
pnpm build:ts
node dist/scripts/backfill-bucket-paths.js
```

## What Is NOT Implemented

### Change notification transport
`onBucketsChanged()` in `sync.ts` flattens changes to `{ path, value }[]`
and logs them. No in-process EventEmitter, Redis pub/sub, or WebSocket
delivery is wired up yet. The flattening logic and path format are final.

### MINUTE granularity
The `BucketGranularity` enum includes `MINUTE` but no code creates or
queries MINUTE buckets. `getBaseBucketsForRange()` in `recalc.ts` is the
only function that would need to change (noted in a code comment).

### ShiftInstance materialization
`ShiftInstance` rows are currently seeded manually (in the test script
and dev seed). In production, they need to be materialized just-in-time
at shift boundaries by a BullMQ worker. The worker would query the
`ShiftAssignment` + `ShiftDefinition` to compute concrete UTC times
for the next business date, then insert `ShiftInstance` rows.

### Multi-station testing
The test scenario uses a single station. Workcenter/site entity rollups
are verified to match the station (since there's only one), but
multi-station summation is not tested.

### BAD / DISCARD cycle status testing
All test cycles are GOOD. The `goodCycles`/`badCycles` split and DISCARD
handling (counted in total but neither good nor bad) are not exercised
by the test. The computation logic in `compute.ts` handles all three
statuses.

### Planned downtime
All test downtime is unplanned. `plannedDownSeconds` computation exists
in `compute.ts` but is not tested.

## Key Design Decisions

1. **Rollups are idempotent replacements, not increments.** Re-running
   produces the same result. This makes the system self-healing.

2. **HOUR is the base granularity.** All other granularities (SHIFT, DAY)
   and entity levels (WORKCENTER, SITE) are derived by summing HOUR
   buckets. Only HOUR+STATION and HOUR+JOB are computed from raw events.

3. **`currentStandardCycle` is NOT additive.** Rollups take the latest
   sub-bucket's value. This shows the most recent job's cycle time at
   higher granularities.

4. **OEE ratios are PostgreSQL generated columns.** They auto-compute
   on every write. Application code never sets them directly. This
   guarantees consistency and means they're always available in
   read-back queries.

5. **Elapsed fields are in `DURATION_KPI_KEYS`.** This ensures the
   heartbeat timer (which calls `updateTimeBased` -> `extractDurationKPIs`)
   keeps `elapsedExpectedCycles`, `elapsedExpectedItems`, and
   `elapsedPlannedProductionSeconds` fresh on in-progress buckets.

6. **JOB buckets clip to `StationJobLog` boundaries.** A JOB's
   `plannedProductionSeconds` and `runSeconds` are clipped to the job's
   active period within each hour, not the full hour duration. This means
   `JOB A + JOB B` KPIs may not equal `STATION` KPIs for duration fields
   (but cycle counts always sum correctly).

7. **Shift resolution has workcenter-level priority.** A station checks
   its workcenter's `ShiftInstance` first, then falls back to site-level.
   This allows different production lines to run different shift schedules.

8. **`goodCycles != totalCycles - badCycles`** because of the DISCARD
   status. DISCARD cycles count in totals but not in good or bad.
