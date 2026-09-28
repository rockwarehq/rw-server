-- Station profile variations (ADR-0017, section 8).
--
-- A profile stays the kind of machine a job is made for: how it counts, its
-- unit, parts or strokes, and the usual speed. How one group of those
-- machines signals — the amount per signal or the report interval — and the
-- note on which machines it is for move to a variation. Every profile gets
-- exactly one variation here, holding what the profile held, and every
-- station that follows a profile follows that variation. Nothing a station
-- or the cycle engine reads changes value.

BEGIN;

CREATE TABLE "StationProfileVariation" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "description" TEXT,
    "signalAmount" DECIMAL(18,4),
    "signalInterval" DECIMAL(10,2),
    "position" INTEGER NOT NULL DEFAULT 0,
    "profileId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "archivedAt" TIMESTAMPTZ(3),

    CONSTRAINT "StationProfileVariation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "StationProfileVariation_profileId_idx" ON "StationProfileVariation"("profileId");

ALTER TABLE "StationProfileVariation"
  ADD CONSTRAINT "StationProfileVariation_profileId_fkey"
  FOREIGN KEY ("profileId") REFERENCES "StationProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "StationVersion" ADD COLUMN "variationId" UUID;

CREATE INDEX "StationVersion_variationId_idx" ON "StationVersion"("variationId");

ALTER TABLE "StationVersion"
  ADD CONSTRAINT "StationVersion_variationId_fkey"
  FOREIGN KEY ("variationId") REFERENCES "StationProfileVariation"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- ── 1. One variation per profile, holding what the profile held ──────────

INSERT INTO "StationProfileVariation"
  ("id", "name", "description", "signalAmount", "signalInterval", "position", "profileId", "createdAt", "updatedAt")
SELECT gen_random_uuid(), '', p."description", p."signalAmount", p."signalInterval", 0, p."id", p."createdAt", CURRENT_TIMESTAMP
FROM "StationProfile" p;

-- ── 2. Every station version on a profile follows its one variation ──────
-- All versions, not just current ones, so history reads the same way.

UPDATE "StationVersion" sv
SET "variationId" = v."id"
FROM "StationProfileVariation" v
WHERE v."profileId" = sv."profileId";

-- ── 3. The profile no longer holds them ──────────────────────────────────

ALTER TABLE "StationProfile" DROP COLUMN "description";
ALTER TABLE "StationProfile" DROP COLUMN "signalAmount";
ALTER TABLE "StationProfile" DROP COLUMN "signalInterval";

-- ── 4. Check ─────────────────────────────────────────────────────────────

DO $$
DECLARE
  missing INTEGER;
  unmatched INTEGER;
BEGIN
  SELECT count(*) INTO missing
  FROM "StationProfile" p
  WHERE NOT EXISTS (SELECT 1 FROM "StationProfileVariation" v WHERE v."profileId" = p."id");
  IF missing > 0 THEN
    RAISE EXCEPTION 'station_profile_variations: % profile(s) without a variation', missing;
  END IF;

  SELECT count(*) INTO unmatched
  FROM "StationVersion" sv
  LEFT JOIN "StationProfileVariation" v ON v."id" = sv."variationId"
  WHERE (sv."profileId" IS NULL) <> (sv."variationId" IS NULL)
     OR (sv."variationId" IS NOT NULL AND v."profileId" <> sv."profileId");
  IF unmatched > 0 THEN
    RAISE EXCEPTION 'station_profile_variations: % station version(s) whose variation does not match their profile', unmatched;
  END IF;
END $$;

COMMIT;
