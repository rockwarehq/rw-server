-- Backfill: MetricBucket / MetricBucketLog JOB-key migration.
--
-- Companion to migration 20260814100000_metric_bucket_job_key. Run MANUALLY
-- with psql against the DIRECT (non-pooled) connection, after the migration
-- has been deployed:
--
--   psql "$DATABASE_URL_MIGRATION" -f packages/db/scripts/backfill-metricbucket-jobkey.sql
--
-- Legacy JOB-grain rows used entityId = md5(stationId || ':job:' || jobId)::uuid.
-- This script rewrites them to the new shape: entityId = station id,
-- jobId = job id (new column). Two row populations exist:
--
-- 1. Normal legacy rows — path LIKE '%.station.%'
--    (e.g. "site.{id}.workcenter.{id}.station.{id}.job.{jobId}"):
--    * entityId := the station uuid extracted from the path
--    * jobId    := COALESCE("currentJobId", uuid segment after '.job.')
--                  (JOB writers always stamped currentJobId with the real
--                  job id, so the path segment is only a fallback)
--    * path     := job suffix rewritten to '.job.{jobId}' in case it
--                  carried the md5 composite
--
-- 2. Poisoned rows — path NOT LIKE '%.station.%', produced by an old
--    hierarchy fallback that wrote "site.{siteId}.job.{md5}":
--    * recover (stationId, jobId) by matching entityId against
--      md5(stationId::text || ':job:' || jobId::text)::uuid over the
--      DISTINCT (stationId, jobId) pairs in "StationJobLog"
--    * rebuild path from an existing STATION bucket's path when available
--    * rows with no StationJobLog match are DELETEd (unrecoverable)
--
-- Conflict rule: if a row already exists at the target key
-- (entityType, entityId, jobId, granularity, startTime) — e.g. the new
-- write path already recomputed the bucket — the legacy row is DELETEd.
-- Buckets are derived data; the recomputed new-style row wins.
--
-- Batched keyset updates with a COMMIT per batch — no long transaction,
-- safe to interrupt and re-run (idempotent: only rows with jobId IS NULL
-- are touched). Progress is RAISEd per batch.

-- ── MetricBucket: normal legacy rows ────────────────────────────

CREATE OR REPLACE PROCEDURE backfill_metricbucket_jobkey(batch_size int DEFAULT 10000)
LANGUAGE plpgsql
AS $$
DECLARE
  updated int;
  deleted int;
  dropped int;
  total bigint := 0;
BEGIN
  LOOP
    -- One batch of unmigrated normal legacy JOB rows.
    CREATE TEMP TABLE IF NOT EXISTS _mb_batch (id uuid PRIMARY KEY, new_entity_id uuid, new_job_id uuid) ON COMMIT DROP;
    TRUNCATE _mb_batch;

    INSERT INTO _mb_batch (id, new_entity_id, new_job_id)
    SELECT mb.id,
           (substring(mb.path FROM '\.station\.([0-9a-fA-F-]{36})'))::uuid,
           COALESCE(
             mb."currentJobId",
             CASE WHEN split_part(mb.path, '.job.', 2) ~ '^[0-9a-fA-F-]{36}$'
                  THEN split_part(mb.path, '.job.', 2)::uuid END
           )
    FROM "MetricBucket" mb
    WHERE mb."entityType" = 'JOB'
      AND mb."jobId" IS NULL
      AND mb.path LIKE '%.station.%'
    ORDER BY mb.id
    LIMIT batch_size;

    -- Unresolvable rows (no currentJobId and no parseable '.job.' uuid
    -- segment): derived data with no recoverable key — delete.
    DELETE FROM "MetricBucket" mb
    USING _mb_batch b
    WHERE mb.id = b.id AND (b.new_entity_id IS NULL OR b.new_job_id IS NULL);
    GET DIAGNOSTICS dropped = ROW_COUNT;

    -- Rows whose target key is already taken: the recomputed new-style
    -- row wins — delete the legacy row.
    DELETE FROM "MetricBucket" mb
    USING _mb_batch b
    WHERE mb.id = b.id
      AND b.new_entity_id IS NOT NULL AND b.new_job_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM "MetricBucket" t
        WHERE t."entityType" = 'JOB'
          AND t."entityId" = b.new_entity_id
          AND t."jobId" = b.new_job_id
          AND t.granularity = mb.granularity
          AND t."startTime" = mb."startTime"
      );
    GET DIAGNOSTICS deleted = ROW_COUNT;

    -- Migrate the rest: real key columns + path job-suffix rewrite.
    UPDATE "MetricBucket" mb SET
      "entityId" = b.new_entity_id,
      "jobId"    = b.new_job_id,
      path       = regexp_replace(mb.path, '\.job\.[^.]+.*$', '.job.' || b.new_job_id)
    FROM _mb_batch b
    WHERE mb.id = b.id;
    GET DIAGNOSTICS updated = ROW_COUNT;

    total := total + updated + deleted + dropped;
    RAISE NOTICE 'backfill_metricbucket_jobkey: % updated, % conflict-deleted, % unresolvable-deleted this batch (% total)',
      updated, deleted, dropped, total;
    COMMIT;
    EXIT WHEN updated + deleted + dropped = 0;
  END LOOP;
