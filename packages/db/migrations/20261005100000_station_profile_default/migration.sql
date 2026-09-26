-- The Discrete default profile (ADR-0017, section 1a), as its own step.
--
-- 20261004100000_station_profiles shipped first and has already run on some
-- databases, so its file must stay exactly as it was: Prisma never runs an
-- applied migration again. Everything about the default lives here instead.
--
-- Every site gets one default profile, "Discrete": count by cycle, with no
-- standard of its own (every job sets its own standard cycle time). It is:
--   - the site's existing plain count-by-cycle profile (no unit), when there
--     is one; its stations keep the cycle times they have, so they stop
--     "following" it; or
--   - a new "Discrete" profile, for sites without one.
-- Jobs with no profile get the default, unless they carry a rate (then a
-- person picks their kind).

BEGIN;

ALTER TABLE "StationProfile" ADD COLUMN IF NOT EXISTS "isDefault" BOOLEAN NOT NULL DEFAULT false;
-- At most one default per site.
CREATE UNIQUE INDEX IF NOT EXISTS "StationProfile_siteId_default_key"
  ON "StationProfile"("siteId") WHERE "isDefault";

-- ── 1. The plain count-by-cycle profile becomes the default ──────────────

CREATE TEMP TABLE sp_default ON COMMIT DROP AS
SELECT DISTINCT ON (p."siteId") p.id, p."siteId"
FROM "StationProfile" p
WHERE p."cycleMode" = 'DISCRETE'
  AND p."quantityUnit" = ''
  AND p."archivedAt" IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM "StationProfile" d WHERE d."siteId" = p."siteId" AND d."isDefault"
  )
ORDER BY p."siteId", p."createdAt", p.id;

-- Its stations keep the standard cycle time they have: it becomes their own.
UPDATE "StationVersion" sv
SET "speedFromProfile" = false
FROM sp_default d
WHERE sv."profileId" = d.id
  AND sv."speedFromProfile"
  AND sv."standardCycle" IS NOT NULL;

UPDATE "StationProfile" p
SET "isDefault" = true,
    "standardCycle" = NULL,
    "description" = 'Counts by cycle; the target is a cycle time in seconds.',
    -- Renamed to "Discrete" unless another profile on the site has that name.
    "name" = CASE
      WHEN EXISTS (
        SELECT 1 FROM "StationProfile" o
        WHERE o."siteId" = p."siteId" AND o.name = 'Discrete' AND o.id <> p.id
      ) THEN p.name
      ELSE 'Discrete'
    END,
    "updatedAt" = CURRENT_TIMESTAMP
FROM sp_default d
WHERE p.id = d.id;

-- ── 2. Sites still without a default get "Discrete" ──────────────────────

INSERT INTO "StationProfile" (
  "id", "name", "description", "cycleMode", "countedAs", "isDefault", "createdAt", "updatedAt", "siteId"
)
SELECT gen_random_uuid(),
       CASE WHEN EXISTS (SELECT 1 FROM "StationProfile" o WHERE o."siteId" = si.id AND o.name = 'Discrete')
            THEN 'Discrete (default)' ELSE 'Discrete' END,
       'Counts by cycle; the target is a cycle time in seconds.',
       'DISCRETE', 'CYCLES', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, si.id
FROM "Site" si
WHERE NOT EXISTS (SELECT 1 FROM "StationProfile" p WHERE p."siteId" = si.id AND p."isDefault");

-- ── 3. Jobs with no profile get the default, unless they carry a rate ────

UPDATE "JobVersion" jv
SET "profileId" = p.id
FROM "Job" j
JOIN "StationProfile" p ON p."siteId" = j."siteId" AND p."isDefault"
WHERE jv.id = j."currentVersionId"
  AND jv."profileId" IS NULL
  AND jv."standardRate" IS NULL;

-- ── 4. Checks ────────────────────────────────────────────────────────────

DO $$
DECLARE
  n bigint;
BEGIN
  SELECT COUNT(*) INTO n FROM "Site" si
  WHERE NOT EXISTS (
    SELECT 1 FROM "StationProfile" p
    WHERE p."siteId" = si.id AND p."isDefault" AND p."cycleMode" = 'DISCRETE'
  );
  IF n > 0 THEN
    RAISE EXCEPTION 'station_profile_default: % site(s) have no Discrete default', n;
  END IF;

  SELECT COUNT(*) INTO n FROM "StationProfile" WHERE "isDefault" AND "standardCycle" IS NOT NULL;
  IF n > 0 THEN
    RAISE EXCEPTION 'station_profile_default: % default profile(s) still have a standard', n;
  END IF;
END $$;

COMMIT;
