-- Widen OEE ratio columns from DECIMAL(7,6) to DECIMAL(10,6) to prevent
-- numeric overflow when ratios momentarily exceed 9.999999 (e.g. when
-- idealCycleSeconds >> runSeconds during brief run windows).
--
-- PostgreSQL requires DROP + ADD for generated columns — data is recomputed
-- automatically so nothing is lost.

ALTER TABLE "MetricBucket" DROP COLUMN "availability";
ALTER TABLE "MetricBucket" DROP COLUMN "performance";
ALTER TABLE "MetricBucket" DROP COLUMN "quality";
ALTER TABLE "MetricBucket" DROP COLUMN "oee";

-- Availability = runSeconds / elapsedPlannedProductionSeconds
ALTER TABLE "MetricBucket" ADD COLUMN "availability" DECIMAL(10,6)
  GENERATED ALWAYS AS (
    CASE WHEN "elapsedPlannedProductionSeconds" > 0
         THEN "runSeconds"::numeric / "elapsedPlannedProductionSeconds"::numeric
         ELSE NULL
    END
  ) STORED;

-- Performance = idealCycleSeconds / runSeconds
ALTER TABLE "MetricBucket" ADD COLUMN "performance" DECIMAL(10,6)
  GENERATED ALWAYS AS (
    CASE WHEN "runSeconds" > 0
         THEN "idealCycleSeconds"::numeric / "runSeconds"::numeric
         ELSE NULL
    END
  ) STORED;

-- Quality = goodCycles / totalCycles
ALTER TABLE "MetricBucket" ADD COLUMN "quality" DECIMAL(10,6)
  GENERATED ALWAYS AS (
    CASE WHEN "totalCycles" > 0
         THEN "goodCycles"::numeric / "totalCycles"::numeric
         ELSE NULL
    END
  ) STORED;

-- OEE = Availability * Performance * Quality
-- Simplified: (idealCycleSeconds * goodCycles) / (elapsedPlannedProductionSeconds * totalCycles)
ALTER TABLE "MetricBucket" ADD COLUMN "oee" DECIMAL(10,6)
  GENERATED ALWAYS AS (
    CASE WHEN "elapsedPlannedProductionSeconds" > 0
              AND "totalCycles" > 0
         THEN ("idealCycleSeconds"::numeric * "goodCycles"::numeric)
              / ("elapsedPlannedProductionSeconds"::numeric * "totalCycles"::numeric)
         ELSE NULL
    END
  ) STORED;
