-- Station profiles (ADR-0017). A profile is a named kind of machine: how its
-- signal counts (by cycle, by amount, by time), its unit, the amount per
-- signal or the report interval, and the usual speed for new jobs.
--
-- Every site gets one default profile, "Discrete": count by cycle, with the
-- target a cycle time in seconds. New stations and jobs get it unless another
-- profile is picked, so a plant that only does normal discrete work never
-- sets anything up.
--
-- Backfill, per site:
--   1. One profile for each different counting setup on live stations. The
--      plain count-by-cycle setup becomes the site's "Discrete" default.
--   2. Each station's current version points at its profile. Its own speed
--      stays; it follows the profile only when it already equals the
--      profile's usual speed.
--   3. Each job's current version gets the profile of the station it ran on
--      last. Jobs that never ran get the default, unless they carry a rate
--      (then they stay without a profile for a person to pick).
--
-- Nothing the cycle engine reads changes, except one case: a Count-by-time
-- station with an "expected per report" and no rate gets that written as a
-- rate per minute (the same number of units per report), because profiles
-- carry a rate, not an expected amount.
--
-- Run packages/db/scripts/preflight-station-profiles.sql on a copy of
-- production first to see what it will do.

BEGIN;

-- ── Schema ───────────────────────────────────────────────────────────────

CREATE TYPE "ProfileCountedAs" AS ENUM ('OUTPUT', 'CYCLES');

CREATE TABLE "StationProfile" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "cycleMode" "CycleMode" NOT NULL,
    "quantityUnit" TEXT NOT NULL DEFAULT '',
    "signalAmount" DECIMAL(18,4),
    "signalInterval" DECIMAL(10,2),
    "countedAs" "ProfileCountedAs" NOT NULL DEFAULT 'CYCLES',
    "standardCycle" DECIMAL(10,2),
    "standardRate" DECIMAL(18,4),
    "standardRateUnit" TEXT NOT NULL DEFAULT '',
    "standardRatePeriod" "RatePeriod" NOT NULL DEFAULT 'MINUTE',
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "archivedAt" TIMESTAMPTZ(3),
    "siteId" UUID NOT NULL,

    CONSTRAINT "StationProfile_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "StationProfile_siteId_idx" ON "StationProfile"("siteId");
CREATE UNIQUE INDEX "StationProfile_siteId_name_key" ON "StationProfile"("siteId", "name");
-- At most one default per site.
CREATE UNIQUE INDEX "StationProfile_siteId_default_key" ON "StationProfile"("siteId") WHERE "isDefault";
ALTER TABLE "StationProfile" ADD CONSTRAINT "StationProfile_siteId_fkey"
  FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "StationVersion" ADD COLUMN "profileId" UUID,
ADD COLUMN "speedFromProfile" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX "StationVersion_profileId_idx" ON "StationVersion"("profileId");
ALTER TABLE "StationVersion" ADD CONSTRAINT "StationVersion_profileId_fkey"
  FOREIGN KEY ("profileId") REFERENCES "StationProfile"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "JobVersion" ADD COLUMN "profileId" UUID;
CREATE INDEX "JobVersion_profileId_idx" ON "JobVersion"("profileId");
ALTER TABLE "JobVersion" ADD CONSTRAINT "JobVersion_profileId_fkey"
  FOREIGN KEY ("profileId") REFERENCES "StationProfile"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- ── 1. Count-by-time "expected per report" becomes a rate ────────────────
-- Only where there is no rate yet. units per minute = amount × 60 ÷ seconds.

UPDATE "StationVersion" sv
SET "standardRate" = ROUND(sv."standardQuantity" * 60 / sv."standardCycle", 4),
    "standardRateUnit" = sv."quantityUnit",
    "standardRatePeriod" = 'MINUTE'
FROM "Station" s
WHERE s."currentVersionId" = sv.id
  AND s."deletedAt" IS NULL
  AND sv."cycleMode" = 'QUANTITY_PER_INTERVAL'
  AND sv."standardRate" IS NULL
  AND sv."standardQuantity" > 0
  AND sv."standardCycle" > 0;

-- ── 2. One profile per counting setup ────────────────────────────────────