END;
$$;

-- ── MetricBucket: poisoned rows (site-level fallback paths) ─────

CREATE OR REPLACE PROCEDURE backfill_metricbucket_jobkey_poisoned(batch_size int DEFAULT 10000)
LANGUAGE plpgsql
AS $$
DECLARE
  updated int;
  deleted int;
  dropped int;
  total bigint := 0;
BEGIN
  LOOP
    CREATE TEMP TABLE IF NOT EXISTS _mbp_batch (id uuid PRIMARY KEY, new_entity_id uuid, new_job_id uuid) ON COMMIT DROP;
    TRUNCATE _mbp_batch;

    -- Recover (stationId, jobId) by reversing the md5 composite over
    -- every station×job pair that ever ran (StationJobLog).
    INSERT INTO _mbp_batch (id, new_entity_id, new_job_id)
    SELECT mb.id, pair."stationId", pair."jobId"
    FROM "MetricBucket" mb
    LEFT JOIN LATERAL (
      SELECT sj."stationId", sj."jobId"
      FROM (SELECT DISTINCT "stationId", "jobId" FROM "StationJobLog") sj
      WHERE md5(sj."stationId"::text || ':job:' || sj."jobId"::text)::uuid = mb."entityId"
      LIMIT 1
    ) pair ON TRUE
    WHERE mb."entityType" = 'JOB'
      AND mb."jobId" IS NULL
      AND mb.path NOT LIKE '%.station.%'
    ORDER BY mb.id
    LIMIT batch_size;

    -- Unmatched: no StationJobLog pair reproduces the md5 — unrecoverable.
    DELETE FROM "MetricBucket" mb
    USING _mbp_batch b
    WHERE mb.id = b.id AND b.new_entity_id IS NULL;
    GET DIAGNOSTICS dropped = ROW_COUNT;

    -- Target key already taken → recomputed new-style row wins.
    DELETE FROM "MetricBucket" mb
    USING _mbp_batch b
    WHERE mb.id = b.id
      AND b.new_entity_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM "MetricBucket" t
        WHERE t."entityType" = 'JOB'
          AND t."entityId" = b.new_entity_id
          AND t."jobId" = b.new_job_id
          AND t.granularity = mb.granularity
          AND t."startTime" = mb."startTime"
      );
    GET DIAGNOSTICS deleted = ROW_COUNT;

    -- Migrate: rebuild path from an existing STATION bucket when
    -- available (live table first, then archive), else a minimal
    -- site.{siteId}.station.{stationId} prefix.
    UPDATE "MetricBucket" mb SET
      "entityId" = b.new_entity_id,
      "jobId"    = b.new_job_id,
      path       = COALESCE(sp.station_path,
                            'site.' || mb."siteId" || '.station.' || b.new_entity_id)
                   || '.job.' || b.new_job_id
    FROM _mbp_batch b
    LEFT JOIN LATERAL (
      SELECT s.path AS station_path FROM "MetricBucket" s
      WHERE s."entityType" = 'STATION' AND s."entityId" = b.new_entity_id AND s.path <> ''
      UNION ALL
      SELECT sl.path FROM "MetricBucketLog" sl
      WHERE sl."entityType" = 'STATION' AND sl."entityId" = b.new_entity_id AND sl.path <> ''
      LIMIT 1
    ) sp ON TRUE
    WHERE mb.id = b.id;
    GET DIAGNOSTICS updated = ROW_COUNT;

    total := total + updated + deleted + dropped;
    RAISE NOTICE 'backfill_metricbucket_jobkey_poisoned: % updated, % conflict-deleted, % unmatched-deleted this batch (% total)',
      updated, deleted, dropped, total;
    COMMIT;
    EXIT WHEN updated + deleted + dropped = 0;
  END LOOP;
END;
$$;

-- ── MetricBucketLog: normal legacy rows ─────────────────────────

