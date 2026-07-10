# TODO — Soft-delete audit findings (2026-07-10)

Untracked scratch file — do not commit. ("TODO" = review these findings and
make the decisions; several items are questions, not tasks.)

Audit scope: every query on the 24 models with a `deletedAt` column, across
`packages/services/src`, `apps/api/src/rpc`, and workers. There is NO global
soft-delete middleware — every query must filter `deletedAt: null` /
`"deletedAt" IS NULL` explicitly. Companion docs: `TODO-rollup-analysis.md`,
`TODO-version-audit.md`, ADR 0006 flags.

**Ground truth that calibrates severity (verified):**
- Soft-deleted today by real code paths: Order (`order.ts:363`), Job
  (`job.ts:389`), JobTool (soft-delete + RESTORE flow in job.ts
  addTool/removeTool), WorkOrder, StationStateLog (replay), Product,
  Material, dispositions/reasons, Customer, Dashboard, Document, etc.
- NEVER soft-deleted today (column exists, no writer found): **Cycle,
  InventoryItem**. All Cycle/InventoryItem findings below are therefore
  latent, not active.
- Station.remove() HARD-deletes (`facility/station/crud.ts:537`) — all
  Station `deletedAt` findings are dormant, but the codebase is split
  (some queries filter Station.deletedAt, some don't).

---

## A. Decisions needed (answer these first; they resolve whole groups)

**A1. Should historical/report data for a soft-deleted entity remain visible?**
Current behavior is accidental-mixed. If YES (history is immutable —
recommended for manufacturing records): the 15 unfiltered Station scope
queries in rpc (B4) and the decorative name joins are CORRECT and should be
documented as intentional. If NO: they're all bugs.

**A2. Commit to a story for Cycle / InventoryItem soft-deletion.**
Options: (a) declare "never soft-deleted", document it, optionally drop the
columns; or (b) keep the capability (e.g. future phantom-cycle deletion
feature) and fix the missing filters NOW (cheap), because the failure mode
later is nasty: compute.ts filters cycles but cascadeJobRollup doesn't →
JOB vs STATION buckets silently diverge every 5s tick (see C1).
Recommendation: (b) — add the filters preemptively.

**A3. Station: soft-delete or hard-delete — pick one.**
remove() hard-deletes, yet Station has deletedAt and ~half the queries filter
it. Either switch remove() to soft-delete (then B4/B5 matter and metrics
discovery C4 needs the filter) or drop the column/filters. Note
`getChildStationIds` (metrics rollup.ts) and `cascadeParentRollup` already
filter — they'd be correct under soft-delete; the tick discovery would not.

## B. Active bugs (fix now — writers exist for these models)

**B1. Order line-item healer touches soft-deleted orders.**
`packages/services/src/order/allocation.ts:31-38` — the OrderLineItem
status-heal UPDATE scopes via `"orderId" IN (SELECT id FROM "Order" WHERE
"siteId" = ...)` with no deletedAt filter; the sibling order-heal UPDATE
directly below (line ~43) filters `"deletedAt" IS NULL`, proving intent.
Effect: line items of soft-deleted orders get flipped to COMPLETED on every
allocation (also: this site-wide heal runs per produced item — separate perf
note). Fix: add `AND "deletedAt" IS NULL` to the subquery.

**B2. Deletion guards count soft-deleted children → deletion over-blocked.**
`_count` guards lack per-relation `where: { deletedAt: null }` (Prisma
supports filtered `_count`). A stale soft-deleted link makes the parent
permanently un-deletable. Realistic today — JobTool has an active
soft-delete+restore flow.
- `inventory/product.ts:357` → guard at :369 (`_count.jobProducts`)
- `job/job.ts:368` → guard at :380 (`_count.orders`)
- `job/tool.ts:265` → guards at :277/:284 (`_count.jobs` JobTool, `_count.jobProducts`)
- `job/tool.ts:463` → guard at :475 (`_count.jobProducts`)
- `inventory/disposition.ts:149` → guards at :157/:164
- `inventory/disposition-reason.ts:225` → guard at :233
Fix: filtered `_count` at each site. (The display-only `_count` over-counts
in D3 are the same mechanical fix, lower urgency.)

**B3. Background reconciler can create a StationJobLog for a soft-deleted job.**
`packages/services/src/queues/background-workers.ts:215` — `JOIN "Job" j ON
j.id = s."currentJobId"` without `j."deletedAt" IS NULL` (Station IS
filtered). If a currently-assigned job is soft-deleted, the
missing-StationJobLog reconciler resurrects it into a new log row. Fix: add
the filter; also consider whether job.remove() should refuse / unassign when
the job is some station's currentJobId (check what remove does today).

**B4–B5 (blocked on decision A1/A3, listed for completeness):**
- B4: 15× `Station.findMany` scope queries without deletedAt —
  `apps/api/src/rpc/logs.ts:127,428,435,675,819,1070,1076,1289,1443,1451`,
  `shift-recap.ts:77,155,202,312,369`. Dormant (hard delete) + arguably
  correct under A1=YES. Do nothing until A1/A3 decided.
- B5: `apps/api/src/rpc/operator.ts:157` — logon station check by id without
  deletedAt. Dormant, but if Station ever soft-deletes this allows logon to a
  deleted station. Cheap to add now regardless.

## C. Latent bugs (no writer today — fix cost is low, fix per decision A2)

**C1. Metrics: cascadeJobRollup counts soft-deleted cycles; compute.ts doesn't.**
`packages/services/src/metrics/cascade.ts` cycle_stats CTE (~line 237): no
`c."deletedAt" IS NULL`; `compute.ts` queryAndTallyCycles (~488/508) filters.
If cycle soft-deletion ever lands: JOB HOUR/SHIFT recount deleted cycles on
every 5s tick while recalc excludes them → permanent JOB-vs-STATION
divergence for the current hour. Fix: add filter to cycle_stats.

**C2. Metrics: InventoryItem counts never filter deletedAt.**
`compute.ts:~524` (itemCounts), `cascade.ts:~234` (cycle_stats total_items),
`cascade.ts:~599` (batchCountRollup item_counts — dead code, delete instead
per ADR 0006 flag #1). logs.ts DOES filter items (`materialUsageSearch`),
so the metrics side is the odd one out. Fix: add `"deletedAt" IS NULL`.

**C3. "Previous cycle end" lookups can pick a soft-deleted cycle.**
`cycle/cycle.ts:~297` and `~546` (prev CTE: new cycle's start = last cycle's
end), `facility/station/state.ts:~386` (last-cycle-end clamp). Also the
open-cycle close paths `cycle/cycle.ts:425/436` and `618/629`
(findMany/updateMany `{stationId, end: null}` — would re-close and generate
inventory for a soft-deleted open cycle). Fix: add filters.

**C4. Metrics tick discovery joins Station without deletedAt.**
`cascade.ts:~564` (batchCountRollup, dead) and `~702` (batchDurationRollup
open_stations). Dormant while Station hard-deletes; needed if A3 → soft.

**C5. cycle completion joins Tool without deletedAt.**
`cycle/cycle.ts:~109` — `JOIN "Tool" t` (JobTool alias IS filtered; Tool is
not) → a soft-deleted tool still contributes its currentVersionId to cycle
version connects. Tool soft-delete exists. Borderline-active; cheap fix.

## D. Low / display-only (batch up whenever)

- **D1.** `inventory/disposition-reason.ts:102,124,146,213` — nested
  `include: itemDispositions` without filter → soft-deleted dispositions
  appear in reason detail responses. (Contrast disposition.ts:92 which
  filters the reverse relation.)
- **D2.** createFromCycle joins Product/Tool/ToolCavity without deletedAt
  (`inventory/inventory.ts:65-67`) and the `want` aggregate joins Material
  unfiltered (`inventory.ts:176` — sibling at :59 filters, inconsistent).
  Reached via active JobProduct so exposure is narrow.
- **D3.** Display-only `_count` over-counts (same filtered-`_count` fix as
  B2): `inventory/product.ts:134,192,234,330,460,503,642`,
  `job/job.ts:114,202,271,341`, `job/tool.ts:93,136,169,238`,
  `inventory/disposition.ts:47,71,97,138`.
- **D4.** `facility/shift/materialize.ts:440` — shift-instance in-use guard
  counts soft-deleted ItemDispositionLog rows → soft-deleted logs pin shift
  instances forever (fails safe, over-retains).
- **D5.** `inventory/inventory.ts:442` getByCycle returns a soft-deleted
  cycle's items without checking (by-id; latent per A2).

## E. Reviewed and judged intentional (don't re-audit)

- PK/validated lookups: cycle.ts:100-104, replay.ts:172/269,
  cyclerecord.ts:34, state.ts:156, execution.ts:103/251,
  inventory.ts:150/172, order.ts:620 (reorder by explicit ids),
  document/index.ts:227/476/482 (hard-delete tree walk).
- Historical/decorative name joins (deleted entity's name should still
  render on history): material-ledger.ts:306/308/310, logs.ts:1142 raw
  Station name join, shift-recap.ts:390 ItemDispositionReason name resolve.
- Disposition attribution subqueries `WHERE c.id = idl."cycleId"`
  (compute.ts:~425, cascade.ts:~267) — resolving job for an already-filtered
  disposition; correct even if the cycle is later soft-deleted.
- Verified-filtering (spot list): compute.ts cycles/state logs/dispositions,
  cascade.ts state_slice + parent rollup stations, all StationStateLog
  queries in facility/station/state.ts, logs.ts main log queries,
  entity/instances.ts, disposition-log.ts, material.ts, allocation.ts's
  other two statements.

## Suggested order of attack

1. Decide A1–A3 (product intent; three yes/no calls).
2. Fix B1 (one-line), B2 (six filtered `_count`s), B3 (one-line), B5
   (one-line, cheap insurance).
3. If A2 = keep capability: C1–C3, C5 filters (mechanical, ~10 lines total
   across files); C4 only if A3 = soft.
4. D-items as a cleanup batch; consider a lint/convention note in CLAUDE.md
   ("every query on a deletedAt model must filter or carry a comment saying
   why not") since there is no middleware to catch these.
