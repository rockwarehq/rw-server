# MES Core Roadmap — Cycle Capture, Historical Tracking, Downtime/OEE Reporting

Status: adopted 2026-07-12. Scope: fixes and improvements to the platform's core MES
surfaces — cycle capture and its historical record, historical querying, and
downtime/OEE history and reports.

Sources: a full review of the cycle pipeline, metrics pipeline, and reporting layer
(2026-07-12), consolidated with the repo's own audits — ADR 0006 "Flagged for review",
and the 2026-07-10 scratch audits of the rollup pipeline, soft-delete filters, and
version-table queries (findings folded in here; the scratch files themselves are
untracked and superseded by this roadmap and its issues).

Product-default decisions that unblock Phase 1 (history visibility for soft-deleted
entities, Cycle/InventoryItem soft-delete story, Station delete semantics, negative
quality clamp, itemsPerCycle snapshotting) are recorded in
[ADR 0007](apps/docs/src/app/internal/adrs/0007-mes-history-correctness-defaults/page.mdx).

Effort key: **S** ≤ 1 day · **M** = days · **L** = 1–2 weeks.

## Sequencing

```
Phase 0 (harness) → Phase 1 (correctness) → Phase 2 (durability) → Phase 3 (perf/retention) → Phase 4 (features)
    ~1–2 wk             ~2–3 wk                 ~1–2 wk                ~3–5 wk                    ~3–4 wk
```

Hard ordering constraints:

- **2.1 before 3.7** — the `sourceEventId` unique index must be designed
  partition-compatible before `Cycle` is partitioned.
- **3.5 before 4.1** — downtime split re-attribution reuses the recalc path 3.5 hardens.
- **3.1/3.2 before 3.3/3.4** — delete dead code and fix rounding drift first; the
  IS DISTINCT FROM guards only start skipping once rounding agrees.

Parallelizable filler for a second engineer: 0.3, 1.1, 4.2, 4.4.

---

## Phase 0 — Integration test harness (~1–2 wk)

Nearly every fix below says "verify via integration test", and no runnable harness
exists: `packages/services` has no `test` script and zero tests on the cycle/metrics
paths. Advisory locks and raw SQL in `cycle.ts` make mocking Prisma a dead end — the
harness needs a real Postgres.

| # | Item | Effort |
| --- | --- | --- |
| 0.1 | Test infra: vitest + `test` script in `packages/services`, ephemeral Postgres (testcontainers or a `postgres` service in `compose.yml`, which currently only has NATS), `prisma migrate deploy` + seed factories (site/station/job/shift). Follow the vitest patterns in `apps/api/test/`. | M |
| 0.2 | Implement the documented 107-invariant scenario from `packages/services/src/metrics/README.md` as the first integration test (cycles → HOUR buckets → rollups → archive). Highest-leverage single test; can land in tranches (capture → rollup → archive). | L |
| 0.3 | Focused tests for the paths Phase 1 touches: `cycle.complete()` all three strategies (immediate, open/close, replayed) + validation errors; `downtimeLogSearch` shift clamping; `cycleSearch` SQL CTE. | M |

## Phase 1 — Correctness of historical/OEE data (~2–3 wk)

Historical reports (OEE, shift recaps, downtime) must stop silently drifting from
reality. All items ship with harness assertions.

