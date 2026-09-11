# 0014 – Period Rows Are Cut at Shift Boundaries

- **Status:** Accepted
- **Date:** 2026-09-10
- **Deciders:** Michael St John

## Context

`StationStateLog` and `StationJobLog` rows are periods: a status stretch (ADR-0005) or a
job assignment. Both carry star-pattern shift stamps, but a period that crossed a shift
boundary was stamped with the shift it started in, so shift-grain reports attributed the
whole stretch to that shift and the shift recap had to clip rows at read time. ADR-0005
already cuts the open status row when its job or mode changes so every row is homogeneous
in those dimensions; shift was the one dimension it did not enforce.

## Decision

1. **Shift is a homogeneity dimension of period rows.** A state-log row or job-log row
   belongs to exactly one shift (or one gap between shifts). A row that reaches a shift
   boundary is cut there and continued with the boundary's shift stamp.
2. **`blockId` ties the pieces together on both tables.** `StationStateLog.blockId` keeps
   its ADR-0005 meaning (a contiguous UP run or downtime, across splits). `StationJobLog`
   gains a `blockId`: one value per job assignment, shared by its per-shift pieces.
   Existing rows are their own block.
3. **The cut runs as an idempotent catch-up in the ensure tick**, not from a precisely
   timed job. Every minute, `splitOpenPeriodsForAllStations` finds stations whose open
   rows are stamped with a shift other than the one running now and cuts them at every
   boundary crossed since, under the station lock. It survives worker downtime (missed
   boundaries are walked in order), makes no status or metric publish (nothing changed),
   and is a no-op once rows are current.
4. **Every writer that creates a period spanning a boundary cuts it the same way**:
   replay reconciliation's reconstructed UP rows and the history amendment's rewritten
   job log and state rows go through the shared `cutAtShiftBoundaries`.
5. **Backdated transitions reach across pieces.** A DOWN backdated to the last finished
   part, or a SLOW backdated to an overlong cycle's start, may land in the previous
   shift's piece. `restatusFrom` cuts the piece containing the backdate instant and
   re-statuses every later piece of the run, so the downtime is one new block spanning
   both shifts. The backdate floor is the start of the current status run (walked over
   contiguous same-status pieces), not the open piece.
6. **"Status since" is the run start, not the open piece.** The livestore station entity's
   `statusStartAt` and the status event's `since` both walk contiguous same-status pieces
   of the block.
7. **Report facts count stretches in the shift they started in.** `jobRuns.runs` and
   `statePeriods.blocks` sum a 1 on a block's first piece, which stays additive across
   shifts. `periods` counts per-shift pieces; average and longest durations are per piece.

## Consequences

- Shift-grain reports and the shift recap read exact stamps; read-time clipping is no
  longer needed for these two tables.
- Row counts grow by roughly the number of shift boundaries per station per day.
- Metric computation is unchanged: durations were already clipped to bucket windows.
- Rows written before this change still span boundaries until a backfill cuts them; the
  planned star-stamp backfill is where that belongs.
- `StationModeLog` has the same period shape and is not cut yet.
