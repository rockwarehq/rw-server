-- Backfill: production context stamping (Cycle + ItemDispositionLog +
-- StationStateLog).
--
-- Companion to migrations 20260813120000_production_context_stamping and
-- 20260813130000_downtime_shift_context. Run MANUALLY with psql against
-- the DIRECT (non-pooled) connection, after the migrations have been
-- deployed:
--
--   psql "$DATABASE_URL_MIGRATION" -f packages/db/scripts/backfill-cycle-context.sql
--
-- Batched keyset updates (10k rows/batch) with a COMMIT per batch — no long
-- transaction, safe to interrupt and re-run (idempotent: only rows still
-- missing stamps are touched). Progress is RAISEd per batch.
--
-- Attribution notes:
-- * Shift is resolved at COALESCE("end", start) — the completion time — to
--   match the write-path stamping in cycle.complete(). (The old cycleSearch
--   LATERAL attributed at `start`; completion time is the metrics-pipeline
--   convention and wins.)
-- * Workcenter-scoped ShiftInstance wins over site-level, mirroring
--   getShiftForEntity.
-- * Rows predating shift materialization keep NULL shift and get a
--   site-timezone local calendar date as businessDate.
-- * toolId/toolVersionId are stamped only when the cycle's m2m set contains
--   exactly one tool — the "primary mold is unambiguous" rule from the
--   write path.

CREATE OR REPLACE PROCEDURE backfill_cycle_context(batch_size int DEFAULT 10000)
LANGUAGE plpgsql
AS $$
DECLARE
  updated int;
  total bigint := 0;
BEGIN
  LOOP
    WITH batch AS (
      SELECT c.id, c."stationId", c."siteId", c."jobVersionId",
             COALESCE(c."end", c.start) AS at
      FROM "Cycle" c
      WHERE c."shiftInstanceId" IS NULL AND c."businessDate" IS NULL
      ORDER BY c.id
      LIMIT batch_size
    ),
    resolved AS (
      SELECT b.id,
             s."workcenterId"                                   AS wc_id,
             jv."jobId"                                         AS job_id,
             COALESCE(si_wc.id, si_site.id)                     AS si_id,
             COALESCE(si_wc."businessDate", si_site."businessDate",
                      (b.at AT TIME ZONE site."timezone")::date) AS bd,
             logon.id                                           AS logon_id
      FROM batch b
      JOIN "Station" s   ON s.id = b."stationId"
      JOIN "Site" site   ON site.id = b."siteId"
      JOIN "JobVersion" jv ON jv.id = b."jobVersionId"
      LEFT JOIN LATERAL (
        SELECT si.id, si."businessDate"
        FROM "ShiftInstance" si
        JOIN "ShiftAssignment" sa ON sa.id = si."assignmentId"
        WHERE si."workCenterId" = s."workcenterId"
          AND si."startTime" <= b.at AND si."endTime" > b.at
        ORDER BY sa."rotationStartDate" DESC
        LIMIT 1
      ) si_wc ON TRUE
      LEFT JOIN LATERAL (
        SELECT si.id, si."businessDate"
        FROM "ShiftInstance" si
        JOIN "ShiftAssignment" sa ON sa.id = si."assignmentId"
        WHERE si."siteId" = b."siteId" AND si."workCenterId" IS NULL
          AND si."startTime" <= b.at AND si."endTime" > b.at
        ORDER BY sa."rotationStartDate" DESC
        LIMIT 1
      ) si_site ON TRUE
      LEFT JOIN LATERAL (
        SELECT sl.id
        FROM "StationLogonSession" sl
        WHERE sl."stationId" = b."stationId"
          AND sl."logonTime" <= b.at
          AND (sl."logoffTime" IS NULL OR sl."logoffTime" > b.at)
        ORDER BY sl."logonTime" DESC
        LIMIT 1
      ) logon ON TRUE
    )
    UPDATE "Cycle" c SET
      "workcenterId"    = COALESCE(c."workcenterId", r.wc_id),
      "shiftInstanceId" = r.si_id,
      "businessDate"    = r.bd,
      "jobId"           = COALESCE(c."jobId", r.job_id),
      "logonSessionId"  = COALESCE(c."logonSessionId", r.logon_id)
    FROM resolved r
    WHERE c.id = r.id;

    GET DIAGNOSTICS updated = ROW_COUNT;
    total := total + updated;
    RAISE NOTICE 'backfill_cycle_context: % rows this batch, % total', updated, total;
    COMMIT;
    EXIT WHEN updated = 0;
  END LOOP;
