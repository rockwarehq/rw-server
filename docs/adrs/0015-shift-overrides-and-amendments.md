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
   named "Off Hours" with `isScheduled = false` and no `definitionId`. The gap after
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

   **The flag is stamped, not joined.** Every shift-stamped fact table and both bucket
   tables carry `isScheduled`, written with the shift stamp exactly like `businessDate`
   (the same star-stamp convention), backfilled from the instance rows, and re-stamped by
   amendments in the same statement that moves `shiftInstanceId`. Bucket inserts read it
   from the instance they are keyed to. The report catalog exposes it as a `scheduled`
   dimension on every fact with a shift and hides unscheduled time by default; grouping
   by it, or filtering it explicitly, shows what happened in it.

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
     the row keeps its own name), true switches it on. A free-text `note` ("Holiday")
     lives on the override for the calendar only; it is not a report dimension. When it names a
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
   "Frozen" means the pattern is not the place to record a one-day deviation, not that
   it cannot change. A published pattern's definitions may be edited, added or removed in
   place (2026-09-16); the write rebuilds the assignment's rows from now with the same
   routine a new assignment uses, so free future rows follow the new definition while the
   running shift and anything stamped keep their own copies. Overrides key by shift name,
   so renaming a definition does not carry its overrides along; the only guard left is
   that the definition anchoring the rotation start cannot be deleted.
   Unpublishing ends the assignment at that instant instead of deleting it: shifts that
   have not started are removed, the running shift and every stamped row stay (a delete
   would cascade to every instance and null the stamp on every fact). The builder treats
   the rotation end as an instant, so nothing starting at or after it is materialized.
   Publishing the same pattern again reuses the ended assignment row, so history keeps
   one assignment id, and a pattern that has ever been published cannot be deleted.

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
   the right bucket once it exists. The rebuild recomputes every hour of every row the
   amendment changed (a shift bucket sums all of its hours, not only the moved ones) and
   clears the process-level shift-window cache first. On `APPLIED` the worker publishes a second event,
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
  "Off Hours" / "Holiday" are visible groups rather than blanks.
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
  window plus a calendar preview computed from pattern and overrides. The preview
  shows the assignment's existing `ShiftInstance` rows first (they are what facts
  are stamped to) and lets the builder fill only what has no row yet, so moving a
  rotation start or editing a pattern never rewrites the past on the calendar. Before
  now, only table rows are shown: a past day nothing was written for is a gap, not
  what the pattern would have made.
- **Instances that have ended are history and are never deleted.** Deleting a
  published pattern ends its assignment now (not-started rows removed) and sets
  `ShiftPattern.deletedAt`; the assignment, definitions and past rows stay so every
  stamp still resolves, and the calendar still lists the ended schedule. Publish and
  override rebuilds never reach behind the current instant; a rebuild reserves every
  row it keeps (history, in-use rows, and a superseded schedule's running shift, which
  finishes before the new schedule's rows begin) and leaves an unchanged row's id
  alone; the tick likewise reserves every existing row of the scope, so it only ever
  fills time that has no row, and an override for a date that
  has already run is refused (that is an amendment).
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
deferred). Item 2 (stamps, KPI exemption, report default) is the stacked
`feat/shift-scheduled-stamps`; the exemption lives in the one state-log tally every
TypeScript duration path shares and in the two SQL derivations the live cascade uses
(station hours and per-job hours), so JOB buckets are exempt too. In-place edits of
published definitions and patterns (`rematerializePattern`), unpublish-as-end
(`shiftAssignment.unpublish`, `isPublished` on patterns) are on the same branch.

## The amendment reads rows, not the pattern

An amendment corrects a day that has already run, and on such a day the rows are the
truth: they carry the stamps, and the assignment that built them may already have been
ended behind them. Publishing a schedule with a past start date does exactly that, since
reconcile ends the previous assignment at the new start while the rows from that date up
to now stay as history. So the amendment:

- finds the shift in the scope (site plus workcenter, business date, name), not through
  the assignments whose rotation covers the date;