| # | Item | Effort |
| --- | --- | --- |
| 1.1 | **Batch PR of mechanical fixes:** (a) `syncExpectedCyclesFromJobs` skips its UPDATE when no JOB HOUR rows matched — today a zero-row aggregate zeroes the station's expected\* every 5 s tick (`packages/services/src/metrics/cascade.ts` ~467–523, ADR 0006 flag #3); (b) order line-item healer excludes soft-deleted orders (`packages/services/src/order/allocation.ts:31-38`); (c) six deletion guards use filtered `_count` so soft-deleted children stop blocking deletion (`inventory/product.ts:357`, `job/job.ts:368`, `job/tool.ts:265,463`, `inventory/disposition.ts:149`, `inventory/disposition-reason.ts:225`); (d) background reconciler skips soft-deleted jobs (`packages/services/src/queues/background-workers.ts:215`); (e) missing Cycle/InventoryItem `deletedAt` filters in `cascade.ts` cycle_stats, `compute.ts` itemCounts, prev-cycle/open-cycle lookups in `cycle/cycle.ts` and `state.ts`, Tool join in `cycle.ts` (per ADR 0007 A2 default). | M |
| 1.2 | **Job re-version mid-assignment desyncs JOB vs STATION KPIs.** `job.update()` (`packages/services/src/job/job.ts` ~322) creates a new JobVersion without closing/reopening the open `StationJobLog` or splitting the open state entry, so JOB buckets keep the old standardCycle while STATION buckets use the new one. Fix: treat re-version like a job-change boundary per assigned station (close/reopen StationJobLog, `splitOpenStateEntryForJobChange`, `recalcAll` after commit — mirroring `facility/station/actions/jobchange.ts`). | M |
| 1.3 | **Verify the archive expected\*-clobber fix** (commit `ae22d84`) with an integration test: multi-item job (itemsPerCycle = 2), let the hour close and archive, assert `MetricBucketLog.expectedItems` matches the pre-archive live value. Optional follow-up (only if customers query pre-fix history): backfill affected archived STATION rows from JOB rows in the same window. | S (+M opt.) |
| 1.4 | **Clamp negative quality/OEE at 0** at read/archive time, keep raw counters unclamped (ADR 0007). Touches `apps/api/src/rpc/logs.ts`, `apps/api/src/rpc/metrics.ts`, and a MetricBucketLog generated-column migration. | S |
| 1.5 | **Snapshot itemsPerCycle onto `StationJobLog`** at assignment (same pattern as `standardCycle`, ADR 0007) and read the snapshot at the four live-resolution sites (`metrics/recalc.ts` ~160 and ~527, `metrics/cascade.ts` job_meta ~202 and batch queries) — so recomputing a historical window stops valuing expected\* with today's quantities. | M |
| 1.6 | **Station delete → soft-delete** per ADR 0007 A3 (`facility/station/crud.ts:537`), plus the metrics tick-discovery filter (`cascade.ts` open_stations ~702) and the operator logon check (`apps/api/src/rpc/operator.ts:157`). | S–M |

## Phase 2 — Ingestion durability (~1–2 wk)

Cycle capture becomes effectively exactly-once from the consumer's perspective, and
degrades loudly instead of silently.

| # | Item | Effort |
| --- | --- | --- |
| 2.1 | **Durable dedup via `sourceEventId`.** Hook events already carry a stable UUID end-to-end (`hook-manager.ts:224` mints it; it rides in the payload past the 2-minute NATS msgID window). Add `sourceEventId String? @unique @db.Uuid` to `Cycle`; thread `event.id` from `apps/workers/src/imm-events.ts:75` through `cycle.complete()` onto the Cycle insert (inside the existing advisory-locked tx — the Cycle row is the idempotency record, no separate table to GC); catch P2002 → ack as already-processed. Keep the in-process Set as a fast path. Closes the acknowledged "restart between commit and ack" gap (`imm-events.ts:86-87`). Residual (out of scope): producer crash-before-publish re-emits with a new id — upstream at-least-once property. | M |
| 2.2 | **Out-of-order / clock-skew guard** in `cycle.complete()`: clamp-and-flag (marker in `attrs`) timestamps earlier than the previous cycle's end minus a small tolerance, with a log/metric so ops sees skewed PLC clocks. Clamp, don't reject — never drop production counts. | M |
| 2.3 | **Un-silence the shift-resolution skip** in material consumption (`packages/services/src/inventory/inventory.ts:126`): warn + metric + clock-aligned fallback instead of silently dropping consumption. | S |
| 2.4 | **ShiftInstance just-in-time materialization** (scheduled job in `packages/services/src/queues/`): today production silently falls back to clock-aligned hours when instances aren't seeded. Pull forward into Phase 1 if any customer's shift recaps are actively wrong. | M |

## Phase 3 — Performance & retention (~3–5 wk, PlanetScale-sensitive)

Round-trips and pooled-connection pressure matter more than CPU. The Phase 0
invariant test is the regression net for these rewrites. Explicitly fine as-is (do
not "optimize"): the per-cycle hot path, the unconditional 5 s tick (duration KPIs
advance with elapsed time), the live/archive table split, IS DISTINCT FROM guards,
and DB-generated OEE columns.

