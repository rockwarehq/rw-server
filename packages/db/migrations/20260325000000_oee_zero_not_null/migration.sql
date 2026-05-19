-- Fix OEE ratios: return 0 (not NULL) when a station had production time
-- but produced nothing. NULL is reserved for "not expected to produce"
-- (entire window is planned downtime, elapsedPlannedProductionSeconds = 0).
--
-- Availability is unchanged — it already returns NULL when
-- elapsedPlannedProductionSeconds = 0 and naturally yields 0 when
-- runSeconds = 0.

-- ══════════════════════════════════════════════════════════════════
-- 1. Drop and recreate performance, quality, oee on MetricBucket
-- ══════════════════════════════════════════════════════════════════

ALTER TABLE "MetricBucket" DROP COLUMN "performance";
ALTER TABLE "MetricBucket" DROP COLUMN "quality";
ALTER TABLE "MetricBucket" DROP COLUMN "oee";

-- Performance: NULL when no production window, 0 when no run time
ALTER TABLE "MetricBucket" ADD COLUMN "performance" DECIMAL(10,6)
  GENERATED ALWAYS AS (
    CASE WHEN "elapsedPlannedProductionSeconds" = 0 THEN NULL
         WHEN "runSeconds" > 0
         THEN "idealCycleSeconds"::numeric / "runSeconds"::numeric
         ELSE 0
    END
  ) STORED;

-- Quality: NULL when no production window, 0 when no items produced
ALTER TABLE "MetricBucket" ADD COLUMN "quality" DECIMAL(10,6)
  GENERATED ALWAYS AS (
    CASE WHEN "elapsedPlannedProductionSeconds" = 0 THEN NULL
         WHEN "totalItems" > 0
         THEN ("totalItems" - "badItems")::numeric / "totalItems"::numeric
         ELSE 0
    END
  ) STORED;

-- OEE: NULL when no production window, 0 when no items produced
ALTER TABLE "MetricBucket" ADD COLUMN "oee" DECIMAL(10,6)
  GENERATED ALWAYS AS (
    CASE WHEN "elapsedPlannedProductionSeconds" = 0 THEN NULL
         WHEN "totalItems" > 0
         THEN ("idealCycleSeconds"::numeric * ("totalItems" - "badItems")::numeric)
              / ("elapsedPlannedProductionSeconds"::numeric * "totalItems"::numeric)
         ELSE 0
    END
  ) STORED;

-- ══════════════════════════════════════════════════════════════════
-- 2. Backfill MetricBucketLog (snapshot table — not generated columns)
-- ══════════════════════════════════════════════════════════════════

-- Performance: set to 0 where station had production time but NULL perf
UPDATE "MetricBucketLog"
SET "performance" = CASE
      WHEN "runSeconds" > 0
      THEN "idealCycleSeconds"::numeric / "runSeconds"::numeric
      ELSE 0
    END
WHERE "performance" IS NULL
  AND "elapsedPlannedProductionSeconds" > 0;

-- Quality: set to 0 where station had production time but NULL quality
UPDATE "MetricBucketLog"
SET "quality" = CASE
      WHEN "totalItems" > 0
      THEN ("totalItems" - "badItems")::numeric / "totalItems"::numeric
      ELSE 0
    END
WHERE "quality" IS NULL
  AND "elapsedPlannedProductionSeconds" > 0;

-- OEE: set to 0 where station had production time but NULL oee
UPDATE "MetricBucketLog"
SET "oee" = CASE
      WHEN "totalItems" > 0
      THEN ("idealCycleSeconds"::numeric * ("totalItems" - "badItems")::numeric)
           / ("elapsedPlannedProductionSeconds"::numeric * "totalItems"::numeric)
      ELSE 0
    END
WHERE "oee" IS NULL
  AND "elapsedPlannedProductionSeconds" > 0;
