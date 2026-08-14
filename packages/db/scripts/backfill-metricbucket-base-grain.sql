-- Backfill: MetricBucket / MetricBucketLog base-grain migration (Stage C).
--
-- Collapses the legacy multi-tier bucket layout to the single persisted
-- grain: STATION-family HOUR rows — one row per (station, job) plus a
-- RESIDUAL row per (station, hour) at jobId NULL. After this script the
-- only rows left in either table are entityType='STATION' AND
-- granularity='HOUR'.
--
-- Run MANUALLY with psql against the DIRECT (non-pooled) connection,
-- AFTER the Stage C deploy (the new writer must already be live so no
-- process re-creates tier rows) and after migration
-- 20260814130000_metric_bucket_closed_at:
--
--   psql "$DATABASE_URL_MIGRATION" -f packages/db/scripts/backfill-metricbucket-base-grain.sql
--
-- ── BACKUP FIRST (mandatory) ────────────────────────────────────
-- This script deletes whole tiers. Take cheap in-database backups and
-- verify their counts before running anything else:
--
--   CREATE TABLE "MetricBucket_bak"    AS TABLE "MetricBucket";
--   CREATE TABLE "MetricBucketLog_bak" AS TABLE "MetricBucketLog";
--   SELECT (SELECT COUNT(*) FROM "MetricBucket")    = (SELECT COUNT(*) FROM "MetricBucket_bak"),
--          (SELECT COUNT(*) FROM "MetricBucketLog") = (SELECT COUNT(*) FROM "MetricBucketLog_bak");
--
-- Drop the _bak tables only after the assertions at the bottom pass and
-- downstream dashboards have been spot-checked.
--
-- ── What this script does ───────────────────────────────────────
--  1. Snapshot pre-decomposition STATION HOUR sums (assertion baseline).
--  2. Residual decomposition: STATION HOUR rows with JOB-family HOUR
--     siblings become the residual — each additive column :=
--     GREATEST(0, station − Σ jobs); expected*/elapsedExpected* := 0;
--     currentStandardCycle/currentJob* := NULL. (Both tables.)
--  3. Family conversion: JOB HOUR rows → entityType='STATION' (the jobId
--     column already carries the job — collision-free under the 5-column
--     key except where the Stage C writer already wrote the target row,
--     in which case the legacy JOB row is deleted; the recomputed row wins).
--     (Both tables.)
--  4. Tier deletion: STATION SHIFT/DAY/MINUTE, all WORKCENTER/SITE
--     granularities, JOB SHIFT/DAY. (Both tables.)
--  5. closedAt backfill: rows whose window is fully in the past get
--     closedAt = startTime + durationSeconds (live table only — the log
--     table has no closedAt).
--  6. Assertions: per station×hour the post-backfill family SUM must
--     match the snapshot (counts exact, durations within ±2s); zero
--     non-STATION / non-HOUR rows remain. Violations are REPORTED row
--     by row; the terminal DO block raises on any leftover tier rows.
--
-- ── Historical accuracy caveat (pre-Stage-A hours) ──────────────
-- Hours produced before Stage A carry only the LATEST job's JOB row for
-- multi-job hours (the old writer overwrote a single row per hour), so
-- the computed residual over-attributes no-job time for those hours:
-- time that actually belonged to earlier jobs of the hour stays on the
-- residual. Counts are unaffected (cycles were stamped). If per-job
-- accuracy matters for a historical window, re-derive it from raw
-- events AFTER this backfill with the recompute entry point:
--   recalcAll(stationId, siteId, rangeStart, rangeEnd)   (recalc.ts)
-- which re-runs the base writer per hour (live rows only).
--
-- ── Interim reader predicate ────────────────────────────────────
-- read.ts (aggregateJobHours) and apps/api/src/rpc/metric-hour-sql.ts
-- keep the union predicate
--   (entityType='JOB' OR (entityType='STATION' AND jobId IS NOT NULL))
-- with STATION-preferred dedup until this backfill has run in EVERY
-- environment. Once no JOB-family rows remain anywhere, those two spots
-- can be simplified to entityType='STATION' AND jobId IS NOT NULL and
-- the DISTINCT ON dedup dropped. Do NOT simplify before then.
--
-- Batched keyset procedures with a COMMIT per batch — no long
-- transaction, safe to interrupt and re-run (steps are idempotent: the
-- residual step tracks processed rows in a helper table; the other
-- steps only match rows that still need work). Progress is RAISEd per
-- batch.

