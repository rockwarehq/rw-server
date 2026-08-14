-- Replace MetricBucket's synthetic JOB key with real columns.
--
-- JOB-grain rows used entityId = md5(stationId || ':job:' || jobId)::uuid.
-- New shape: entityType = 'JOB', entityId = the station id, and a new
-- "jobId" column carries the job id. The bucket key becomes
-- (entityType, entityId, jobId, granularity, startTime).
--
-- REQUIRES PostgreSQL >= 15 for UNIQUE ... NULLS NOT DISTINCT (verify with
-- SELECT version() before deploy). Without NULLS NOT DISTINCT, non-JOB rows
-- (jobId IS NULL) would never conflict on the new unique index and every
-- ON CONFLICT upsert in the metrics pipeline would insert duplicates.
--
-- Order matters: the old 4-column unique index must be dropped BEFORE any
-- future conversion of legacy entityId values (the backfill rewrites
-- entityId for JOB rows, which would collide under the old key).
--
-- Companion backfill (run MANUALLY after this migration):
--   packages/db/scripts/backfill-metricbucket-jobkey.sql

-- ── MetricBucket ────────────────────────────────────────────────

-- 1. New key column (no FK — derived data, purely informational,
--    mirrors the shiftInstanceId precedent).
ALTER TABLE "MetricBucket" ADD COLUMN "jobId" UUID;

CREATE INDEX "MetricBucket_jobId_idx" ON "MetricBucket"("jobId");

-- 2. Drop the old 4-column unique index (created as a UNIQUE INDEX by
--    20260305171208_add_metric_buckets, not a table constraint).
DROP INDEX "MetricBucket_entityType_entityId_granularity_startTime_key";

-- 3. New 5-column unique key. NULLS NOT DISTINCT so rows with
--    jobId IS NULL (STATION/WORKCENTER/SITE) still conflict on upsert.
CREATE UNIQUE INDEX "MetricBucket_entity_jobId_granularity_startTime_key"
  ON "MetricBucket"("entityType", "entityId", "jobId", "granularity", "startTime")
  NULLS NOT DISTINCT;

-- ── MetricBucketLog ─────────────────────────────────────────────

-- 1. New key column.
ALTER TABLE "MetricBucketLog" ADD COLUMN "jobId" UUID;

CREATE INDEX "MetricBucketLog_jobId_idx" ON "MetricBucketLog"("jobId");

-- 2. Drop the old 4-column unique index (created as a UNIQUE INDEX by
--    20260312000000_metrics_overhaul).
DROP INDEX "MetricBucketLog_entityType_entityId_granularity_startTime_key";

-- 3. New 5-column unique key.
CREATE UNIQUE INDEX "MetricBucketLog_entity_jobId_granularity_startTime_key"
  ON "MetricBucketLog"("entityType", "entityId", "jobId", "granularity", "startTime")
  NULLS NOT DISTINCT;

-- ── Fallback for PostgreSQL < 15 (NOT USED — reference only) ────
--
-- If NULLS NOT DISTINCT is unavailable, replace step 3 on each table with
-- two partial unique indexes:
--
--   CREATE UNIQUE INDEX "MetricBucket_job_key"
--     ON "MetricBucket"("entityType", "entityId", "jobId", "granularity", "startTime")
--     WHERE "entityType" = 'JOB';
--   CREATE UNIQUE INDEX "MetricBucket_nonjob_key"
--     ON "MetricBucket"("entityType", "entityId", "granularity", "startTime")
--     WHERE "entityType" <> 'JOB';
--
--   CREATE UNIQUE INDEX "MetricBucketLog_job_key"
--     ON "MetricBucketLog"("entityType", "entityId", "jobId", "granularity", "startTime")
--     WHERE "entityType" = 'JOB';
--   CREATE UNIQUE INDEX "MetricBucketLog_nonjob_key"
--     ON "MetricBucketLog"("entityType", "entityId", "granularity", "startTime")
--     WHERE "entityType" <> 'JOB';
--
-- NOTE: the fallback also requires changing every ON CONFLICT site in
-- application code to use a matching index predicate
-- (ON CONFLICT (...) WHERE "entityType" = 'JOB' / <> 'JOB'), because
-- partial unique indexes are only inferred when the conflict target
-- repeats the predicate. The single NULLS NOT DISTINCT index needs no
-- per-site predicates.
