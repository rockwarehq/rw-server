-- Stage C (star schema): hour-close bookkeeping column.
--
-- "closedAt" marks a STATION HOUR row family as finalized: Stage D's
-- hour-close pass stamps it after the last recompute of an elapsed hour,
-- letting the 5s base writer skip closed hours entirely. NULL = still
-- open (the base writer keeps recomputing it).
--
-- Companion backfill (run MANUALLY, AFTER the Stage C deploy):
--   packages/db/scripts/backfill-metricbucket-base-grain.sql
-- (it stamps closedAt for rows whose window is fully in the past).

ALTER TABLE "MetricBucket" ADD COLUMN "closedAt" TIMESTAMPTZ(3);

-- Partial index over the OPEN base-grain rows — the exact set the 5s
-- tick and the hour-close pass scan. Stays tiny: rows leave the index
-- the moment they are stamped closed.
CREATE INDEX "MetricBucket_open_station_hour_idx"
  ON "MetricBucket"("entityId", "startTime")
  WHERE "closedAt" IS NULL
    AND "entityType" = 'STATION'
    AND "granularity" = 'HOUR';