-- ── 1. Snapshot pre-decomposition STATION HOUR sums ─────────────
-- One row per (source table, station, hour): the legacy whole-station
-- row's values PLUS any JOB-family siblings do not enter the sum — the
-- whole-station row alone was the station-scope truth pre-backfill, so
-- it is the baseline the post-backfill family sum must reproduce.
-- Persisted (not TEMP) so per-batch COMMITs don't drop it; removed at
-- the end.

CREATE TABLE IF NOT EXISTS _mb_base_grain_snapshot AS
SELECT src, "entityId", "startTime",
       "totalCycles", "badCycles", "totalItems", "badItems",
       "runSeconds", "downSeconds", "plannedDownSeconds", "unplannedDownSeconds",
       "idealCycleSeconds", "totalCycleSeconds", "elapsedPlannedProductionSeconds"
FROM (
  SELECT 'live' AS src, "entityId", "startTime",
         "totalCycles", "badCycles", "totalItems", "badItems",
         "runSeconds", "downSeconds", "plannedDownSeconds", "unplannedDownSeconds",
         "idealCycleSeconds", "totalCycleSeconds", "elapsedPlannedProductionSeconds"
  FROM "MetricBucket"
  WHERE "entityType" = 'STATION' AND granularity = 'HOUR' AND "jobId" IS NULL
  UNION ALL
  SELECT 'log', "entityId", "startTime",
         "totalCycles", "badCycles", "totalItems", "badItems",
         "runSeconds", "downSeconds", "plannedDownSeconds", "unplannedDownSeconds",
         "idealCycleSeconds", "totalCycleSeconds", "elapsedPlannedProductionSeconds"
  FROM "MetricBucketLog"
  WHERE "entityType" = 'STATION' AND granularity = 'HOUR' AND "jobId" IS NULL
) s;

-- Idempotency ledger for step 2 (subtracting twice would corrupt the
-- residual, so each decomposed row id is recorded exactly once).
CREATE TABLE IF NOT EXISTS _mb_residual_done (id uuid PRIMARY KEY);

-- ── 2. Residual decomposition ───────────────────────────────────

CREATE OR REPLACE PROCEDURE backfill_mb_residual_decompose(tbl regclass, batch_size int DEFAULT 5000)
LANGUAGE plpgsql
AS $$
DECLARE
  updated int;
  total bigint := 0;
