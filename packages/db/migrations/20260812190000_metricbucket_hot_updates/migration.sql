-- MetricBucket is the highest-churn table in the system: the metrics tick
-- rewrites the active buckets every 5 seconds (measured: 31M updates against
-- 69k rows in 12 days). Two problems compound as runtime accumulates:
--
--   1. The [siteId, updatedAt] index (zero scans ever recorded in
--      pg_stat_user_indexes) contains updatedAt, which every tick update
--      modifies — that disqualifies ALL updates from HOT (measured HOT ratio:
--      0.0%), so every update inserts dead entries into every index on the
--      table. Dropping it makes tick updates HOT-eligible.
--
--   2. Default fillfactor (100) leaves no page headroom, so even HOT-eligible
--      updates spill to new pages. 70 gives the 5s-churn rows room to stay
--      on-page.
--
-- Aggressive per-table autovacuum keeps dead tuples at the index "now" edge
-- low — planner range estimates probe index extremes, and dead tuples there
-- were measured costing ~11ms of PLANNING time per tick statement (3x the
-- execution time).

DROP INDEX IF EXISTS "MetricBucket_siteId_updatedAt_idx";

ALTER TABLE "MetricBucket" SET (fillfactor = 70);
ALTER TABLE "MetricBucket" SET (
  autovacuum_vacuum_scale_factor = 0.02,
  autovacuum_vacuum_cost_delay = 0
);

-- NOTE: fillfactor applies to newly written pages only. To apply it to the
-- existing table (and clear accumulated bloat) run once, out of band:
--   VACUUM FULL "MetricBucket";
-- (~100MB table, sub-second exclusive lock; cannot run inside this migration
-- because migrations execute in a transaction.)