END;
$$;

-- Primary mold: only cycles whose m2m tool set is exactly one tool.
CREATE OR REPLACE PROCEDURE backfill_cycle_primary_tool(batch_size int DEFAULT 10000)
LANGUAGE plpgsql
AS $$
DECLARE
  updated int;
  total bigint := 0;
BEGIN
  LOOP
    WITH batch AS (
      SELECT c.id
      FROM "Cycle" c
      WHERE c."toolVersionId" IS NULL
        AND EXISTS (SELECT 1 FROM "_CycleToToolVersion" m WHERE m."A" = c.id)
      ORDER BY c.id
      LIMIT batch_size
    ),
    one_tool AS (
      SELECT m."A" AS cycle_id,
             MIN(tv.id::text)::uuid       AS tv_id,
             MIN(tv."toolId"::text)::uuid AS tool_id
      FROM "_CycleToToolVersion" m
      JOIN "ToolVersion" tv ON tv.id = m."B"
      WHERE m."A" IN (SELECT id FROM batch)
      GROUP BY m."A"
      HAVING COUNT(DISTINCT tv."toolId") = 1 AND COUNT(*) = 1
    )
    UPDATE "Cycle" c SET
      "toolId"        = o.tool_id,
      "toolVersionId" = o.tv_id
    FROM one_tool o
    WHERE c.id = o.cycle_id;

    GET DIAGNOSTICS updated = ROW_COUNT;
    total := total + updated;
    RAISE NOTICE 'backfill_cycle_primary_tool: % rows this batch, % total', updated, total;
    COMMIT;
    -- Multi-tool cycles never match one_tool, so keying the loop off
    -- updated=0 alone would stop early only when a whole batch is
    -- multi-tool; acceptable — re-run reports 0 and exits.
    EXIT WHEN updated = 0;
  END LOOP;
END;
$$;

CREATE OR REPLACE PROCEDURE backfill_disposition_context(batch_size int DEFAULT 10000)
LANGUAGE plpgsql
AS $$
DECLARE
  updated int;
  total bigint := 0;
BEGIN
  LOOP
    WITH batch AS (
      SELECT d.id, d."createdAt", d."shiftInstanceId", d."siteId"
      FROM "ItemDispositionLog" d
      WHERE d."occurredAt" IS NULL
      ORDER BY d.id
      LIMIT batch_size
    ),
    resolved AS (
      SELECT b.id,
             b."createdAt" AS occurred,
             COALESCE(si."businessDate",
                      (b."createdAt" AT TIME ZONE site."timezone")::date) AS bd
      FROM batch b
      JOIN "Site" site ON site.id = b."siteId"
      LEFT JOIN "ShiftInstance" si ON si.id = b."shiftInstanceId"
    )
    UPDATE "ItemDispositionLog" d SET
      "occurredAt"   = r.occurred,
      "businessDate" = COALESCE(d."businessDate", r.bd)
    FROM resolved r
    WHERE d.id = r.id;

    GET DIAGNOSTICS updated = ROW_COUNT;
    total := total + updated;
    RAISE NOTICE 'backfill_disposition_context: % rows this batch, % total', updated, total;
    COMMIT;
    EXIT WHEN updated = 0;
  END LOOP;
END;
$$;