CREATE OR REPLACE PROCEDURE backfill_metricbucketlog_jobkey(batch_size int DEFAULT 10000)
LANGUAGE plpgsql
AS $$
DECLARE
  updated int;
  deleted int;
  dropped int;
  total bigint := 0;
BEGIN
  LOOP
    CREATE TEMP TABLE IF NOT EXISTS _mbl_batch (id uuid PRIMARY KEY, new_entity_id uuid, new_job_id uuid) ON COMMIT DROP;
    TRUNCATE _mbl_batch;

    INSERT INTO _mbl_batch (id, new_entity_id, new_job_id)
    SELECT mb.id,
           (substring(mb.path FROM '\.station\.([0-9a-fA-F-]{36})'))::uuid,
           COALESCE(
             mb."currentJobId",
             CASE WHEN split_part(mb.path, '.job.', 2) ~ '^[0-9a-fA-F-]{36}$'
                  THEN split_part(mb.path, '.job.', 2)::uuid END
           )
    FROM "MetricBucketLog" mb
    WHERE mb."entityType" = 'JOB'
      AND mb."jobId" IS NULL
      AND mb.path LIKE '%.station.%'
    ORDER BY mb.id
    LIMIT batch_size;

    DELETE FROM "MetricBucketLog" mb
    USING _mbl_batch b
    WHERE mb.id = b.id AND (b.new_entity_id IS NULL OR b.new_job_id IS NULL);
    GET DIAGNOSTICS dropped = ROW_COUNT;

    DELETE FROM "MetricBucketLog" mb
    USING _mbl_batch b
    WHERE mb.id = b.id
      AND b.new_entity_id IS NOT NULL AND b.new_job_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM "MetricBucketLog" t
        WHERE t."entityType" = 'JOB'
          AND t."entityId" = b.new_entity_id
          AND t."jobId" = b.new_job_id
          AND t.granularity = mb.granularity
          AND t."startTime" = mb."startTime"
      );
    GET DIAGNOSTICS deleted = ROW_COUNT;

    UPDATE "MetricBucketLog" mb SET
      "entityId" = b.new_entity_id,
      "jobId"    = b.new_job_id,
      path       = regexp_replace(mb.path, '\.job\.[^.]+.*$', '.job.' || b.new_job_id)
    FROM _mbl_batch b
    WHERE mb.id = b.id;
    GET DIAGNOSTICS updated = ROW_COUNT;

    total := total + updated + deleted + dropped;
    RAISE NOTICE 'backfill_metricbucketlog_jobkey: % updated, % conflict-deleted, % unresolvable-deleted this batch (% total)',
      updated, deleted, dropped, total;
    COMMIT;
    EXIT WHEN updated + deleted + dropped = 0;
  END LOOP;
END;
$$;

-- ── MetricBucketLog: poisoned rows ──────────────────────────────

CREATE OR REPLACE PROCEDURE backfill_metricbucketlog_jobkey_poisoned(batch_size int DEFAULT 10000)
LANGUAGE plpgsql
AS $$
DECLARE
  updated int;
  deleted int;
  dropped int;
  total bigint := 0;
