-- Migration: Convert goodCycles and goodItems to generated columns
--
-- Previously these were regular stored columns that could become
-- inconsistent with totalCycles/badCycles and totalItems/badItems
-- during transient atomic-increment windows. Making them generated
-- columns guarantees they are always derived from their inputs.
--
-- Also updates the quality and OEE generated column formulas to
-- reference (totalItems - badItems) directly instead of the
-- goodItems column (which is semantically the same, but makes the
-- dependency explicit and avoids a circular-looking reference).

-- ══════════════════════════════════════════════════════════════════
-- 1. Drop dependent generated columns (quality, oee)
--    They reference goodItems which we're about to drop/recreate.
-- ══════════════════════════════════════════════════════════════════

ALTER TABLE "MetricBucket" DROP COLUMN "quality";
ALTER TABLE "MetricBucket" DROP COLUMN "oee";

-- ══════════════════════════════════════════════════════════════════
-- 2. Drop goodCycles and goodItems (regular stored columns)
-- ══════════════════════════════════════════════════════════════════

ALTER TABLE "MetricBucket" DROP COLUMN "goodCycles";
ALTER TABLE "MetricBucket" DROP COLUMN "goodItems";

-- ══════════════════════════════════════════════════════════════════
-- 3. Recreate goodCycles and goodItems as generated columns
-- ══════════════════════════════════════════════════════════════════

ALTER TABLE "MetricBucket" ADD COLUMN "goodCycles" INT
  GENERATED ALWAYS AS ("totalCycles" - "badCycles") STORED;

ALTER TABLE "MetricBucket" ADD COLUMN "goodItems" INT
  GENERATED ALWAYS AS ("totalItems" - "badItems") STORED;

-- ══════════════════════════════════════════════════════════════════
-- 4. Recreate quality using (totalItems - badItems) / totalItems
--    Semantically identical to goodItems / totalItems, but the
--    expression is self-contained (no reference to another generated col).
-- ══════════════════════════════════════════════════════════════════

ALTER TABLE "MetricBucket" ADD COLUMN "quality" DECIMAL(10,6)
  GENERATED ALWAYS AS (
    CASE WHEN "totalItems" > 0
         THEN ("totalItems" - "badItems")::numeric / "totalItems"::numeric
         ELSE NULL
    END
  ) STORED;

-- ══════════════════════════════════════════════════════════════════
-- 5. Recreate OEE using (totalItems - badItems) instead of goodItems
--    OEE = (idealCycleSeconds * (totalItems - badItems))
--        / (elapsedPlannedProductionSeconds * totalItems)
-- ══════════════════════════════════════════════════════════════════

ALTER TABLE "MetricBucket" ADD COLUMN "oee" DECIMAL(10,6)
  GENERATED ALWAYS AS (
    CASE WHEN "elapsedPlannedProductionSeconds" > 0
              AND "totalItems" > 0
         THEN ("idealCycleSeconds"::numeric * ("totalItems" - "badItems")::numeric)
              / ("elapsedPlannedProductionSeconds"::numeric * "totalItems"::numeric)
         ELSE NULL
    END
  ) STORED;
