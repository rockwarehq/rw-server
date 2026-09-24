-- The stock book (ADR-0016). Part stock stops being four counters on
-- ProductStock and becomes a book of movements (StockMovement), one row for
-- every made part, scrap entry, completed order and count, plus saved totals
-- (StockBalance). Every product and material gets a StockItem, the record the
-- book is kept against.
--
-- The book is filled from the records that exist today, using the same rules
-- as the old rebuild (rederiveProductStock), so the new totals match what a
-- rebuild would have given. Records that were deleted get no movement: their
-- effect was already undone.
--
-- ProductStock is NOT dropped here. Servers still running the old code keep
-- writing to it while the deploy rolls out. The new workers post anything
-- those servers saved by themselves (catchUpAfterStockMigration, every few
-- minutes for a day). A later migration drops the table.
--
-- The whole migration runs as one transaction: if any check below stops it,
-- nothing is left half made. Run packages/db/scripts/preflight-stock-ledger.sql
-- on a copy of production first to see what it will find.

BEGIN;

-- ── 1. Check first: every record's site must match its product's site ────
-- A StockItem belongs to one site (its product's). If a part was ever made,
-- scrapped or counted at another site, stop and look before going further.

DO $$
DECLARE
  bad bigint;
BEGIN
  SELECT COUNT(*) INTO bad
  FROM "InventoryItem" ii
  JOIN "Cycle" cy ON cy.id = ii."cycleId"
  JOIN "ProductVersion" pv ON pv.id = ii."productVersionId"
  JOIN "Product" p ON p.id = pv."productId"
  WHERE ii."deletedAt" IS NULL AND COALESCE(ii."siteId", cy."siteId") <> p."siteId";
  IF bad > 0 THEN
    RAISE EXCEPTION 'stock_ledger: % made-part rows sit at a different site than their product', bad;
  END IF;

  SELECT COUNT(*) INTO bad
  FROM "ItemDispositionLog" idl
  JOIN "ProductVersion" pv ON pv.id = idl."productVersionId"
  JOIN "Product" p ON p.id = pv."productId"
  WHERE idl."deletedAt" IS NULL AND idl."siteId" <> p."siteId";
  IF bad > 0 THEN
    RAISE EXCEPTION 'stock_ledger: % scrap rows sit at a different site than their product', bad;
  END IF;

  SELECT COUNT(*) INTO bad
  FROM "OrderConsumption" oc JOIN "Product" p ON p.id = oc."productId"
  WHERE oc."siteId" <> p."siteId";
  IF bad > 0 THEN
    RAISE EXCEPTION 'stock_ledger: % order consumption rows sit at a different site than their product', bad;
  END IF;

  SELECT COUNT(*) INTO bad
  FROM "ProductStockAdjustment" sa JOIN "Product" p ON p.id = sa."productId"
  WHERE sa."siteId" <> p."siteId";
  IF bad > 0 THEN
    RAISE EXCEPTION 'stock_ledger: % stock adjustment rows sit at a different site than their product', bad;
  END IF;
END $$;

-- ── 2. Types and tables ──────────────────────────────────────────────────

CREATE TYPE "StockableType" AS ENUM ('PRODUCT', 'MATERIAL');

CREATE TYPE "TrackingMode" AS ENUM ('NONE', 'BATCH', 'SERIAL');

CREATE TYPE "StockMovementKind" AS ENUM ('OUTPUT', 'SCRAP', 'FULFILLMENT', 'ADJUSTMENT', 'RECEIPT', 'USAGE', 'WRITE_OFF', 'TRANSFER_IN', 'TRANSFER_OUT', 'OPENING_BALANCE');

CREATE TYPE "StockSourceType" AS ENUM ('INVENTORY_ITEM', 'ITEM_DISPOSITION_LOG', 'ORDER_CONSUMPTION', 'PRODUCT_STOCK_ADJUSTMENT', 'MATERIAL_LEDGER_ENTRY', 'MATERIAL_SHIFT_USAGE');

CREATE TABLE "StockItem" (
    "id" UUID NOT NULL,
    "stockableType" "StockableType" NOT NULL,
    "stockableId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "baseUnit" TEXT NOT NULL DEFAULT '',
    "trackingMode" "TrackingMode" NOT NULL DEFAULT 'NONE',
    "reorderPoint" DECIMAL(18,4),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "StockItem_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "StockMovement" (
    "id" UUID NOT NULL,
    "seq" BIGSERIAL NOT NULL,
    "stockItemId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "kind" "StockMovementKind" NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "unit" TEXT NOT NULL DEFAULT '',
    "sourceType" "StockSourceType" NOT NULL,
    "sourceId" UUID NOT NULL,
    "idempotencyKey" TEXT,
    "reversesMovementId" UUID,
    "lotId" UUID,
    "stationId" UUID,
    "shiftInstanceId" UUID,
    "isScheduled" BOOLEAN NOT NULL DEFAULT true,
    "businessDate" DATE,
    "performedByUserId" UUID,
    "note" TEXT,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockMovement_pkey" PRIMARY KEY ("id"),
    -- A movement always moves something.
    CONSTRAINT "StockMovement_quantity_not_zero" CHECK ("quantity" <> 0)
);

CREATE TABLE "StockBalance" (
    "stockItemId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "onHand" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "produced" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "scrapped" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "consumed" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "adjusted" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "StockBalance_pkey" PRIMARY KEY ("stockItemId"),
    -- The parts always add up to the total.
    CONSTRAINT "StockBalance_parts_add_up" CHECK ("onHand" = "produced" - "scrapped" - "consumed" + "adjusted")
);

-- ── 3. A StockItem for every product and material ───────────────────────
-- Deleted and archived ones too, so old movements still have somewhere to
-- point. Materials count in their current version's weight unit.

INSERT INTO "StockItem" ("id", "stockableType", "stockableId", "siteId", "updatedAt")
SELECT gen_random_uuid(), 'PRODUCT', p.id, p."siteId", NOW()
FROM "Product" p;

INSERT INTO "StockItem" ("id", "stockableType", "stockableId", "siteId", "baseUnit", "updatedAt")
SELECT gen_random_uuid(), 'MATERIAL', m.id, m."siteId", COALESCE(mv."weightUnits"::text, ''), NOW()
FROM "Material" m
LEFT JOIN "MaterialVersion" mv ON mv.id = m."currentVersionId";

CREATE UNIQUE INDEX "StockItem_stockableType_stockableId_key" ON "StockItem"("stockableType", "stockableId");
CREATE INDEX "StockItem_siteId_stockableType_idx" ON "StockItem"("siteId", "stockableType");

-- ── 4. Fill the book from today's records ────────────────────────────────
-- Same rows the live code posts (packages/services/src/stock/sources.ts).
-- Each movement takes its time and shift labels from its record.

-- One insert, oldest first, so the book's row order (seq) follows time.
INSERT INTO "StockMovement" ("id", "stockItemId", "siteId", "kind", "quantity", "unit", "sourceType", "sourceId",
  "idempotencyKey", "stationId", "shiftInstanceId", "isScheduled", "businessDate", "performedByUserId",
  "occurredAt", "createdAt")
SELECT gen_random_uuid(), f.*, NOW()
FROM (
  -- Made parts (+)
  SELECT si.id AS "stockItemId", COALESCE(ii."siteId", cy."siteId") AS "siteId", 'OUTPUT'::"StockMovementKind" AS kind,
    ii.quantity, ii."quantityUnit" AS unit, 'INVENTORY_ITEM'::"StockSourceType" AS "sourceType", ii.id AS "sourceId",
    'INVENTORY_ITEM:' || ii.id AS "idempotencyKey", COALESCE(ii."stationId", cy."stationId") AS "stationId",
    ii."shiftInstanceId", ii."isScheduled", ii."businessDate", NULL::uuid AS "performedByUserId",
    ii."createdAt" AS "occurredAt"
  FROM "InventoryItem" ii
  JOIN "Cycle" cy ON cy.id = ii."cycleId"
  JOIN "ProductVersion" pv ON pv.id = ii."productVersionId"
  JOIN "StockItem" si ON si."stockableType" = 'PRODUCT' AND si."stockableId" = pv."productId"
  WHERE ii."deletedAt" IS NULL AND ii.quantity <> 0

  UNION ALL
  -- Scrap (−)
  SELECT si.id, idl."siteId", 'SCRAP', -idl.quantity, si."baseUnit", 'ITEM_DISPOSITION_LOG', idl.id,
    'ITEM_DISPOSITION_LOG:' || idl.id, idl."stationId",
    idl."shiftInstanceId", idl."isScheduled", idl."businessDate", NULL::uuid, idl."createdAt"
  FROM "ItemDispositionLog" idl
  JOIN "ProductVersion" pv ON pv.id = idl."productVersionId"
  JOIN "StockItem" si ON si."stockableType" = 'PRODUCT' AND si."stockableId" = pv."productId"
  WHERE idl."deletedAt" IS NULL AND idl.quantity <> 0

  UNION ALL
  -- Completed orders (−). createdByUserId has no link to User; keep it only
  -- when the user still exists.
  SELECT si.id, oc."siteId", 'FULFILLMENT', -oc.quantity, si."baseUnit", 'ORDER_CONSUMPTION', oc.id,
    'ORDER_CONSUMPTION:' || oc.id, NULL::uuid,
    oc."shiftInstanceId", oc."isScheduled", oc."businessDate", u.id, oc."createdAt"
  FROM "OrderConsumption" oc
  JOIN "StockItem" si ON si."stockableType" = 'PRODUCT' AND si."stockableId" = oc."productId"
  LEFT JOIN "User" u ON u.id = oc."createdByUserId"
  WHERE oc.quantity <> 0

  UNION ALL
  -- Hand corrections and counts (±). A count that matched adds nothing.
  SELECT si.id, sa."siteId", 'ADJUSTMENT', sa.delta, si."baseUnit", 'PRODUCT_STOCK_ADJUSTMENT', sa.id,
    'PRODUCT_STOCK_ADJUSTMENT:' || sa.id, NULL::uuid,
    sa."shiftInstanceId", sa."isScheduled", sa."businessDate", sa."performedByUserId", sa."createdAt"
  FROM "ProductStockAdjustment" sa
  JOIN "StockItem" si ON si."stockableType" = 'PRODUCT' AND si."stockableId" = sa."productId"
  WHERE sa.delta <> 0
) f
ORDER BY f."occurredAt", f."sourceId";

-- Indexes after the fill, so the big inserts run faster.
CREATE UNIQUE INDEX "StockMovement_seq_key" ON "StockMovement"("seq");
CREATE UNIQUE INDEX "StockMovement_idempotencyKey_key" ON "StockMovement"("idempotencyKey");
CREATE UNIQUE INDEX "StockMovement_reversesMovementId_key" ON "StockMovement"("reversesMovementId");
CREATE INDEX "StockMovement_stockItemId_occurredAt_idx" ON "StockMovement"("stockItemId", "occurredAt");
CREATE INDEX "StockMovement_sourceType_sourceId_idx" ON "StockMovement"("sourceType", "sourceId");
CREATE INDEX "StockMovement_siteId_occurredAt_idx" ON "StockMovement"("siteId", "occurredAt");
CREATE INDEX "StockMovement_siteId_businessDate_idx" ON "StockMovement"("siteId", "businessDate");
CREATE INDEX "StockMovement_shiftInstanceId_idx" ON "StockMovement"("shiftInstanceId");
CREATE INDEX "StockMovement_stationId_idx" ON "StockMovement"("stationId");

-- ── 5. Totals for every product ──────────────────────────────────────────
-- Material totals start in ADR-0016 phase 2; materials get no balance row yet.

INSERT INTO "StockBalance" ("stockItemId", "siteId", "onHand", "produced", "scrapped", "consumed", "adjusted", "updatedAt")
SELECT si.id, si."siteId",
  COALESCE(SUM(m.quantity), 0),
  COALESCE(SUM(m.quantity) FILTER (WHERE m.kind = 'OUTPUT'), 0),
  COALESCE(-SUM(m.quantity) FILTER (WHERE m.kind = 'SCRAP'), 0),
  COALESCE(-SUM(m.quantity) FILTER (WHERE m.kind = 'FULFILLMENT'), 0),
  COALESCE(SUM(m.quantity) FILTER (WHERE m.kind = 'ADJUSTMENT'), 0),
  NOW()
FROM "StockItem" si
LEFT JOIN "StockMovement" m ON m."stockItemId" = si.id
WHERE si."stockableType" = 'PRODUCT'
GROUP BY si.id, si."siteId";

CREATE INDEX "StockBalance_siteId_idx" ON "StockBalance"("siteId");

-- ── 6. Compare with the old counters ─────────────────────────────────────
-- The new totals come straight from the records. If the old counters had
-- drifted from those records, the records win; each difference is printed so
-- it can be looked at.

DO $$
DECLARE
  r record;
  n integer := 0;
BEGIN
  FOR r IN
    SELECT ps."siteId", ps."productId",
           ps.produced AS old_produced, b.produced AS new_produced,
           ps.scrapped AS old_scrapped, b.scrapped AS new_scrapped,
           ps.consumed AS old_consumed, b.consumed AS new_consumed,
           ps.adjustment AS old_adjusted, b.adjusted AS new_adjusted
    FROM "ProductStock" ps
    LEFT JOIN "StockItem" si ON si."stockableType" = 'PRODUCT' AND si."stockableId" = ps."productId"
    LEFT JOIN "StockBalance" b ON b."stockItemId" = si.id
    WHERE b."stockItemId" IS NULL
       OR ps.produced <> b.produced OR ps.scrapped <> b.scrapped
       OR ps.consumed <> b.consumed OR ps.adjustment <> b.adjusted
  LOOP
    n := n + 1;
    IF n <= 50 THEN
      RAISE NOTICE 'stock_ledger: product % at site %: produced %→%, scrapped %→%, consumed %→%, adjusted %→%',
        r."productId", r."siteId", r.old_produced, r.new_produced, r.old_scrapped, r.new_scrapped,
        r.old_consumed, r.new_consumed, r.old_adjusted, r.new_adjusted;
    END IF;
  END LOOP;
  RAISE NOTICE 'stock_ledger: % product(s) differ from the old counters', n;

  -- The totals must equal the book, or something above is wrong.
  SELECT COUNT(*) INTO n
  FROM "StockBalance" b
  WHERE b."onHand" <> (SELECT COALESCE(SUM(m.quantity), 0) FROM "StockMovement" m WHERE m."stockItemId" = b."stockItemId");
  IF n > 0 THEN
    RAISE EXCEPTION 'stock_ledger: % balance(s) do not match their movements', n;
  END IF;
END $$;

-- ── 7. Links ─────────────────────────────────────────────────────────────

ALTER TABLE "StockItem" ADD CONSTRAINT "StockItem_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StockBalance" ADD CONSTRAINT "StockBalance_stockItemId_fkey" FOREIGN KEY ("stockItemId") REFERENCES "StockItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_stockItemId_fkey" FOREIGN KEY ("stockItemId") REFERENCES "StockItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_reversesMovementId_fkey" FOREIGN KEY ("reversesMovementId") REFERENCES "StockMovement"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "Station"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_shiftInstanceId_fkey" FOREIGN KEY ("shiftInstanceId") REFERENCES "ShiftInstance"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_performedByUserId_fkey" FOREIGN KEY ("performedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

COMMIT;
