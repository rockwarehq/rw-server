-- Migration: Convert MetricBucketLog snapshotted columns to generated columns
--
-- Previously, goodCycles, goodItems, plannedProductionSeconds, availability,
-- performance, quality, and oee were plain columns snapshotted at archive time.
-- This made them stale when operators edited downtime reasons or dispositions
-- after the shift was archived.
--
-- Converting them to generated columns (matching MetricBucket's formulas)
-- means updating the raw additive fields automatically recomputes all derived
-- metrics — no drift, no staleness.

-- ══════════════════════════════════════════════════════════════════
-- 1. Drop existing plain columns
-- ══════════════════════════════════════════════════════════════════

-- Drop in reverse dependency order (oee/quality depend on goodItems conceptually)
ALTER TABLE "MetricBucketLog" DROP COLUMN "oee";
ALTER TABLE "MetricBucketLog" DROP COLUMN "quality";
ALTER TABLE "MetricBucketLog" DROP COLUMN "performance";
ALTER TABLE "MetricBucketLog" DROP COLUMN "availability";
ALTER TABLE "MetricBucketLog" DROP COLUMN "plannedProductionSeconds";
ALTER TABLE "MetricBucketLog" DROP COLUMN "goodItems";
ALTER TABLE "MetricBucketLog" DROP COLUMN "goodCycles";

-- ══════════════════════════════════════════════════════════════════
-- 2. Recreate as generated columns (same formulas as MetricBucket)
-- ══════════════════════════════════════════════════════════════════

-- goodCycles = totalCycles - badCycles
ALTER TABLE "MetricBucketLog" ADD COLUMN "goodCycles" INT
  GENERATED ALWAYS AS ("totalCycles" - "badCycles") STORED;

-- goodItems = totalItems - badItems
ALTER TABLE "MetricBucketLog" ADD COLUMN "goodItems" INT
  GENERATED ALWAYS AS ("totalItems" - "badItems") STORED;

-- plannedProductionSeconds = durationSeconds - plannedDownSeconds
ALTER TABLE "MetricBucketLog" ADD COLUMN "plannedProductionSeconds" INT
  GENERATED ALWAYS AS ("durationSeconds" - "plannedDownSeconds") STORED;

-- availability = runSeconds / elapsedPlannedProductionSeconds
-- NULL when no production window (entire period is planned downtime)
ALTER TABLE "MetricBucketLog" ADD COLUMN "availability" DECIMAL(10,6)
  GENERATED ALWAYS AS (
    CASE WHEN "elapsedPlannedProductionSeconds" > 0
         THEN "runSeconds"::numeric / "elapsedPlannedProductionSeconds"::numeric
         ELSE NULL
    END
  ) STORED;

-- performance = idealCycleSeconds / runSeconds
-- NULL when no production window; 0 when no run time
ALTER TABLE "MetricBucketLog" ADD COLUMN "performance" DECIMAL(10,6)
  GENERATED ALWAYS AS (
    CASE WHEN "elapsedPlannedProductionSeconds" = 0 THEN NULL
         WHEN "runSeconds" > 0
         THEN "idealCycleSeconds"::numeric / "runSeconds"::numeric
         ELSE 0
    END
  ) STORED;

-- quality = (totalItems - badItems) / totalItems
-- NULL when no production window; 0 when no items produced
ALTER TABLE "MetricBucketLog" ADD COLUMN "quality" DECIMAL(10,6)
  GENERATED ALWAYS AS (
    CASE WHEN "elapsedPlannedProductionSeconds" = 0 THEN NULL
         WHEN "totalItems" > 0
         THEN ("totalItems" - "badItems")::numeric / "totalItems"::numeric
         ELSE 0
    END
  ) STORED;

-- oee = (idealCycleSeconds * (totalItems - badItems)) / (elapsedPlannedProductionSeconds * totalItems)
-- NULL when no production window; 0 when no items produced
ALTER TABLE "MetricBucketLog" ADD COLUMN "oee" DECIMAL(10,6)
  GENERATED ALWAYS AS (
    CASE WHEN "elapsedPlannedProductionSeconds" = 0 THEN NULL
         WHEN "totalItems" > 0
         THEN ("idealCycleSeconds"::numeric * ("totalItems" - "badItems")::numeric)
              / ("elapsedPlannedProductionSeconds"::numeric * "totalItems"::numeric)
         ELSE 0
    END
  ) STORED;
