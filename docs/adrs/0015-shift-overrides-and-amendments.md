# 0015 – Shift Calendar: Gap Rows, Overrides, and Amendments

- **Status:** Proposed
- **Date:** 2026-09-15
- **Deciders:** Michael St John

## Context

A `ShiftPattern` describes a repeating rotation; `ShiftInstance` rows are the concrete
windows the pattern produces, built by the ensure tick for the last day and the next
seven. Every fact table (cycles, dispositions, state and job log pieces, calls, material
usage, …) stamps `shiftInstanceId` + `businessDate`, and hour/shift metric buckets are
aligned to shift starts (ADR-0006, ADR-0014). Two things were missing:

1. Time between shifts had no row. Facts recorded then carried no shift stamp and fell
   back to clock-aligned buckets, and reports could not show "not scheduled" as a thing.
2. A real plant departs from its pattern all the time: a holiday, a Saturday worked, a
   shift that started an hour early because the crew came in early, a shift cut short.
   The old software let users change any future shift on a year calendar. Here a
   pattern is frozen once assigned and the instances could not be touched.

A change to a shift that has already run is a different problem from a change to one
that has not: the first must move stamps and rebuild KPIs, the second has nothing to
move. Job history amendments (ADR-0013) already solved the "rewrite facts, rebuild
buckets asynchronously" half for jobs.

## Decision

1. **Every instant inside the materialized window has an instance row.** After the
   scheduled rows for a day are built, the gaps between consecutive shifts become rows
   named "Not Scheduled" with `isScheduled = false` and no `definitionId`. The gap after
   the last built shift is not written (its end is unknown) — it appears when the next
   shift enters the window. Period rows cut at gap boundaries like any other
   (ADR-0014), so a downtime running into unscheduled time becomes an unscheduled piece
   of the same block.

   **Which business date a gap belongs to — the gap attaches to the shift before it,
   never the one after.** A business day starts when its first shift starts and runs 24
   hours; whatever is left after the last shift is the tail of that day. Concretely:
   - The *anchor* of a business date is the start of its earliest row (scheduled,
     cancelled or added — a cancelled shift keeps its window, so it still anchors).
   - A gap from one row's end to the next row's start is cut at every instant
     `anchor + k × 24h` that falls strictly inside it. The piece starting at instant `t`
     gets business date `previousShift.businessDate + floor((t − anchor) / 24h)` days.
   - So a gap shorter than the rest of the day is one row on the previous shift's date;
     a weekend after a Friday whose first shift starts 06:00 becomes: Sat 04:00→06:00 on
     Friday's date, Sat 06:00→Sun 06:00 on Saturday's, Sun 06:00→Mon 06:00 on Sunday's.
   - The rule is derived from the rows already built, so it needs no configuration and
     no knowledge of the next day; attaching gaps to the *following* shift instead would
     require the next day's rows before any gap could be written and would move a
     shift's overtime tail onto the wrong day.
   - The 24-hour cut is wall-clock, not local-calendar: across a DST change a chunk is
     an hour longer or shorter. The gap still ends exactly at the next shift, so only
     the label of that one chunk is affected.

2. **Unscheduled time never counts against production KPIs.** A bucket keyed to an
   unscheduled instance has zero planned production time: cycles and items in it still
   count as production, but there is no expected-cycle denominator, availability and OEE
   are null, and downtime inside it is exempt. Day, workcenter and site rollups exclude
   that time from their denominators as a result.

2b. **A definition can be kept on the rotation but not worked by default.**
   `ShiftDefinition.isScheduled = false` (a weekend shift) still materializes rows — with
   the definition's own name and window, `isScheduled = false` — so the calendar shows the
   shift that *would* run, its time is unscheduled for KPIs (item 2), and working it on one
   date is a single override or amendment with `isScheduled = true`; nothing has to be
   typed in.

3. **The pattern stays frozen; deviations live beside it.** Two records, chosen by whether
   the shift has started, never by whether its rows exist:
   - **`ShiftOverride`** — a plan for a shift that has not started. Keyed by scope, business
     date and shift name (so it survives pattern edits); `shiftName = null` means every
     shift that date; a shift-specific override beats a whole-day one. It carries a
     replacement window and/or a three-way `isScheduled`: null leaves the definition's
     flag alone, false switches the shift off (the window is kept, `isScheduled = false`,
     named by the override label, e.g. "Holiday"), true switches it on. When it names a
     shift the pattern lacks that day it adds a scheduled shift with no definition. The row builder applies
     overrides when it materializes, and a write re-runs the builder from the day before
     the date, deleting and regenerating unused rows. Rows in the seven-day window are
     regenerated freely: a shift that has not started has nothing stamped on it. An
     override carries no status; it is a plan, applied at build time or replaced.
   - **`ShiftAmendment`** — a correction to a shift that is running or finished. It edits
     the instance rows directly and records the old and new windows, the actor, and the
     rebuild status (`PENDING_REBUILD` / `APPLIED` / `FAILED`) exactly like
     `JobHistoryAmendment`. Undo is another amendment restoring the previous window.
     An amendment has the same shape as an override and the builder treats it as one
     more rule — the latest per date and shift wins — so the ensure tick, the calendar
     preview and a later amendment of the same day all reproduce amended days.
   The calendar offers one action, "modify"; the service picks the record from
   `instance.startTime <= now`.

