-- Fix orphaned open StationStateLog entries.
-- Due to race conditions between concurrent state transitions (cycle
-- completion vs slow/down timers), multiple entries with endTime IS NULL
-- can exist for the same station. Keep only the most recent open entry
-- per station and close the rest.

-- Step 1: Close all orphaned open entries (keep newest per station).
-- For each station with multiple open entries, set endTime = startTime of
-- the next open entry (chronological close) for all but the newest.
WITH ranked AS (
  SELECT
    id,
    "stationId",
    "startTime",
    ROW_NUMBER() OVER (PARTITION BY "stationId" ORDER BY "startTime" DESC) AS rn
  FROM "StationStateLog"
  WHERE "endTime" IS NULL
    AND "deletedAt" IS NULL
),
to_close AS (
  SELECT r.id, COALESCE(
    -- Close at the startTime of the entry that came after this one
    (SELECT r2."startTime" FROM ranked r2
     WHERE r2."stationId" = r."stationId" AND r2.rn = r.rn - 1),
    -- Fallback: close at own startTime (shouldn't happen, but safe)
    r."startTime"
  ) AS close_at
  FROM ranked r
  WHERE r.rn > 1  -- all except the newest per station
)
UPDATE "StationStateLog"
SET "endTime" = to_close.close_at
FROM to_close
WHERE "StationStateLog".id = to_close.id;

-- Step 2: Add partial unique index to enforce at most one open entry
-- per station at the database level. Any future race condition will
-- result in a unique constraint violation instead of silent duplicates.
CREATE UNIQUE INDEX "StationStateLog_stationId_open_unique"
  ON "StationStateLog"("stationId")
  WHERE "endTime" IS NULL AND "deletedAt" IS NULL;
