-- Backfill: material fact context stamping (MaterialShiftUsage +
-- MaterialLedgerEntry).
--
-- Companion to migration 20260814110000_material_usage_versions. Run
-- MANUALLY with psql against the DIRECT (non-pooled) connection, after the
-- migration has been deployed:
--
--   psql "$DATABASE_URL_MIGRATION" -f packages/db/scripts/backfill-material-context.sql
--
-- Batched keyset updates (10k rows/batch) with a COMMIT per batch — no long
-- transaction, safe to interrupt and re-run (idempotent: only rows still
-- missing stamps are touched). Progress is RAISEd per batch.
--
-- ============================================================================
-- IMPORTANT: version snapshots are NOT backfilled.
-- ============================================================================
-- MaterialShiftUsage.productVersionId / .materialVersionId and
-- MaterialLedgerEntry.materialVersionId are deliberately left NULL on legacy
-- rows. These columns mean "the version in effect when the row was written";
-- the only value available today is the CURRENT version, and stamping that
-- onto historical rows would falsify history (a re-versioned material would
-- look like it was consumed/validated under today's definition). NULL is the
-- honest answer: readers must treat NULL snapshots as "unknown at write
-- time" and fall back to the parent's current version explicitly.
--
-- What IS backfilled:
-- * MSU.businessDate     — from ShiftInstance.businessDate (shiftInstanceId
--                          is required on MSU, so this always resolves).
-- * MSU.workcenterId     — from the station's current workcenter.
-- * MSU.jobVersionId     — best-effort: the StationJobLog row for
--                          (stationId, jobId) overlapping the shift window,
--                          latest startTime wins; NULL when none. The job log
--                          snapshot IS point-in-time data, so this does not
--                          falsify history.
-- * Ledger.businessDate  — PRODUCTION rows: MIN(businessDate) over the
--                          staging rows that flushed into the entry (via the
--                          flushedLedgerEntryId back-reference; MIN because a
--                          ledger entry belongs to exactly one flush of one
--                          shift, so all linked rows agree — MIN is a
--                          deterministic pick if data is ever dirty). All
--                          other rows: site-timezone local calendar date of
--                          createdAt.

CREATE OR REPLACE PROCEDURE backfill_material_shift_usage_context(batch_size int DEFAULT 10000)
LANGUAGE plpgsql
AS $$
DECLARE
  updated int;
  total bigint := 0;
BEGIN
  LOOP
    WITH batch AS (
      SELECT msu.id, msu."stationId", msu."jobId", msu."shiftInstanceId"
      FROM "MaterialShiftUsage" msu
      WHERE msu."businessDate" IS NULL
      ORDER BY msu.id
      LIMIT batch_size
    ),
    resolved AS (
      SELECT b.id,
             si."businessDate" AS bd,
             s."workcenterId"  AS wc_id,
             sjl."jobVersionId" AS jv_id
      FROM batch b
      JOIN "ShiftInstance" si ON si.id = b."shiftInstanceId"
      JOIN "Station" s ON s.id = b."stationId"
      LEFT JOIN LATERAL (
        SELECT l."jobVersionId"
        FROM "StationJobLog" l
        WHERE l."stationId" = b."stationId"
          AND l."jobId" = b."jobId"
          AND l."startTime" < si."endTime"
          AND (l."endTime" IS NULL OR l."endTime" > si."startTime")
        ORDER BY l."startTime" DESC
        LIMIT 1
      ) sjl ON TRUE
    )
    UPDATE "MaterialShiftUsage" msu SET
      "businessDate" = r.bd,
      "workcenterId" = COALESCE(msu."workcenterId", r.wc_id),
      "jobVersionId" = COALESCE(msu."jobVersionId", r.jv_id)
      -- productVersionId / materialVersionId intentionally untouched — see
      -- header: backfilling with current versions would falsify history.
    FROM resolved r
    WHERE msu.id = r.id;

    GET DIAGNOSTICS updated = ROW_COUNT;
    total := total + updated;
    RAISE NOTICE 'backfill_material_shift_usage_context: % rows this batch, % total', updated, total;
    COMMIT;
    EXIT WHEN updated = 0;
  END LOOP;
END;
$$;

CREATE OR REPLACE PROCEDURE backfill_material_ledger_context(batch_size int DEFAULT 10000)
LANGUAGE plpgsql
AS $$
DECLARE
  updated int;
  total bigint := 0;
BEGIN
  LOOP
    WITH batch AS (
      SELECT le.id, le."siteId", le."createdAt", le.kind
      FROM "MaterialLedgerEntry" le
      WHERE le."businessDate" IS NULL
      ORDER BY le.id
      LIMIT batch_size
    ),
    resolved AS (
      SELECT b.id,
             -- PRODUCTION rows: prefer the flushed shift's businessDate via
             -- the staging back-reference (MIN — see header). Everything
             -- else (and PRODUCTION rows with no surviving staging rows):
             -- site-timezone local calendar date of createdAt.
             COALESCE(prod.bd, (b."createdAt" AT TIME ZONE site.timezone)::date) AS bd
      FROM batch b
      JOIN "Site" site ON site.id = b."siteId"
      LEFT JOIN LATERAL (
        SELECT MIN(si."businessDate") AS bd
        FROM "MaterialShiftUsage" msu
        JOIN "ShiftInstance" si ON si.id = msu."shiftInstanceId"
        WHERE msu."flushedLedgerEntryId" = b.id
      ) prod ON b.kind = 'PRODUCTION'
    )
    UPDATE "MaterialLedgerEntry" le SET
      "businessDate" = r.bd
      -- materialVersionId intentionally untouched — see header.
    FROM resolved r
    WHERE le.id = r.id;

    GET DIAGNOSTICS updated = ROW_COUNT;
    total := total + updated;
    RAISE NOTICE 'backfill_material_ledger_context: % rows this batch, % total', updated, total;
    COMMIT;
    EXIT WHEN updated = 0;
  END LOOP;
END;
$$;

CALL backfill_material_shift_usage_context();
CALL backfill_material_ledger_context();

DROP PROCEDURE backfill_material_shift_usage_context(int);
DROP PROCEDURE backfill_material_ledger_context(int);

-- Verification queries (run after):
--   SELECT COUNT(*) FROM "MaterialShiftUsage" WHERE "businessDate" IS NULL;   -- expect 0
--   SELECT COUNT(*) FROM "MaterialShiftUsage" WHERE "workcenterId" IS NULL;   -- stations with no workcenter only
--   SELECT COUNT(*) FROM "MaterialShiftUsage" WHERE "jobVersionId" IS NULL;   -- rows with no overlapping StationJobLog only
--   SELECT COUNT(*) FROM "MaterialLedgerEntry" WHERE "businessDate" IS NULL;  -- expect 0
--   -- Legacy snapshots stay NULL by design:
--   --   MSU.productVersionId / MSU.materialVersionId / Ledger.materialVersionId
--   -- Sanity: flushed staging rows agree with their ledger entry's businessDate
--   SELECT COUNT(*)
--   FROM "MaterialShiftUsage" msu
--   JOIN "MaterialLedgerEntry" le ON le.id = msu."flushedLedgerEntryId"
--   WHERE msu."businessDate" IS DISTINCT FROM le."businessDate";              -- expect 0
