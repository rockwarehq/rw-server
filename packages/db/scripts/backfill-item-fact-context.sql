-- Backfill: item-fact parents + conformed context (InventoryItem +
-- ItemDispositionLog parent columns).
--
-- Companion to migration 20260814090000_item_fact_parent_context. Run
-- MANUALLY with psql against the DIRECT (non-pooled) connection, after the
-- migration has been deployed:
--
--   psql "$DATABASE_URL_MIGRATION" -f packages/db/scripts/backfill-item-fact-context.sql
--
-- PRECONDITION: backfill-cycle-context.sql has already run. InventoryItem
-- context is copied from the parent Cycle's STAMPED columns — one source of
-- truth, no second shift-overlap derivation here.
--
-- Batched keyset updates (10k rows/batch), COMMIT per batch, idempotent
-- (only rows still missing stamps are touched), RAISE progress per batch.

CREATE OR REPLACE PROCEDURE backfill_inventory_item_context(batch_size int DEFAULT 10000)
LANGUAGE plpgsql
AS $$
DECLARE
  updated int;
  total bigint := 0;
BEGIN
  LOOP
    WITH batch AS (
      SELECT ii.id, ii."cycleId", ii."productVersionId", ii."toolVersionId",
             ii."toolCavityVersionId", ii."jobProductVersionId"
      FROM "InventoryItem" ii
      WHERE ii."productId" IS NULL
      ORDER BY ii.id
      LIMIT batch_size
    ),
    resolved AS (
      SELECT b.id,
             c."siteId", c."stationId", c."workcenterId", c."shiftInstanceId",
             c."businessDate", c."jobId", c."jobVersionId", c."logonSessionId",
             COALESCE(c."end", c.start) AS produced_at,
             pv."productId"             AS product_id,
             tv."toolId"                AS tool_id,
             tcv."toolCavityId"         AS tool_cavity_id,
             jpv."jobProductId"         AS job_product_id
      FROM batch b
      JOIN "Cycle" c ON c.id = b."cycleId"
      JOIN "ProductVersion" pv ON pv.id = b."productVersionId"
      LEFT JOIN "ToolVersion" tv ON tv.id = b."toolVersionId"
      LEFT JOIN "ToolCavityVersion" tcv ON tcv.id = b."toolCavityVersionId"
      LEFT JOIN "JobProductVersion" jpv ON jpv.id = b."jobProductVersionId"
    )
    UPDATE "InventoryItem" ii SET
      "siteId"          = r."siteId",
      "stationId"       = r."stationId",
      "workcenterId"    = r."workcenterId",
      "shiftInstanceId" = r."shiftInstanceId",
      "businessDate"    = r."businessDate",
      "jobId"           = r."jobId",
      "jobVersionId"    = r."jobVersionId",
      "logonSessionId"  = r."logonSessionId",
      "producedAt"      = r.produced_at,
      "productId"       = r.product_id,
      "toolId"          = r.tool_id,
      "toolCavityId"    = r.tool_cavity_id,
      "jobProductId"    = r.job_product_id
    FROM resolved r
    WHERE ii.id = r.id;

    GET DIAGNOSTICS updated = ROW_COUNT;
    total := total + updated;
    RAISE NOTICE 'backfill_inventory_item_context: % rows this batch, % total', updated, total;
    COMMIT;
    EXIT WHEN updated = 0;
  END LOOP;
END;
$$;

-- Dimension parents + job/operator for scrap rows. jobId cascade mirrors the
-- write path: cycle's stamped jobId first, else via jobProductVersion.
CREATE OR REPLACE PROCEDURE backfill_disposition_parents(batch_size int DEFAULT 10000)
LANGUAGE plpgsql
AS $$
DECLARE
  updated int;
  total bigint := 0;
BEGIN
  LOOP
    WITH batch AS (
      SELECT d.id, d."stationId", d."cycleId", d."productVersionId", d."toolVersionId",
             d."toolCavityVersionId", d."jobProductVersionId",
             COALESCE(d."occurredAt", d."createdAt") AS at
      FROM "ItemDispositionLog" d
      WHERE d."productId" IS NULL
      ORDER BY d.id
      LIMIT batch_size
    ),
    resolved AS (
      SELECT b.id,
             pv."productId"                          AS product_id,
             tv."toolId"                             AS tool_id,
             tcv."toolCavityId"                      AS tool_cavity_id,
             jpv."jobProductId"                      AS job_product_id,
             COALESCE(c."jobId", jp."jobId")         AS job_id,
             logon.id                                AS logon_id
      FROM batch b
      JOIN "ProductVersion" pv ON pv.id = b."productVersionId"
      LEFT JOIN "ToolVersion" tv ON tv.id = b."toolVersionId"
      LEFT JOIN "ToolCavityVersion" tcv ON tcv.id = b."toolCavityVersionId"
      LEFT JOIN "JobProductVersion" jpv ON jpv.id = b."jobProductVersionId"
      LEFT JOIN "JobProduct" jp ON jp.id = jpv."jobProductId"
      LEFT JOIN "Cycle" c ON c.id = b."cycleId"
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
    UPDATE "ItemDispositionLog" d SET
      "productId"      = r.product_id,
      "toolId"         = r.tool_id,
      "toolCavityId"   = r.tool_cavity_id,
      "jobProductId"   = r.job_product_id,
      "jobId"          = COALESCE(d."jobId", r.job_id),
      "logonSessionId" = COALESCE(d."logonSessionId", r.logon_id)
    FROM resolved r
    WHERE d.id = r.id;

    GET DIAGNOSTICS updated = ROW_COUNT;
    total := total + updated;
    RAISE NOTICE 'backfill_disposition_parents: % rows this batch, % total', updated, total;
    COMMIT;
    EXIT WHEN updated = 0;
  END LOOP;
END;
$$;

CALL backfill_inventory_item_context();
CALL backfill_disposition_parents();

DROP PROCEDURE backfill_inventory_item_context(int);
DROP PROCEDURE backfill_disposition_parents(int);

-- Verification queries (run after):
--   SELECT COUNT(*) FROM "InventoryItem" WHERE "productId" IS NULL;        -- expect 0
--   SELECT COUNT(*) FROM "InventoryItem" WHERE "producedAt" IS NULL;       -- expect 0
--   SELECT COUNT(*) FROM "ItemDispositionLog" WHERE "productId" IS NULL;   -- expect 0