BEGIN
  LOOP
    EXECUTE format($sql$
      WITH batch AS (
        SELECT mb.id, mb."entityId", mb."startTime"
        FROM %1$s mb
        WHERE mb."entityType" = 'STATION'
          AND mb.granularity = 'HOUR'
          AND mb."jobId" IS NULL
          AND NOT EXISTS (SELECT 1 FROM _mb_residual_done d WHERE d.id = mb.id)
          AND EXISTS (
            SELECT 1 FROM %1$s j
            WHERE j."entityType" = 'JOB' AND j.granularity = 'HOUR'
              AND j."entityId" = mb."entityId" AND j."startTime" = mb."startTime"
          )
        ORDER BY mb.id
        LIMIT %2$s
      ),
      job_sums AS (
        SELECT b.id,
               COALESCE(SUM(j."totalCycles"), 0)::int AS "totalCycles",
               COALESCE(SUM(j."badCycles"), 0)::int AS "badCycles",
               COALESCE(SUM(j."totalItems"), 0)::int AS "totalItems",
               COALESCE(SUM(j."badItems"), 0)::int AS "badItems",
               COALESCE(SUM(j."runSeconds"), 0)::int AS "runSeconds",
               COALESCE(SUM(j."downSeconds"), 0)::int AS "downSeconds",
               COALESCE(SUM(j."plannedDownSeconds"), 0)::int AS "plannedDownSeconds",
               COALESCE(SUM(j."unplannedDownSeconds"), 0)::int AS "unplannedDownSeconds",
               COALESCE(SUM(j."idealCycleSeconds"), 0)::int AS "idealCycleSeconds",
               COALESCE(SUM(j."totalCycleSeconds"), 0)::int AS "totalCycleSeconds",
               COALESCE(SUM(j."elapsedPlannedProductionSeconds"), 0)::int AS "elapsedPlannedProductionSeconds"
        FROM batch b
        JOIN %1$s j ON j."entityType" = 'JOB' AND j.granularity = 'HOUR'
                   AND j."entityId" = b."entityId" AND j."startTime" = b."startTime"
        GROUP BY b.id
      ),
      upd AS (
        UPDATE %1$s mb SET
          "totalCycles" = GREATEST(0, mb."totalCycles" - js."totalCycles"),
          "badCycles" = GREATEST(0, mb."badCycles" - js."badCycles"),
          "totalItems" = GREATEST(0, mb."totalItems" - js."totalItems"),
          "badItems" = GREATEST(0, mb."badItems" - js."badItems"),
          "runSeconds" = GREATEST(0, mb."runSeconds" - js."runSeconds"),
          "downSeconds" = GREATEST(0, mb."downSeconds" - js."downSeconds"),
          "plannedDownSeconds" = GREATEST(0, mb."plannedDownSeconds" - js."plannedDownSeconds"),
          "unplannedDownSeconds" = GREATEST(0, mb."unplannedDownSeconds" - js."unplannedDownSeconds"),
          "idealCycleSeconds" = GREATEST(0, mb."idealCycleSeconds" - js."idealCycleSeconds"),
          "totalCycleSeconds" = GREATEST(0, mb."totalCycleSeconds" - js."totalCycleSeconds"),
          "elapsedPlannedProductionSeconds" = GREATEST(0, mb."elapsedPlannedProductionSeconds" - js."elapsedPlannedProductionSeconds"),
          "expectedCycles" = 0,
          "expectedItems" = 0,
          "elapsedExpectedCycles" = 0,
          "elapsedExpectedItems" = 0,
          "currentStandardCycle" = NULL,
          "currentJobId" = NULL,
          "currentJobName" = NULL,
          "updatedAt" = NOW()
        FROM job_sums js
        WHERE mb.id = js.id
        RETURNING mb.id
      )
      INSERT INTO _mb_residual_done (id) SELECT id FROM upd
    $sql$, tbl, batch_size);
    GET DIAGNOSTICS updated = ROW_COUNT;

    total := total + updated;
    RAISE NOTICE 'backfill_mb_residual_decompose(%): % decomposed this batch (% total)', tbl, updated, total;
    COMMIT;
    EXIT WHEN updated = 0;
  END LOOP;
END;
$$;

-- ── 3. Family conversion: JOB HOUR → STATION HOUR ───────────────

CREATE OR REPLACE PROCEDURE backfill_mb_family_convert(tbl regclass, batch_size int DEFAULT 10000)
LANGUAGE plpgsql
AS $$
DECLARE
  updated int;
  deleted int;
  total bigint := 0;
BEGIN
  LOOP
    -- Target key already occupied (Stage C writer wrote it post-deploy):
    -- the recomputed new-style row wins — delete the legacy JOB row.
    EXECUTE format($sql$
      WITH batch AS (
        SELECT mb.id FROM %1$s mb
        WHERE mb."entityType" = 'JOB' AND mb.granularity = 'HOUR'
        ORDER BY mb.id
        LIMIT %2$s
      ),
      del AS (
        DELETE FROM %1$s mb
        USING batch b
        WHERE mb.id = b.id
          AND EXISTS (
            SELECT 1 FROM %1$s t
            WHERE t."entityType" = 'STATION'
              AND t."entityId" = mb."entityId"
              AND t."jobId" = mb."jobId"
              AND t.granularity = 'HOUR'
              AND t."startTime" = mb."startTime"
          )
        RETURNING mb.id
      ),
      upd AS (
        UPDATE %1$s mb SET
          "entityType" = 'STATION',
          "updatedAt" = NOW()
        FROM batch b
        WHERE mb.id = b.id
          AND NOT EXISTS (SELECT 1 FROM del d WHERE d.id = mb.id)
        RETURNING mb.id
      )
      SELECT (SELECT COUNT(*) FROM upd)::int AS updated, (SELECT COUNT(*) FROM del)::int AS deleted
    $sql$, tbl, batch_size) INTO updated, deleted;

    total := total + updated + deleted;
    RAISE NOTICE 'backfill_mb_family_convert(%): % converted, % conflict-deleted this batch (% total)',
      tbl, updated, deleted, total;
    COMMIT;
    EXIT WHEN updated + deleted = 0;
  END LOOP;