BEGIN
  LOOP
    CREATE TEMP TABLE IF NOT EXISTS _mblp_batch (id uuid PRIMARY KEY, new_entity_id uuid, new_job_id uuid) ON COMMIT DROP;
    TRUNCATE _mblp_batch;

    INSERT INTO _mblp_batch (id, new_entity_id, new_job_id)
    SELECT mb.id, pair."stationId", pair."jobId"
    FROM "MetricBucketLog" mb
    LEFT JOIN LATERAL (
      SELECT sj."stationId", sj."jobId"
      FROM (SELECT DISTINCT "stationId", "jobId" FROM "StationJobLog") sj
      WHERE md5(sj."stationId"::text || ':job:' || sj."jobId"::text)::uuid = mb."entityId"
      LIMIT 1
    ) pair ON TRUE
    WHERE mb."entityType" = 'JOB'
      AND mb."jobId" IS NULL
      AND mb.path NOT LIKE '%.station.%'
    ORDER BY mb.id
    LIMIT batch_size;

    DELETE FROM "MetricBucketLog" mb
    USING _mblp_batch b
    WHERE mb.id = b.id AND b.new_entity_id IS NULL;
    GET DIAGNOSTICS dropped = ROW_COUNT;

    DELETE FROM "MetricBucketLog" mb
    USING _mblp_batch b
    WHERE mb.id = b.id
      AND b.new_entity_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM "MetricBucketLog" t
        WHERE t."entityType" = 'JOB'
          AND t."entityId" = b.new_entity_id
          AND t."jobId" = b.new_job_id
          AND t.granularity = mb.granularity
          AND t."startTime" = mb."startTime"
      );
    GET DIAGNOSTICS deleted = ROW_COUNT;

    UPDATE "MetricBucketLog" mb SET
      "entityId" = b.new_entity_id,
      "jobId"    = b.new_job_id,
      path       = COALESCE(sp.station_path,
                            'site.' || mb."siteId" || '.station.' || b.new_entity_id)
                   || '.job.' || b.new_job_id
    FROM _mblp_batch b
    LEFT JOIN LATERAL (
      SELECT s.path AS station_path FROM "MetricBucket" s
      WHERE s."entityType" = 'STATION' AND s."entityId" = b.new_entity_id AND s.path <> ''
      UNION ALL
      SELECT sl.path FROM "MetricBucketLog" sl
      WHERE sl."entityType" = 'STATION' AND sl."entityId" = b.new_entity_id AND sl.path <> ''
      LIMIT 1
    ) sp ON TRUE
    WHERE mb.id = b.id;
    GET DIAGNOSTICS updated = ROW_COUNT;

    total := total + updated + deleted + dropped;
    RAISE NOTICE 'backfill_metricbucketlog_jobkey_poisoned: % updated, % conflict-deleted, % unmatched-deleted this batch (% total)',
      updated, deleted, dropped, total;
    COMMIT;
    EXIT WHEN updated + deleted + dropped = 0;
  END LOOP;
END;
$$;

CALL backfill_metricbucket_jobkey();
CALL backfill_metricbucket_jobkey_poisoned();
CALL backfill_metricbucketlog_jobkey();
CALL backfill_metricbucketlog_jobkey_poisoned();

DROP PROCEDURE backfill_metricbucket_jobkey(int);
DROP PROCEDURE backfill_metricbucket_jobkey_poisoned(int);
DROP PROCEDURE backfill_metricbucketlog_jobkey(int);
DROP PROCEDURE backfill_metricbucketlog_jobkey_poisoned(int);

-- ── Post-run assertions ─────────────────────────────────────────
-- Fail loudly if any legacy-shaped JOB row survived.

DO $$
DECLARE n bigint;
BEGIN
  SELECT COUNT(*) INTO n FROM "MetricBucket" WHERE "entityType" = 'JOB' AND "jobId" IS NULL;
  IF n > 0 THEN RAISE EXCEPTION 'MetricBucket: % JOB rows still have jobId IS NULL', n; END IF;

  SELECT COUNT(*) INTO n FROM "MetricBucketLog" WHERE "entityType" = 'JOB' AND "jobId" IS NULL;
  IF n > 0 THEN RAISE EXCEPTION 'MetricBucketLog: % JOB rows still have jobId IS NULL', n; END IF;

  SELECT COUNT(*) INTO n FROM "MetricBucket" mb
  WHERE mb."entityType" = 'JOB'
    AND NOT EXISTS (SELECT 1 FROM "Station" s WHERE s.id = mb."entityId");
  IF n > 0 THEN RAISE EXCEPTION 'MetricBucket: % JOB rows whose entityId is not a Station id', n; END IF;

  SELECT COUNT(*) INTO n FROM "MetricBucketLog" mb
  WHERE mb."entityType" = 'JOB'
    AND NOT EXISTS (SELECT 1 FROM "Station" s WHERE s.id = mb."entityId");
  IF n > 0 THEN RAISE EXCEPTION 'MetricBucketLog: % JOB rows whose entityId is not a Station id', n; END IF;

  RAISE NOTICE 'backfill-metricbucket-jobkey: all assertions passed';
END;
$$;

-- Verification queries (run after):
--   SELECT COUNT(*) FROM "MetricBucket"    WHERE "entityType" = 'JOB' AND "jobId" IS NULL;  -- expect 0
--   SELECT COUNT(*) FROM "MetricBucketLog" WHERE "entityType" = 'JOB' AND "jobId" IS NULL;  -- expect 0
--   SELECT COUNT(*) FROM "MetricBucket" mb WHERE mb."entityType" = 'JOB'
--     AND NOT EXISTS (SELECT 1 FROM "Station" s WHERE s.id = mb."entityId");                -- expect 0
--   SELECT COUNT(*) FROM "MetricBucketLog" mb WHERE mb."entityType" = 'JOB'
--     AND NOT EXISTS (SELECT 1 FROM "Station" s WHERE s.id = mb."entityId");                -- expect 0
