-- Materials join the stock book (ADR-0016 phase 2). Every MaterialLedgerEntry
-- (receipts, write-offs, transfers, counts, and the end-of-shift PRODUCTION
-- rows) gets a StockMovement, and each material gets a StockBalance. The
-- ledger rows stay: they are the records behind the movements, the way made
-- parts are for part stock. MaterialShiftUsage stays outside the book as
-- "used so far this shift".
--
-- Units. A material's stock unit is its weightUnits (a weight), or nothing,
-- which means "not tracked": stock actions are refused for it. Movements keep
-- the unit they were written in; totals are kept in the StockItem's baseUnit,
-- converted by the new stock_convert function.
--
-- Materials with no unit get one from their history where possible (the unit
-- most used in their ledger entries, else on their bill-of-materials lines),
-- written as a new MaterialVersion. The rest stay not tracked.
--
-- Everything runs as one transaction: if a check stops it, nothing is left
-- half made. Run packages/db/scripts/preflight-material-stock.sql on a copy
-- of production first to see what it will find.

BEGIN;

-- ── 1. Check first: every ledger row's site must match its material's site ─

DO $$
DECLARE
  bad bigint;
BEGIN
  SELECT COUNT(*) INTO bad
  FROM "MaterialLedgerEntry" le JOIN "Material" m ON m.id = le."materialId"
  WHERE le."siteId" <> m."siteId";
  IF bad > 0 THEN
    RAISE EXCEPTION 'material_stock_book: % ledger rows sit at a different site than their material', bad;
  END IF;
END $$;