END;
$$;

-- ── 4. Tier deletion ────────────────────────────────────────────
-- After conversion the only rows that should survive are
-- (STATION, HOUR). Everything else is a derived tier the readers now
-- compute from hour rows: STATION SHIFT/DAY/MINUTE, WORKCENTER/SITE at
-- every granularity, JOB SHIFT/DAY.

CREATE OR REPLACE PROCEDURE backfill_mb_tier_delete(tbl regclass, batch_size int DEFAULT 10000)
LANGUAGE plpgsql
AS $$
DECLARE
  deleted int;
  total bigint := 0;
BEGIN
  LOOP
    EXECUTE format($sql$
      DELETE FROM %1$s mb
      USING (
        SELECT id FROM %1$s
        WHERE NOT ("entityType" = 'STATION' AND granularity = 'HOUR')
        ORDER BY id
        LIMIT %2$s
      ) b
      WHERE mb.id = b.id
    $sql$, tbl, batch_size);
    GET DIAGNOSTICS deleted = ROW_COUNT;

    total := total + deleted;
    RAISE NOTICE 'backfill_mb_tier_delete(%): % deleted this batch (% total)', tbl, deleted, total;
    COMMIT;
    EXIT WHEN deleted = 0;
  END LOOP;
END;
$$;

-- ── 5. closedAt backfill (live table only) ──────────────────────

CREATE OR REPLACE PROCEDURE backfill_mb_closed_at(batch_size int DEFAULT 10000)
LANGUAGE plpgsql
AS $$
DECLARE
  updated int;
  total bigint := 0;
BEGIN
  LOOP
    UPDATE "MetricBucket" mb SET
      "closedAt" = mb."startTime" + mb."durationSeconds" * INTERVAL '1 second'
    FROM (
      SELECT id FROM "MetricBucket"
      WHERE "closedAt" IS NULL
        AND "entityType" = 'STATION' AND granularity = 'HOUR'
        AND "startTime" + "durationSeconds" * INTERVAL '1 second' <= NOW()
      ORDER BY id
      LIMIT batch_size
    ) b
    WHERE mb.id = b.id;
    GET DIAGNOSTICS updated = ROW_COUNT;

    total := total + updated;
    RAISE NOTICE 'backfill_mb_closed_at: % stamped this batch (% total)', updated, total;
    COMMIT;
    EXIT WHEN updated = 0;
  END LOOP;
END;
$$;

-- ── Run ─────────────────────────────────────────────────────────

CALL backfill_mb_residual_decompose('"MetricBucket"');
CALL backfill_mb_residual_decompose('"MetricBucketLog"');
CALL backfill_mb_family_convert('"MetricBucket"');
CALL backfill_mb_family_convert('"MetricBucketLog"');
CALL backfill_mb_tier_delete('"MetricBucket"');
CALL backfill_mb_tier_delete('"MetricBucketLog"');
CALL backfill_mb_closed_at();

DROP PROCEDURE backfill_mb_residual_decompose(regclass, int);
DROP PROCEDURE backfill_mb_family_convert(regclass, int);
DROP PROCEDURE backfill_mb_tier_delete(regclass, int);
DROP PROCEDURE backfill_mb_closed_at(int);

-- ── 6. Assertions ───────────────────────────────────────────────

-- 6a. Conservation: per (station, hour) the post-backfill family SUM
-- (residual + per-job rows) must reproduce the snapshotted whole-station
-- row — counts exactly, durations within ±2s (per-job rows were written
-- by an independent recompute whose second-rounding can differ from the
-- whole-row accumulation; the residual clamp absorbs the rest).
--
-- Violations are REPORTED (not fatal): rows where the family sum exceeds
-- the snapshot mean the legacy per-job rows over-counted relative to the
-- whole-station row (typically hours the Stage C writer recomputed
-- between deploy and backfill — the recomputed values are the more
-- accurate ones). Review each before dropping the _bak tables.
SELECT s.src, s."entityId", s."startTime",
       s."totalCycles"  AS snap_cycles,  f."totalCycles"  AS fam_cycles,
       s."totalItems"   AS snap_items,   f."totalItems"   AS fam_items,
       s."badItems"     AS snap_bad,     f."badItems"     AS fam_bad,
       s."runSeconds"   AS snap_run,     f."runSeconds"   AS fam_run,
       s."downSeconds"  AS snap_down,    f."downSeconds"  AS fam_down