- builds its target from the scope's own rows over the day and its neighbours, with the
  amendment applied to one of them and the Off Hours rows re-cut around the result;
- locks, and records itself against, the row's own assignment.

The pattern is not consulted at all. Two failures this removes: a shift that outlived its
assignment could not be found (`SHIFT_NOT_FOUND`), and one still inside the two-day slack
was found but rebuilt from a rotation that no longer produced it, so the diff was empty
("Amendment changes nothing"). Reading the whole scope rather than one assignment also
means a handover day, where two assignments own rows, gets one consistent set of Off
Hours rows instead of one per assignment.

Order inside the transaction matters: obsolete rows are removed *before* the updates,
because a shift moving back over a gap takes the start time that gap row still holds and
`(assignmentId, startTime)` is unique. That is safe because the re-stamp now covers every
changed row's old and new position, so a fact on a removed row is re-resolved by time
rather than left unstamped; only a reference the re-stamp cannot move (material shift
usage) keeps an obsolete row alive.

One more fix in the same path: the re-stamp built a single parameter list for every fact
table, but the site-level tables never mention the station id array, and Postgres rejects
a statement with a parameter it cannot type. Every site-scoped amendment failed with
`42P18` until the parameters were numbered per statement.

## Rollup buckets follow the corrected window

Three problems sat between an amendment and the numbers it is supposed to fix.

The upsert that writes a rollup bucket listed every column on insert but left
`durationSeconds` and `isScheduled` out of its `ON CONFLICT DO UPDATE`, so a bucket
that already existed kept the shift length it was born with. Only a bucket that had
been deleted first came back with the corrected window. Both columns are updated now.

That mattered because the rebuild does not start from an empty slate. It drops the
scope's live buckets, then each station's rebuild restores archived buckets for the
station, its workcenter *and* the site, at their archived length. The restore runs
after the drop, so the old window came back and then survived the upsert. The drop now
covers the site as well as the scope, and clears the archive table too, so an old shift
(whose buckets have been archived) rebuilds like a recent one. Without the site in that
list, a moved boundary also left the old site bucket beside the new one, counting the
window twice.

Last, unscheduled time measured to `now` returned fractional seconds, and every KPI
column is an integer. Shortening or cancelling a shift that is still running creates an
Off Hours window whose first hour is in progress, so the rebuild wrote something like
708.595 into an int column and the whole amendment failed with a Postgres 22P02. The
gap branch rounds like the tally beside it now.

One race remains, unfixed and rare: the rollups worker holds shift windows in a
30-second cache of its own, so a tick landing right after an amendment can write a
bucket for a boundary that no longer exists. It cannot persist a wrong duration any
more, and the next rebuild of that window clears it.

## Adding a shift to a day that has run

Production sometimes happens outside the schedule: a crew works into unscheduled
time, or one long shift was really two. The amendment covers both, because the
target it builds is the day's rows and nothing stops a row being added to that set.

`amendShift` takes an add when no shift of that name exists on the date. It needs a
start and an end, the time must already have passed (otherwise it is an override),
and the window must be free — the overlap check refuses anything landing on a shift
that is already there, so an add can only fill Off Hours. The row it writes has no
definition, because the pattern never described it, and joins the schedule that owns
the time it lands in. Everything after that is the path a retime already took: the
diff creates the row, facts inside the window re-stamp onto it by time, periods are
re-cut at its edges, and the rebuild gives it its own buckets.

Splitting is two amendments: shorten the shift, then add the remainder under a new
name. The first opens Off Hours, the second fills it exactly, and the day ends with
no gap between the halves.

The amendment record's four `previous` columns are null for an add, since there was
no shift to describe. Undo reads that: null means take the row off again rather than
restore a window. The removal is itself an amendment, recording the window it took
away in `previous` and leaving the replacement empty, so undoing the removal adds the
shift back with no extra code. Only an added shift can be removed; a shift the pattern
defines is cancelled instead, which keeps its name and window on the day.