CREATE TEMP TABLE sp_station ON COMMIT DROP AS
SELECT s.id AS "stationId",
       s."siteId",
       sv.id AS "versionId",
       sv."cycleMode",
       sv."quantityUnit",
       CASE WHEN sv."cycleMode" = 'QUANTITY_PER_CYCLE' THEN sv."standardQuantity" END AS amount,
       CASE WHEN sv."cycleMode" = 'QUANTITY_PER_INTERVAL' THEN sv."standardCycle" END AS "interval",
       -- The station's speed, in the shape its counting uses.
       CASE WHEN sv."cycleMode" = 'DISCRETE' THEN sv."standardCycle" END AS "speedCycle",
       CASE WHEN sv."cycleMode" <> 'DISCRETE' THEN sv."standardRate" END AS "speedRate",
       CASE WHEN sv."cycleMode" <> 'DISCRETE' THEN sv."standardRateUnit" ELSE '' END AS "speedRateUnit",
       sv."standardRatePeriod" AS "speedRatePeriod"
FROM "Station" s
JOIN "StationVersion" sv ON sv.id = s."currentVersionId"
WHERE s."deletedAt" IS NULL;

CREATE TEMP TABLE sp_setup ON COMMIT DROP AS
SELECT gen_random_uuid() AS "profileId",
       st."siteId", st."cycleMode", st."quantityUnit", st.amount, st."interval",
       -- The speed most of its stations use becomes the profile's usual speed.
       mode() WITHIN GROUP (ORDER BY st."speedCycle") AS "speedCycle",
       NULL::DECIMAL(18,4) AS "speedRate",
       ''::text AS "speedRateUnit",
       'MINUTE'::"RatePeriod" AS "speedRatePeriod",
       NULL::text AS name
FROM sp_station st
GROUP BY st."siteId", st."cycleMode", st."quantityUnit", st.amount, st."interval";

-- The most common rate (value + unit + period together) among its stations.
UPDATE sp_setup p
SET "speedRate" = r."speedRate", "speedRateUnit" = r."speedRateUnit", "speedRatePeriod" = r."speedRatePeriod"
FROM (
  SELECT DISTINCT ON (st."siteId", st."cycleMode", st."quantityUnit", st.amount, st."interval")
         st."siteId", st."cycleMode", st."quantityUnit", st.amount, st."interval",
         st."speedRate", st."speedRateUnit", st."speedRatePeriod"
  FROM sp_station st
  WHERE st."speedRate" IS NOT NULL
  GROUP BY st."siteId", st."cycleMode", st."quantityUnit", st.amount, st."interval",
           st."speedRate", st."speedRateUnit", st."speedRatePeriod"
  ORDER BY st."siteId", st."cycleMode", st."quantityUnit", st.amount, st."interval",
           COUNT(*) DESC, st."speedRate"
) r
WHERE r."siteId" = p."siteId" AND r."cycleMode" = p."cycleMode"
  AND r."quantityUnit" = p."quantityUnit"
  AND r.amount IS NOT DISTINCT FROM p.amount
  AND r."interval" IS NOT DISTINCT FROM p."interval";

-- Plain names, e.g. "Discrete", "Count by cycle (ea)", "Count by amount – 100 ft",
-- "Count by time – every 60 s (ea)". A number is added if two still match.
UPDATE sp_setup SET name = CASE "cycleMode"
    WHEN 'DISCRETE' THEN CASE WHEN "quantityUnit" = '' THEN 'Discrete'
      ELSE 'Count by cycle (' || "quantityUnit" || ')' END
    WHEN 'QUANTITY_PER_CYCLE' THEN 'Count by amount – '
      || COALESCE(trim_scale(amount)::text, '?') || ' ' || COALESCE(NULLIF("quantityUnit", ''), 'units')
    ELSE 'Count by time – every ' || COALESCE(trim_scale("interval")::text, '?') || ' s'
      || CASE WHEN "quantityUnit" <> '' THEN ' (' || "quantityUnit" || ')' ELSE '' END
  END;

UPDATE sp_setup p
SET name = p.name || ' ' || d.n
FROM (
  SELECT "profileId", ROW_NUMBER() OVER (PARTITION BY "siteId", name ORDER BY "profileId") AS n
  FROM sp_setup
) d
WHERE d."profileId" = p."profileId" AND d.n > 1;

INSERT INTO "StationProfile" (
  "id", "name", "description", "cycleMode", "quantityUnit", "signalAmount", "signalInterval",
  "countedAs", "standardCycle", "standardRate", "standardRateUnit", "standardRatePeriod",
  "isDefault", "createdAt", "updatedAt", "siteId"
)
SELECT "profileId", name,
       CASE WHEN "cycleMode" = 'DISCRETE' AND "quantityUnit" = ''
            THEN 'Counts by cycle; the target is a cycle time in seconds.'
            ELSE 'Made from existing station settings.' END,
       "cycleMode", "quantityUnit",
       amount, "interval",
       -- Count by time: "strokes" keeps every job's products as they are.
       -- Switch a profile to "finished parts" once its jobs have one product.
       CASE WHEN "cycleMode" = 'QUANTITY_PER_CYCLE' THEN 'OUTPUT'::"ProfileCountedAs"
            ELSE 'CYCLES'::"ProfileCountedAs" END,
       "speedCycle", "speedRate", "speedRateUnit", "speedRatePeriod",
       "cycleMode" = 'DISCRETE' AND "quantityUnit" = '',
       CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, "siteId"