FROM _mb_base_grain_snapshot s
JOIN LATERAL (
  SELECT COALESCE(SUM("totalCycles"), 0)::int AS "totalCycles",
         COALESCE(SUM("totalItems"), 0)::int AS "totalItems",
         COALESCE(SUM("badItems"), 0)::int AS "badItems",
         COALESCE(SUM("runSeconds"), 0)::int AS "runSeconds",
         COALESCE(SUM("downSeconds"), 0)::int AS "downSeconds",
         COALESCE(SUM("plannedDownSeconds"), 0)::int AS "plannedDownSeconds",
         COALESCE(SUM("unplannedDownSeconds"), 0)::int AS "unplannedDownSeconds"
  FROM (
    SELECT "totalCycles", "totalItems", "badItems",
           "runSeconds", "downSeconds", "plannedDownSeconds", "unplannedDownSeconds"
    FROM "MetricBucket"
    WHERE s.src = 'live' AND "entityType" = 'STATION' AND granularity = 'HOUR'
      AND "entityId" = s."entityId" AND "startTime" = s."startTime"
    UNION ALL
    SELECT "totalCycles", "totalItems", "badItems",
           "runSeconds", "downSeconds", "plannedDownSeconds", "unplannedDownSeconds"
    FROM "MetricBucketLog"
    WHERE s.src = 'log' AND "entityType" = 'STATION' AND granularity = 'HOUR'
      AND "entityId" = s."entityId" AND "startTime" = s."startTime"
  ) fam
) f ON TRUE
WHERE f."totalCycles" <> s."totalCycles"
   OR f."totalItems" <> s."totalItems"
   OR f."badItems" <> s."badItems"
   OR ABS(f."runSeconds" - s."runSeconds") > 2
   OR ABS(f."downSeconds" - s."downSeconds") > 2
   OR ABS(f."plannedDownSeconds" - s."plannedDownSeconds") > 2
   OR ABS(f."unplannedDownSeconds" - s."unplannedDownSeconds") > 2
ORDER BY s."entityId", s."startTime";

-- 6b. Structural: nothing but (STATION, HOUR) may remain. Fatal.
DO $$
DECLARE n bigint;
BEGIN
  SELECT COUNT(*) INTO n FROM "MetricBucket"
  WHERE NOT ("entityType" = 'STATION' AND granularity = 'HOUR');
  IF n > 0 THEN RAISE EXCEPTION 'MetricBucket: % non-(STATION,HOUR) rows remain', n; END IF;

  SELECT COUNT(*) INTO n FROM "MetricBucketLog"
  WHERE NOT ("entityType" = 'STATION' AND granularity = 'HOUR');
  IF n > 0 THEN RAISE EXCEPTION 'MetricBucketLog: % non-(STATION,HOUR) rows remain', n; END IF;

  SELECT COUNT(*) INTO n FROM "MetricBucket"
  WHERE "closedAt" IS NULL
    AND "startTime" + "durationSeconds" * INTERVAL '1 second' <= NOW() - INTERVAL '1 hour';
  IF n > 0 THEN RAISE NOTICE 'MetricBucket: % fully-elapsed rows still open (closedAt NULL) — Stage D will close them', n; END IF;

  RAISE NOTICE 'backfill-metricbucket-base-grain: structural assertions passed';
END;
$$;

-- Cleanup (keep _mb_base_grain_snapshot around until the 6a report has
-- been reviewed, then drop both):
DROP TABLE _mb_residual_done;
DROP TABLE _mb_base_grain_snapshot;

-- Verification queries (run after):
--   SELECT COUNT(*) FROM "MetricBucket"    WHERE NOT ("entityType"='STATION' AND granularity='HOUR');  -- expect 0
--   SELECT COUNT(*) FROM "MetricBucketLog" WHERE NOT ("entityType"='STATION' AND granularity='HOUR');  -- expect 0
--   SELECT COUNT(*) FROM "MetricBucket"    WHERE "jobId" IS NULL;  -- residual rows: one per (station, hour)