4. **Amendments update rows in place and diff, they do not hand-code cases.** The target
   rows for the day are computed with the same builder (pattern + overrides + the
   amended window) and diffed against the existing rows: a shift matches by definition
   and business date and keeps its id with new times; gap rows match by overlap and are
   widened, shrunk, split or deleted; the rest is created or removed. Keeping ids means
   every stamp still inside its shift's new window is untouched. Only facts inside the
   union of the old and new windows are re-stamped by time; period rows there are merged
   back into their blocks and re-cut at the new boundaries with the shared cutter.

5. **The ensure tick never fights an edit.** Because amendments are builder rules, the
   tick regenerates an amended shift with its amended times, which is the row already
   there, and skips it as a duplicate. The same is true of the boundary jobs the tick
   schedules: they are derived from the regenerated rows, so an amended end time moves
   the next shift-change job on the following tick without any special hand-off.

6. **Derived data rebuilds asynchronously; live recording is never blocked.** The
   amendment transaction only rewrites instance rows and stamps under the station
   locks, bounded to one business date. After commit the service publishes
   `shift-history.<site>.<scope>.amended` on `RW_SHIFT_HISTORY_EVENTS`. A durable
   consumer in the rollups worker archives the shift and hour buckets inside the window,
   ensures them against the new boundaries, runs `recalcAll` per affected station,
   cascades, and marks the amendment `APPLIED` or `FAILED`; a retry re-publishes. Cycles
   completing meanwhile resolve their shift from the already-updated rows and land in
   the right bucket once it exists. On `APPLIED` the worker publishes a second event,
   `shift-history.<site>.<scope>.rebuilt`, and a `ui.changes` ping so calendars, recaps
   and automations know the numbers are final.

7. **Shift definitions are local wall-clock time.** `ShiftDefinition.startTime` is the
   site's local "HH:mm" and `startDayOffset` may be -1 for a shift that starts the
   evening before its rotation day. Materialization converts each day's times to UTC
   with the site timezone, so a 23:00 shift starts at 23:00 local all year and its UTC
   instant moves with daylight saving. Duration is wall-clock as well: 23:00 + 8h ends
   at 07:00 local, which on the fall changeover night is 9 elapsed hours and on the
   spring one 7, with no gap or overlap created. A wall-clock time that never happens
   (02:30 on the spring night) resolves forward past the skipped hour; one that happens
   twice (01:30 on the fall night) resolves to its first occurrence. Existing definitions, which were stored as UTC
   and converted for display with the current offset, are migrated in place with that
   same offset, so nothing already materialized changes. Overrides and amendments
   remain exact instants.

8. **Overlap is rejected at write time.** An override or amendment whose window overlaps
   another scheduled or cancelled row of the same scope is refused; gap rows are
   regenerated so they never count. Pattern-level overlap remains unvalidated (it was
   before) and resolves by the existing workcenter-over-site, latest-assignment order.

## Consequences

- Every fact from now on carries a shift stamp, so shift-grain reports are complete and
  "Not Scheduled" / "Holiday" are visible groups rather than blanks.
- A workcenter schedule's gap rows shadow a site-level shift during the gap. Previously
  the site shift filled in; the workcenter's explicit "not scheduled" now wins.
- Reports that group by shift name pick up cancelled and added shifts by name; an added
  shift named like a pattern shift rolls up with it, a new name stays separate.
- Amendments cost one station-day of recalc per affected station, the same order as a
  job history amendment, and run in the same worker lane.
- Rows written before this decision have no gap rows and their KPIs are unchanged; a
  backfill is not planned.
- Pattern boundaries follow the site clock across DST. On the changeover day one shift
  is an hour longer or shorter in elapsed time, exactly as the plant experiences it, and
  that business date totals 25 or 23 scheduled hours.

## Alternatives Considered

- **Materialize a year of instances and let users edit rows directly** — cheap to store,
  but every pattern change would have to merge hand edits with regenerated rows, and
  the table would hold two sources of truth. Rejected in favour of a short rolling
  window plus a calendar preview computed from pattern and overrides.
- **No materialization; compute the shift on demand** — fourteen tables and the metric
  buckets key on the instance id. Rejected as a rewrite of the history layer.
- **One record with a status for every change** — an override needs no rebuild, so its
  status would always be "applied", and undo of a past change would need a soft-deleted
  override to report on. Separating plan (override) from correction (amendment) keeps
  each table honest.
- **Decide override vs amendment by whether rows exist** — the tick materializes a week
  ahead, so rows exist for shifts that have no data; that boundary would have forced
  amendments (and rebuilds) on shifts nothing has happened in.

## Implemented so far

Items 1, 3 (overrides), 5, 7 and 8, plus the calendar preview, on `feat/shift-gaps-overrides`.
Items 3 (`ShiftAmendment`), 4 and 6 on the stacked `feat/shift-amendments`: the diff planner
(`planInstanceDiff`), re-stamp of every stamped fact table by its own instant, period re-cut,
the `RW_SHIFT_HISTORY_EVENTS` stream with the rollups-worker rebuild, undo and retry. Two
known gaps: (a) period pieces that were cut at a boundary that no longer exists stay two
pieces with the same stamp (reports counting pieces are off by one there; a merge is
deferred), and (b) item 2 — unscheduled time not counting against KPIs — is still open.
