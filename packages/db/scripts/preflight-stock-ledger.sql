-- Pre-flight for migration 20261001100000_stock_ledger (ADR-0016).
--
-- Changes nothing: everything runs inside one transaction that is rolled back
-- at the end (the only thing it makes is a temporary view, gone on rollback).
-- Run it on a copy of production before deploying, to see:
--   1. how big the first fill will be (so we know if it fits the deploy),
--   2. anything that would stop the migration (a record at a different site
--      than its product),
--   3. which products will show a different stock number after the move, and
--      by how much. The new numbers come straight from the records; the old
--      counters in ProductStock win nowhere.
--
-- Usage:
--   psql "$DATABASE_URL" -f packages/db/scripts/preflight-stock-ledger.sql

BEGIN;

\echo
\echo '── 1. Size of the first fill ──────────────────────────────────────────'

SELECT 'made parts (InventoryItem, not deleted)' AS what, COUNT(*) AS rows
  FROM "InventoryItem" WHERE "deletedAt" IS NULL AND quantity <> 0
UNION ALL
SELECT 'scrap (ItemDispositionLog, not deleted)', COUNT(*)
  FROM "ItemDispositionLog" WHERE "deletedAt" IS NULL AND quantity <> 0
UNION ALL
SELECT 'order consumption', COUNT(*) FROM "OrderConsumption" WHERE quantity <> 0
UNION ALL
SELECT 'stock adjustments (non-zero)', COUNT(*) FROM "ProductStockAdjustment" WHERE delta <> 0
UNION ALL
SELECT 'products (one StockItem each)', COUNT(*) FROM "Product"
UNION ALL
SELECT 'materials (one StockItem each)', COUNT(*) FROM "Material";

SELECT pg_size_pretty(pg_total_relation_size('"InventoryItem"')) AS "InventoryItem size on disk";

\echo
\echo '── 2. Would stop the migration (all must be 0) ────────────────────────'

SELECT 'made parts at another site than their product' AS problem, COUNT(*) AS rows
  FROM "InventoryItem" ii
  JOIN "Cycle" cy ON cy.id = ii."cycleId"
  JOIN "ProductVersion" pv ON pv.id = ii."productVersionId"
  JOIN "Product" p ON p.id = pv."productId"
  WHERE ii."deletedAt" IS NULL AND COALESCE(ii."siteId", cy."siteId") <> p."siteId"
UNION ALL
SELECT 'scrap at another site than its product', COUNT(*)
  FROM "ItemDispositionLog" idl
  JOIN "ProductVersion" pv ON pv.id = idl."productVersionId"
  JOIN "Product" p ON p.id = pv."productId"
  WHERE idl."deletedAt" IS NULL AND idl."siteId" <> p."siteId"
UNION ALL
SELECT 'order consumption at another site than its product', COUNT(*)
  FROM "OrderConsumption" oc JOIN "Product" p ON p.id = oc."productId"
  WHERE oc."siteId" <> p."siteId"
UNION ALL
SELECT 'stock adjustments at another site than their product', COUNT(*)
  FROM "ProductStockAdjustment" sa JOIN "Product" p ON p.id = sa."productId"
  WHERE sa."siteId" <> p."siteId";

\echo
\echo '── 3. Products whose stock number will change ─────────────────────────'
\echo 'old = ProductStock counters today; new = totals rebuilt from the records.'
\echo '"available" is what screens and orders see (never below zero).'

CREATE TEMP VIEW stock_preflight AS
WITH produced AS (
  SELECT pv."productId", SUM(ii.quantity) AS total
  FROM "InventoryItem" ii JOIN "ProductVersion" pv ON pv.id = ii."productVersionId"
  WHERE ii."deletedAt" IS NULL AND ii.quantity <> 0
  GROUP BY 1
),
scrapped AS (
  SELECT pv."productId", SUM(idl.quantity) AS total
  FROM "ItemDispositionLog" idl JOIN "ProductVersion" pv ON pv.id = idl."productVersionId"
  WHERE idl."deletedAt" IS NULL AND idl.quantity <> 0
  GROUP BY 1
),
consumed AS (
  SELECT "productId", SUM(quantity) AS total FROM "OrderConsumption" GROUP BY 1
),
adjusted AS (
  SELECT "productId", SUM(delta) AS total FROM "ProductStockAdjustment" GROUP BY 1
),
fresh AS (
  SELECT p.id AS "productId", p."siteId",
         COALESCE(pr.total, 0) AS produced, COALESCE(sc.total, 0) AS scrapped,
         COALESCE(co.total, 0) AS consumed, COALESCE(ad.total, 0) AS adjusted
  FROM "Product" p
  LEFT JOIN produced pr ON pr."productId" = p.id
  LEFT JOIN scrapped sc ON sc."productId" = p.id
  LEFT JOIN consumed co ON co."productId" = p.id
  LEFT JOIN adjusted ad ON ad."productId" = p.id
)
SELECT f."siteId", f."productId",
       pv.sku,
       GREATEST(COALESCE(ps.produced - ps.scrapped - ps.consumed + ps.adjustment, 0), 0) AS old_available,
       GREATEST(f.produced - f.scrapped - f.consumed + f.adjusted, 0) AS new_available,
       COALESCE(ps.produced, 0) AS old_produced, f.produced AS new_produced,
       COALESCE(ps.scrapped, 0) AS old_scrapped, f.scrapped AS new_scrapped,
       COALESCE(ps.consumed, 0) AS old_consumed, f.consumed AS new_consumed,
       COALESCE(ps.adjustment, 0) AS old_adjusted, f.adjusted AS new_adjusted
FROM fresh f
JOIN "Product" p ON p.id = f."productId"
LEFT JOIN "ProductVersion" pv ON pv.id = p."currentVersionId"
LEFT JOIN "ProductStock" ps ON ps."productId" = f."productId" AND ps."siteId" = f."siteId"
WHERE COALESCE(ps.produced, 0) <> f.produced
   OR COALESCE(ps.scrapped, 0) <> f.scrapped
   OR COALESCE(ps.consumed, 0) <> f.consumed
   OR COALESCE(ps.adjustment, 0) <> f.adjusted;

SELECT COUNT(*) AS "products that change",
       COUNT(*) FILTER (WHERE old_available <> new_available) AS "of which available changes",
       COUNT(*) FILTER (WHERE p."deletedAt" IS NULL AND p."archivedAt" IS NULL) AS "of which are live products"
FROM stock_preflight s JOIN "Product" p ON p.id = s."productId";

-- ProductStock rows kept at a site other than their product's (would be left behind).
SELECT COUNT(*) AS "ProductStock rows at another site than their product"
FROM "ProductStock" ps JOIN "Product" p ON p.id = ps."productId"
WHERE ps."siteId" <> p."siteId";

\echo
\echo 'Largest changes in available stock (top 50):'

SELECT s."siteId", s."productId", s.sku,
       s.old_available, s.new_available, s.new_available - s.old_available AS change,
       s.old_produced, s.new_produced, s.old_scrapped, s.new_scrapped,
       s.old_consumed, s.new_consumed, s.old_adjusted, s.new_adjusted
FROM stock_preflight s
ORDER BY ABS(s.new_available - s.old_available) DESC, s."productId"
LIMIT 50;

ROLLBACK;