-- ── 2. Unit conversion ───────────────────────────────────────────────────
-- Grams per unit, matching packages/services/src/lib/units/weight.ts.
-- Anything that is not a known weight (blank, a part's free-text unit) has
-- no factor, and stock_convert then leaves the number as it is.

CREATE FUNCTION stock_unit_grams(unit text) RETURNS numeric
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE unit
    WHEN 'G' THEN 1
    WHEN 'KG' THEN 1000
    WHEN 'MT' THEN 1000000
    WHEN 'OZ' THEN 28.349523125
    WHEN 'LB' THEN 453.59237
    WHEN 'TON' THEN 907184.74
  END::numeric
$$;

-- Convert q from one unit to another, rounded to 4 places (the book's
-- precision). Every total uses this, one movement at a time, so totals kept
-- up as we go and totals rebuilt from scratch always agree.
CREATE FUNCTION stock_convert(q numeric, from_unit text, to_unit text) RETURNS numeric
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE
    WHEN from_unit = to_unit OR stock_unit_grams(from_unit) IS NULL OR stock_unit_grams(to_unit) IS NULL THEN q
    ELSE ROUND(q * stock_unit_grams(from_unit) / stock_unit_grams(to_unit), 4)
  END
$$;

-- ── 3. Totals get columns for materials ──────────────────────────────────

ALTER TABLE "StockBalance"
  ADD COLUMN "received" DECIMAL(18,4) NOT NULL DEFAULT 0,
  ADD COLUMN "issued" DECIMAL(18,4) NOT NULL DEFAULT 0;

ALTER TABLE "StockBalance" DROP CONSTRAINT "StockBalance_parts_add_up";
ALTER TABLE "StockBalance" ADD CONSTRAINT "StockBalance_parts_add_up"
  CHECK ("onHand" = "produced" - "scrapped" - "consumed" + "adjusted" + "received" - "issued");

-- ── 4. A StockItem for every material ────────────────────────────────────
-- Materials made by scripts since the last migration may not have one.

INSERT INTO "StockItem" ("id", "stockableType", "stockableId", "siteId", "updatedAt")
SELECT gen_random_uuid(), 'MATERIAL', m.id, m."siteId", NOW()
FROM "Material" m
WHERE NOT EXISTS (
  SELECT 1 FROM "StockItem" si WHERE si."stockableType" = 'MATERIAL' AND si."stockableId" = m.id
);

-- ── 5. Fill in missing units from history ────────────────────────────────
-- For a material whose current version has no unit: the unit most used in
-- its ledger rows, else the unit most used on its bill-of-materials lines.
-- The unit is written as a new version, so the catalog is never edited in
-- place. Materials with neither stay not tracked.

CREATE TEMP TABLE unit_fill ON COMMIT DROP AS
WITH missing AS (
  SELECT m.id AS "materialId", m."currentVersionId"
  FROM "Material" m
  JOIN "MaterialVersion" mv ON mv.id = m."currentVersionId"
  WHERE mv."weightUnits" IS NULL
),
from_ledger AS (
  SELECT DISTINCT ON (le."materialId") le."materialId", le.unit
  FROM "MaterialLedgerEntry" le JOIN missing ON missing."materialId" = le."materialId"
  GROUP BY le."materialId", le.unit
  ORDER BY le."materialId", COUNT(*) DESC, le.unit
),
from_bom AS (
  SELECT DISTINCT ON (mv."materialId") mv."materialId", pmv."weightUnits" AS unit
  FROM "ProductMaterialVersion" pmv
  JOIN "MaterialVersion" mv ON mv.id = pmv."materialVersionId"
  JOIN missing ON missing."materialId" = mv."materialId"
  WHERE pmv."weightUnits" IS NOT NULL
  GROUP BY mv."materialId", pmv."weightUnits"
  ORDER BY mv."materialId", COUNT(*) DESC, pmv."weightUnits"
)
SELECT missing."materialId", missing."currentVersionId",
       COALESCE(fl.unit, fb.unit) AS unit,
       CASE WHEN fl.unit IS NOT NULL THEN 'ledger' ELSE 'bill of materials' END AS source,
       gen_random_uuid() AS "newVersionId"
FROM missing
LEFT JOIN from_ledger fl ON fl."materialId" = missing."materialId"
LEFT JOIN from_bom fb ON fb."materialId" = missing."materialId"
WHERE COALESCE(fl.unit, fb.unit) IS NOT NULL;

INSERT INTO "MaterialVersion" ("id", "version", "name", "shortCode", "materialNumber", "classification",
  "description", "externalNumber", "weightUnits", "unitCost", "attrs", "materialId", "createdAt")
SELECT uf."newVersionId",
       (SELECT MAX(v.version) + 1 FROM "MaterialVersion" v WHERE v."materialId" = uf."materialId"),
       cur."name", cur."shortCode", cur."materialNumber", cur."classification",
       cur."description", cur."externalNumber", uf.unit, cur."unitCost", cur."attrs", uf."materialId", NOW()
FROM unit_fill uf
JOIN "MaterialVersion" cur ON cur.id = uf."currentVersionId";

UPDATE "Material" m SET "currentVersionId" = uf."newVersionId", "updatedAt" = NOW()
FROM unit_fill uf WHERE m.id = uf."materialId";

DO $$
DECLARE
  r record;
  n integer := 0;
BEGIN
  FOR r IN SELECT "materialId", unit, source FROM unit_fill ORDER BY "materialId" LOOP
    n := n + 1;
    IF n <= 100 THEN
      RAISE NOTICE 'material_stock_book: material % gets unit % (from its %)', r."materialId", r.unit, r.source;
    END IF;
  END LOOP;
  RAISE NOTICE 'material_stock_book: % material(s) got a unit from their history', n;
END $$;

-- Every material's stock unit is its current weight unit; blank = not tracked.
UPDATE "StockItem" si
SET "baseUnit" = COALESCE(mv."weightUnits"::text, ''), "updatedAt" = NOW()
FROM "Material" m
LEFT JOIN "MaterialVersion" mv ON mv.id = m."currentVersionId"
WHERE si."stockableType" = 'MATERIAL' AND si."stockableId" = m.id
  AND si."baseUnit" IS DISTINCT FROM COALESCE(mv."weightUnits"::text, '');

-- ── 6. Fill the book from the material ledger ────────────────────────────
-- Same rows the live code posts (packages/services/src/stock/sources.ts).
-- PRODUCTION (the end-of-shift flush) becomes USAGE. Rows written *for* a
-- shift — PRODUCTION, and a job history amendment's ADJUSTMENT (its reference
-- is the amendment id) — are placed at that shift's start, so they stay in
-- it. Oldest first, so seq follows time.

INSERT INTO "StockMovement" ("id", "stockItemId", "siteId", "kind", "quantity", "unit", "sourceType", "sourceId",
  "idempotencyKey", "shiftInstanceId", "isScheduled", "businessDate", "performedByUserId", "note",
  "occurredAt", "createdAt")