FROM sp_setup;

-- Every site without one gets the "Discrete" default (no usual speed; each
-- job carries its own cycle time).
INSERT INTO "StationProfile" (
  "id", "name", "description", "cycleMode", "countedAs", "isDefault", "createdAt", "updatedAt", "siteId"
)
SELECT gen_random_uuid(), 'Discrete', 'Counts by cycle; the target is a cycle time in seconds.',
       'DISCRETE', 'CYCLES', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, si.id
FROM "Site" si
WHERE NOT EXISTS (SELECT 1 FROM "StationProfile" p WHERE p."siteId" = si.id AND p."isDefault");

-- ── 3. Stations point at their profile ───────────────────────────────────

UPDATE "StationVersion" sv
SET "profileId" = p."profileId",
    "speedFromProfile" = CASE
      WHEN st."cycleMode" = 'DISCRETE'
        THEN st."speedCycle" IS NOT DISTINCT FROM p."speedCycle"
      ELSE st."speedRate" IS NOT DISTINCT FROM p."speedRate"
        AND (st."speedRate" IS NULL OR (st."speedRateUnit" = p."speedRateUnit"
                                        AND st."speedRatePeriod" = p."speedRatePeriod"))
    END
FROM sp_station st
JOIN sp_setup p
  ON p."siteId" = st."siteId" AND p."cycleMode" = st."cycleMode"
 AND p."quantityUnit" = st."quantityUnit"
 AND p.amount IS NOT DISTINCT FROM st.amount
 AND p."interval" IS NOT DISTINCT FROM st."interval"
WHERE sv.id = st."versionId";

-- ── 4. Jobs get the profile of the station they ran on last ──────────────

UPDATE "JobVersion" jv
SET "profileId" = last."profileId"
FROM "Job" j
JOIN LATERAL (
  SELECT sv."profileId"
  FROM "StationJobLog" l
  JOIN "Station" s ON s.id = l."stationId"
  JOIN "StationVersion" sv ON sv.id = s."currentVersionId"
  WHERE l."jobId" = j.id AND sv."profileId" IS NOT NULL
  ORDER BY l."startTime" DESC
  LIMIT 1
) last ON true
WHERE jv.id = j."currentVersionId";

-- Jobs that never ran get the default, unless they carry a rate (a rate
-- means another kind of machine; a person picks the profile for those).
UPDATE "JobVersion" jv
SET "profileId" = p.id
FROM "Job" j
JOIN "StationProfile" p ON p."siteId" = j."siteId" AND p."isDefault"
WHERE jv.id = j."currentVersionId"
  AND jv."profileId" IS NULL
  AND jv."standardRate" IS NULL;

-- ── 5. Checks ────────────────────────────────────────────────────────────

DO $$
DECLARE
  n bigint;
BEGIN
  SELECT COUNT(*) INTO n
  FROM "Station" s JOIN "StationVersion" sv ON sv.id = s."currentVersionId"
  WHERE s."deletedAt" IS NULL AND sv."profileId" IS NULL;
  IF n > 0 THEN
    RAISE EXCEPTION 'station_profiles: % live station(s) got no profile', n;
  END IF;

  -- A station's copied counting fields must match its profile.
  SELECT COUNT(*) INTO n
  FROM "StationVersion" sv JOIN "StationProfile" p ON p.id = sv."profileId"
  WHERE sv."cycleMode" <> p."cycleMode" OR sv."quantityUnit" <> p."quantityUnit";
  IF n > 0 THEN
    RAISE EXCEPTION 'station_profiles: % station version(s) do not match their profile', n;
  END IF;

  SELECT COUNT(*) INTO n FROM "Site" si
  WHERE NOT EXISTS (SELECT 1 FROM "StationProfile" p WHERE p."siteId" = si.id AND p."isDefault" AND p."cycleMode" = 'DISCRETE');
  IF n > 0 THEN
    RAISE EXCEPTION 'station_profiles: % site(s) have no Discrete default', n;
  END IF;
END $$;

COMMIT;