-- Downtime/uptime intervals (StationStateLog), companion to migration
-- 20260813130000_downtime_shift_context. CLOSED rows only (endTime NOT
-- NULL): open rows are the live state machinery's to stamp/split at the
-- next shift boundary. Shift is resolved at startTime (rows created after
-- the migration are split at shift boundaries at write time, so startTime
-- and endTime lie in the same shift); legacy rows that span a boundary are
-- stamped with the shift covering startTime and left UNSPLIT — approximate
-- by design, the readers' clamp fallback handles them. businessDate falls
-- back to the site-timezone local date so re-runs make progress on rows
-- with no shift coverage.
CREATE OR REPLACE PROCEDURE backfill_downtime_context(batch_size int DEFAULT 10000)
LANGUAGE plpgsql
AS $$
DECLARE
  updated int;
  total bigint := 0;
BEGIN
  LOOP
    WITH batch AS (
      SELECT l.id, l."stationId", l."startTime" AS at
      FROM "StationStateLog" l
      WHERE l."endTime" IS NOT NULL AND l."businessDate" IS NULL
      ORDER BY l.id
      LIMIT batch_size
    ),
    resolved AS (
      SELECT b.id,
             s."workcenterId"               AS wc_id,
             COALESCE(si_wc.id, si_site.id) AS si_id,
             COALESCE(si_wc."businessDate", si_site."businessDate",
                      (b.at AT TIME ZONE site."timezone")::date) AS bd
      FROM batch b
      JOIN "Station" s ON s.id = b."stationId"
      JOIN "Site" site ON site.id = s."siteId"
      LEFT JOIN LATERAL (
        SELECT si.id, si."businessDate"
        FROM "ShiftInstance" si
        JOIN "ShiftAssignment" sa ON sa.id = si."assignmentId"
        WHERE si."workCenterId" = s."workcenterId"
          AND si."startTime" <= b.at AND si."endTime" > b.at
        ORDER BY sa."rotationStartDate" DESC
        LIMIT 1
      ) si_wc ON TRUE
      LEFT JOIN LATERAL (
        SELECT si.id, si."businessDate"
        FROM "ShiftInstance" si
        JOIN "ShiftAssignment" sa ON sa.id = si."assignmentId"
        WHERE si."siteId" = s."siteId" AND si."workCenterId" IS NULL
          AND si."startTime" <= b.at AND si."endTime" > b.at
        ORDER BY sa."rotationStartDate" DESC
        LIMIT 1
      ) si_site ON TRUE
    )
    UPDATE "StationStateLog" l SET
      "workcenterId"    = COALESCE(l."workcenterId", r.wc_id),
      "shiftInstanceId" = r.si_id,
      "businessDate"    = r.bd
    FROM resolved r
    WHERE l.id = r.id;

    GET DIAGNOSTICS updated = ROW_COUNT;
    total := total + updated;
    RAISE NOTICE 'backfill_downtime_context: % rows this batch, % total', updated, total;
    COMMIT;
    EXIT WHEN updated = 0;
  END LOOP;
END;
$$;

CALL backfill_cycle_context();
CALL backfill_cycle_primary_tool();
CALL backfill_disposition_context();
CALL backfill_downtime_context();

DROP PROCEDURE backfill_cycle_context(int);
DROP PROCEDURE backfill_cycle_primary_tool(int);
DROP PROCEDURE backfill_disposition_context(int);
DROP PROCEDURE backfill_downtime_context(int);

-- Verification queries (run after):
--   SELECT COUNT(*) FROM "Cycle" WHERE "businessDate" IS NULL;         -- expect 0
--   SELECT COUNT(*) FROM "Cycle" WHERE "shiftInstanceId" IS NULL;      -- rows predating shift schedules only
--   SELECT COUNT(*) FROM "ItemDispositionLog" WHERE "occurredAt" IS NULL;  -- expect 0
--   SELECT COUNT(*) FROM "StationStateLog" WHERE "endTime" IS NOT NULL AND "businessDate" IS NULL;  -- expect 0