| # | Item | Effort |
| --- | --- | --- |
| 3.1 | Delete dead `batchCountRollup` (contradictory badItems semantics, ADR 0006 flag #1) and the vestigial Redis dirty-bucket queue (`batcher.ts` ~289–295 drain + the `cycle.ts` push site). | S |
| 3.2 | Unify `idealCycleSeconds` rounding on sum-then-round everywhere (ADR 0006 flag #4) so the skip-unchanged guards actually skip; reduces write churn for free. | S–M |
| 3.3 | `cascadeParentRollup` (`cascade.ts` ~1033): aggregate only the hot set (buckets with `updatedAt > now() − 2×tick`) plus a periodic full 24 h self-heal pass, instead of the current 24 h scan across all granularities every 5 s. Fix the comment/window mismatch while there. | M |
| 3.4 | Collapse tick phases 3/4 from one-query-per-station to set-based statements over all stations (deterministic lock order via ORDER BY entityId); target ~5 statements per tick regardless of station count. | M–L |
| 3.5 | `rollup.ts` recalc path: single-statement guarded upserts + batched per-window sums (60–90 → a handful of round-trips per 8 h recalc). `archive.ts` N+1 → set-based CTE chain (2–3 statements per site), keeping the "freeze durations only" rule; re-run the 1.3 test. | M + M |
| 3.6 | `ALTER TABLE "MetricBucket" SET (fillfactor = 70)` migration (updates go HOT — churned columns are unindexed); evaluate raising `COMBINED_TICK_MS` only after measuring 3.3/3.4. | S |
| 3.7 | **Retention/partitioning:** native monthly `PARTITION BY RANGE` on `Cycle`, `StationStateLog`, `ItemDispositionLog` + scheduled DROP PARTITION retention. TimescaleDB already ruled out (not on PlanetScale; shift-aligned variable-width buckets don't fit caggs). Copy-swap migration needs a maintenance window; verify `cycleSearch`/`downtimeLogSearch` plans prune partitions. Requires 2.1 first — resolve the unique-index-vs-partition-key interaction (e.g. `UNIQUE (sourceEventId, end)` or a partition-aware dedup lookup) in a short design doc. | L |

## Phase 4 — Reporting features & query gaps (~3–4 wk)

| # | Item | Effort |
| --- | --- | --- |
| 4.1 | **Downtime split/re-annotation API** (flagship): split one long DOWN period into multiple reason-coded stretches (ADR 0005 future item; `StatusReason`/`StationStateLog` model already supports it). New rpc + period splitting in `facility/station/state.ts` + downtime re-attribution for affected hours via the recalc path hardened in 3.5. Reason-coded downtime is what makes availability numbers actionable. | L |
| 4.2 | `jobMetricsList` returns the md5 composite bucket entityId as `jobId` (`apps/api/src/rpc/shift-recap.ts` ~258) — return the real job id (`currentJobId` is already selected, or parse the `path` suffix). Fix before any UI drill-down links to it. | S |
| 4.3 | CSV export for shift recaps / OEE / downtime searches, streamed from the existing search SQL (no new aggregation). | M |
| 4.4 | `inventory.list`: add parent `productId`/`jobProductId` filters alongside the exact-version filters (version-audit footgun — filtering by `currentVersionId` silently drops items from older versions). `materialUsageSearch`: group by parent IDs and label with current names, following the `material-ledger.ts` pattern, instead of grouping by snapshotted version names. | S + S–M |
| 4.5 | *(Optional)* Wire the change-notification transport (`metrics/sync.ts` `onBucketsChanged` flattens and logs only) + a dashboard stale-data indicator. | M |
| 4.6 | *(Skip)* MINUTE granularity — enum exists, no driver, and it conflicts with the Phase 3 write-churn goals. Leave dormant. | — |

---

## Verified findings appendix (why these items, 2026-07-12)

- `cycle.complete()` is **not idempotent**; dedup today is the 2-minute NATS msgID
  window + a 10k in-process Set, and the code acknowledges durable dedup as a
  follow-up (`apps/workers/src/imm-events.ts:86-87`). `Cycle` has no source-event
  column (`packages/db/schema/cycle.prisma`).
- Hook events carry a stable UUID from emit to consumer
  (`packages/livestore/src/resolvers/hook-manager.ts:224,240`), which is what makes
  the 2.1 design a small change rather than an event-envelope project.
- `packages/services` has **no `test` script**; the 107-invariant metrics scenario is
  documented in `packages/services/src/metrics/README.md` but no runnable test file
  exists in the repo. `compose.yml` provisions only NATS — no local Postgres for tests.
- The expected\*-zeroing in `syncExpectedCyclesFromJobs` and the JOB-vs-STATION
  re-version desync are the two active correctness bugs with visible KPI impact;
  everything else in Phase 1 is either latent (no writer today) or bounded.
- The archive expected\*-clobber fix landed as `ae22d84` but has never been verified
  by a test, and pre-fix archived history still holds undercounted `expectedItems`
  for multi-item jobs.