SELECT gen_random_uuid(), f.*, NOW()
FROM (
  SELECT si.id AS "stockItemId", le."siteId",
         (CASE le.kind WHEN 'PRODUCTION' THEN 'USAGE' ELSE le.kind::text END)::"StockMovementKind" AS kind,
         le.quantity, le.unit::text AS unit,
         'MATERIAL_LEDGER_ENTRY'::"StockSourceType" AS "sourceType", le.id AS "sourceId",
         'MATERIAL_LEDGER_ENTRY:' || le.id AS "idempotencyKey",
         le."shiftInstanceId", le."isScheduled", le."businessDate", le."performedByUserId", le.note,
         CASE WHEN le.kind = 'PRODUCTION'
                OR (le.kind = 'ADJUSTMENT' AND le.reference IN (SELECT ja.id::text FROM "JobHistoryAmendment" ja))
              THEN COALESCE(sh."startTime", le."createdAt")
              ELSE le."createdAt" END AS "occurredAt"
  FROM "MaterialLedgerEntry" le
  JOIN "StockItem" si ON si."stockableType" = 'MATERIAL' AND si."stockableId" = le."materialId"
  LEFT JOIN "ShiftInstance" sh ON sh.id = le."shiftInstanceId"
  WHERE le.quantity <> 0
) f
ORDER BY f."occurredAt", f."sourceId";

-- ── 7. Totals for every material, in its stock unit ──────────────────────

INSERT INTO "StockBalance" ("stockItemId", "siteId", "onHand", "adjusted", "received", "issued", "updatedAt")
SELECT si.id, si."siteId",
  COALESCE(SUM(stock_convert(m.quantity, m.unit, si."baseUnit")), 0),
  COALESCE(SUM(stock_convert(m.quantity, m.unit, si."baseUnit"))
    FILTER (WHERE m.kind = 'ADJUSTMENT'), 0),
  COALESCE(SUM(stock_convert(m.quantity, m.unit, si."baseUnit"))
    FILTER (WHERE m.kind IN ('RECEIPT', 'TRANSFER_IN', 'OPENING_BALANCE')), 0),
  COALESCE(-SUM(stock_convert(m.quantity, m.unit, si."baseUnit"))
    FILTER (WHERE m.kind IN ('USAGE', 'WRITE_OFF', 'TRANSFER_OUT')), 0),
  NOW()
FROM "StockItem" si
LEFT JOIN "StockMovement" m ON m."stockItemId" = si.id
WHERE si."stockableType" = 'MATERIAL'
GROUP BY si.id, si."siteId"
ON CONFLICT ("stockItemId") DO UPDATE
SET "onHand" = EXCLUDED."onHand", "adjusted" = EXCLUDED."adjusted", "received" = EXCLUDED."received",
    "issued" = EXCLUDED."issued", "updatedAt" = NOW();

-- ── 8. Compare with the old balance ──────────────────────────────────────
-- The old balance added ledger rows up as plain numbers. It can only differ
-- from the new one where a material's rows used more than one unit; those
-- are printed so they can be looked at.

DO $$
DECLARE
  r record;
  n integer := 0;
BEGIN
  FOR r IN
    SELECT si."stockableId" AS "materialId", si."baseUnit", old.total AS old_total, b."onHand" AS new_total
    FROM "StockItem" si
    JOIN "StockBalance" b ON b."stockItemId" = si.id
    JOIN (SELECT "materialId", SUM(quantity) AS total FROM "MaterialLedgerEntry" GROUP BY 1) old
      ON old."materialId" = si."stockableId"
    WHERE si."stockableType" = 'MATERIAL' AND old.total <> b."onHand"
  LOOP
    n := n + 1;
    IF n <= 50 THEN
      RAISE NOTICE 'material_stock_book: material % (%): old balance %, new %',
        r."materialId", r."baseUnit", r.old_total, r.new_total;
    END IF;
  END LOOP;
  RAISE NOTICE 'material_stock_book: % material(s) differ from the old balance (mixed units)', n;

  -- The totals must equal the converted book, or something above is wrong.
  SELECT COUNT(*) INTO n
  FROM "StockBalance" b
  JOIN "StockItem" si ON si.id = b."stockItemId"
  WHERE si."stockableType" = 'MATERIAL'
    AND b."onHand" <> (
      SELECT COALESCE(SUM(stock_convert(m.quantity, m.unit, si."baseUnit")), 0)
      FROM "StockMovement" m WHERE m."stockItemId" = b."stockItemId"
    );
  IF n > 0 THEN
    RAISE EXCEPTION 'material_stock_book: % material balance(s) do not match their movements', n;
  END IF;
END $$;

COMMIT;
