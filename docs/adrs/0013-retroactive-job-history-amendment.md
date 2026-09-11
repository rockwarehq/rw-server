# 0013 – Retroactive Job History Amendment

- **Status:** Accepted
- **Date:** 2026-09-10
- **Deciders:** Michael St John

## Context

An operator forgets to change the job on a station. `StationJobLog` says Job1 ran
[T1, T3) when reality was Job1 [T1, T2a) and Job2 [T2a, T3). `changeJob` only opens and
closes logs at `now()`, and every fact written in the window carries the wrong job:
`Cycle.jobId/jobVersionId`, `InventoryItem` rows built from Job1's products,
`StationStateLog.jobId`, `Call`/`StationModeLog` stamps, and the JOB metric buckets keyed
by `jobEntityId(stationId, jobId)`. There was no way to correct any of it.

## Decision

We add one operation, `amendJobHistory({ stationId, jobId | null, from, to | null })`:
"station S ran job J over [from, to)". `to = null` means through now and also changes the
station's current job.

1. **The job log timeline is rewritten by a pure planner.** Rows touching the window are
   cut into the pieces that survive outside it, the asserted piece is added, touching
   pieces of the same job merge, and the result is diffed against the input rows. A row
   already matching the assertion is kept, so re-asserting is a no-op. Applying the plan
   keeps `blockId` contiguous (ADR-0014): the asserted piece joins a touching same-job
   run, and a run cut in two by the window gets a new block for its remainder.
2. **Each module rewrites its own facts inside the same transaction** under the station
   advisory lock. The handlers are independent of each other (they only need the window
   and the job); the one ordering is items after cycles. Running them atomically means no
   reader ever sees cycles on Job2 and items on Job1.
   - Cycles: attributed by end time (an open cycle counts as ending now). `jobVersionId`
     is the field JOB buckets aggregate by, so it is restamped along with `jobId`, the
     standards snapshot, and the tool join tables. Each rewritten cycle's `amendmentId`
     points at the amendment, so a manually overwritten cycle is distinguishable from one
     recorded as-is and its previous job can be read off the amendment. A "no job" amendment leaves cycles as
     recorded because a cycle requires a job version.
   - Items: soft-deleted (`deletedAt`) and recreated from the amended job's products in
     one set-based insert, so the lock hold does not grow per cycle. Recreated items carry
     the same `amendmentId` marker as the cycles.
     Material staging moves with them for shifts that are still open. A flushed shift's
     PRODUCTION entries are immutable, so the net material difference (removed items
     credited, created items debited) is posted as one signed ADJUSTMENT per material,
     stamped with that shift and referencing the amendment id. Item sums in the metrics
     compute and cascade now filter `deletedAt`.
   - State log: split at the window edges and restamped; statuses, reasons and blocks
     stay as recorded (ADR-0005: one status and one job per row). SLOW is not re-derived
     against the new standard.
   - Calls and mode logs that opened in the window get the job's dimensions.
3. **The job version is the one current at `from`**, not today's, and standards are
   resolved from it.
4. **A `JobHistoryAmendment` row records what happened**: the window, the job, the job
   log rows it replaced (`previousTimeline`), per-module counts, the actor, and the
   rebuild status.
5. **Derived data rebuilds asynchronously from a domain event.** After commit the service
   publishes `job-history.<site>.<station>.amended` on `RW_JOB_HISTORY_EVENTS`. A durable
   consumer in the rollups worker un-archives the affected buckets, runs `recalcAll` over
   the window with the displaced jobs (whose stale JOB HOUR rows are zeroed so their
   SHIFT/DAY rollups re-sum), rederives product stock when items were recreated, and marks
   the amendment `APPLIED` or `FAILED`. `retryJobHistoryRebuild` re-publishes the event.
   The event is a normal JetStream domain event so a future system-wide event log can
   subscribe to it without changes here.

## Consequences

- Reports and shift recaps read the stamped facts, so they are correct as soon as the
  transaction commits; KPIs follow once the rebuild runs.
- `recalcAll` now stamps each STATION bucket with the job that ran in that hour rather
  than the station's job today, and `unarchiveAffectedBuckets` un-archives JOB buckets
  by their composite id (it previously pushed the raw job id and matched nothing).
- Windows are bounded to 24 hours per amendment. The station lock is held while the facts
  are rewritten, and a live cycle completion waiting on it has a 5-second transaction
  budget before the imm-events worker starts retrying, so the hold must stay short.
- Publishing is fire-and-forget: an amendment whose event never reached NATS stays
  `PENDING_REBUILD` until retried.

## Deferred

Undo (the previous timeline is stored for it), re-deriving SLOW against the new
standard, an automation bridge for the event, and a sweep that retries `PENDING_REBUILD` amendments automatically.
