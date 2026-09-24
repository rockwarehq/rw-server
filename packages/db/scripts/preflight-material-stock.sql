-- Pre-flight for migration 20261003100000_material_stock_book (ADR-0016 phase 2).
--
-- Changes nothing: everything runs inside one transaction that is rolled back
-- at the end. Run it on a copy of production before deploying, to see:
--   1. how many ledger rows the migration copies into the stock book,
--   2. anything that would stop the migration,
--   3. which materials get a unit from their history, and which stay not
--      tracked (and whether any of those are in use, so their production use
--      is not being recorded),
--   4. which materials show a different balance, because their ledger mixed
--      units that the old balance added up as plain numbers.
--
-- Usage:
--   psql "$DATABASE_URL" -f packages/db/scripts/preflight-material-stock.sql

BEGIN;

\echo
\echo '── 1. Size ───────────────────────────────────────────────────────────'

SELECT 'material ledger rows (non-zero)' AS what, COUNT(*) AS rows
  FROM "MaterialLedgerEntry" WHERE quantity <> 0
UNION ALL
SELECT 'materials', COUNT(*) FROM "Material";

\echo
\echo '── 2. Would stop the migration (must be 0) ───────────────────────────'

SELECT COUNT(*) AS "ledger rows at another site than their material"
FROM "MaterialLedgerEntry" le JOIN "Material" m ON m.id = le."materialId"
WHERE le."siteId" <> m."siteId";

\echo
\echo '── 3. Materials with no unit ─────────────────────────────────────────'
\echo 'fills_with = the unit the migration will give it (blank = stays not tracked).'
\echo 'in_use = on the bill of materials of a live part (its use is not recorded while not tracked).'

WITH missing AS (
  SELECT m.id, m."siteId", mv."materialNumber", mv.name, m."deletedAt", m."archivedAt"
  FROM "Material" m JOIN "MaterialVersion" mv ON mv.id = m."currentVersionId"
  WHERE mv."weightUnits" IS NULL
),
from_ledger AS (
  SELECT DISTINCT ON (le."materialId") le."materialId", le.unit::text AS unit
  FROM "MaterialLedgerEntry" le JOIN missing ON missing.id = le."materialId"
  GROUP BY le."materialId", le.unit
  ORDER BY le."materialId", COUNT(*) DESC, le.unit
),
from_bom AS (
  SELECT DISTINCT ON (mv."materialId") mv."materialId", pmv."weightUnits"::text AS unit
  FROM "ProductMaterialVersion" pmv
  JOIN "MaterialVersion" mv ON mv.id = pmv."materialVersionId"
  JOIN missing ON missing.id = mv."materialId"
  WHERE pmv."weightUnits" IS NOT NULL
  GROUP BY mv."materialId", pmv."weightUnits"
  ORDER BY mv."materialId", COUNT(*) DESC, pmv."weightUnits"
)
SELECT missing."siteId", missing.id AS "materialId", missing."materialNumber", missing.name,
       COALESCE(fl.unit, fb.unit, '') AS fills_with,
       CASE WHEN fl.unit IS NOT NULL THEN 'ledger' WHEN fb.unit IS NOT NULL THEN 'bill of materials' ELSE '' END
         AS from_history,
       EXISTS (
         SELECT 1 FROM "ProductMaterial" pm
         JOIN "Product" p ON p.id = pm."productId" AND p."deletedAt" IS NULL AND p."archivedAt" IS NULL
         WHERE pm."materialId" = missing.id AND pm."archivedAt" IS NULL
       ) AND missing."deletedAt" IS NULL AND missing."archivedAt" IS NULL AS in_use
FROM missing
LEFT JOIN from_ledger fl ON fl."materialId" = missing.id
LEFT JOIN from_bom fb ON fb."materialId" = missing.id
ORDER BY (COALESCE(fl.unit, fb.unit) IS NULL) DESC, in_use DESC, missing."materialNumber";

\echo
\echo '── 4. Materials whose balance changes (mixed units) ──────────────────'
\echo 'old = ledger rows added as plain numbers; new = each row converted to the material unit.'

WITH grams(unit, g) AS (
  VALUES ('G', 1::numeric), ('KG', 1000), ('MT', 1000000), ('OZ', 28.349523125), ('LB', 453.59237),
         ('TON', 907184.74)
),
ledger_mode AS (
  SELECT DISTINCT ON ("materialId") "materialId", unit::text AS unit
  FROM "MaterialLedgerEntry"
  GROUP BY "materialId", unit
  ORDER BY "materialId", COUNT(*) DESC, unit
),
-- The unit after the migration: the current one, or the one filled in from
-- the ledger (a material with ledger rows always gets one).
unit_of AS (
  SELECT m.id AS "materialId", COALESCE(mv."weightUnits"::text, lm.unit) AS unit
  FROM "Material" m
  JOIN "MaterialVersion" mv ON mv.id = m."currentVersionId"
  LEFT JOIN ledger_mode lm ON lm."materialId" = m.id
)
SELECT le."materialId", u.unit AS material_unit,
       SUM(le.quantity) AS old_balance,
       SUM(CASE WHEN le.unit::text = u.unit OR u.unit IS NULL THEN le.quantity
                ELSE ROUND(le.quantity * gf.g / gt.g, 4) END) AS new_balance,
       string_agg(DISTINCT le.unit::text, ', ') AS units_used
FROM "MaterialLedgerEntry" le
JOIN unit_of u ON u."materialId" = le."materialId"
LEFT JOIN grams gf ON gf.unit = le.unit::text
LEFT JOIN grams gt ON gt.unit = u.unit
GROUP BY le."materialId", u.unit
HAVING COUNT(DISTINCT le.unit) > 1
    OR bool_or(u.unit IS NOT NULL AND le.unit::text <> u.unit)
ORDER BY le."materialId";

ROLLBACK;
