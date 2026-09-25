-- Preflight for migration 20261004100000_station_profiles (ADR-0017).
-- Read-only. Run it on a copy of production before the migration:
--   psql "$DATABASE_URL" -f packages/db/scripts/preflight-station-profiles.sql
-- Each section is a list a person should look at. Empty is good.

\echo '== 1. Profiles the migration will make (one per counting setup, per site)'
SELECT si.name AS site, sv."cycleMode", sv."quantityUnit",
       CASE WHEN sv."cycleMode" = 'QUANTITY_PER_CYCLE' THEN sv."standardQuantity" END AS "amountPerSignal",
       CASE WHEN sv."cycleMode" = 'QUANTITY_PER_INTERVAL' THEN sv."standardCycle" END AS "reportEverySeconds",
       COUNT(*) AS stations
FROM "Station" s
JOIN "Site" si ON si.id = s."siteId"
JOIN "StationVersion" sv ON sv.id = s."currentVersionId"
WHERE s."deletedAt" IS NULL
GROUP BY 1, 2, 3, 4, 5
ORDER BY 1, 2, 3;

\echo '== 2. Live stations with no settings at all (they get no profile until edited)'
SELECT si.name AS site, s.name AS station
FROM "Station" s JOIN "Site" si ON si.id = s."siteId"
WHERE s."deletedAt" IS NULL AND s."currentVersionId" IS NULL
ORDER BY 1, 2;

\echo '== 3. Jobs that ran on stations that count in different ways (a person picks the profile)'
SELECT jv.name AS job, STRING_AGG(DISTINCT sv."cycleMode"::text || ' ' || sv."quantityUnit", ', ') AS kinds
FROM "StationJobLog" l
JOIN "Job" j ON j.id = l."jobId" AND j."deletedAt" IS NULL
JOIN "JobVersion" jv ON jv.id = j."currentVersionId"
JOIN "Station" s ON s.id = l."stationId"
JOIN "StationVersion" sv ON sv.id = s."currentVersionId"
GROUP BY jv.name
HAVING COUNT(DISTINCT sv."cycleMode") > 1
ORDER BY 1;

\echo '== 4. Jobs that never ran (they stay without a profile; pick one on the job page)'
SELECT jv.name AS job
FROM "Job" j JOIN "JobVersion" jv ON jv.id = j."currentVersionId"
WHERE j."deletedAt" IS NULL
  AND NOT EXISTS (SELECT 1 FROM "StationJobLog" l WHERE l."jobId" = j.id)
ORDER BY 1;

\echo '== 5. BEHAVIOUR CHANGE: jobs that override the amount per signal (no longer used)'
SELECT jv.name AS job, jv."standardQuantity"
FROM "Job" j JOIN "JobVersion" jv ON jv.id = j."currentVersionId"
WHERE j."deletedAt" IS NULL AND jv."standardQuantity" IS NOT NULL
ORDER BY 1;

\echo '== 6. BEHAVIOUR CHANGE: jobs running on a Count-by-time station whose own seconds set the report interval (no longer used)'
SELECT jv.name AS job, s.name AS station, jv."standardCycle" AS "jobSeconds", sv."standardCycle" AS "stationSeconds"
FROM "Station" s
JOIN "StationVersion" sv ON sv.id = s."currentVersionId"
JOIN "Job" j ON j.id = s."currentJobId"
JOIN "JobVersion" jv ON jv.id = j."currentVersionId"
WHERE s."deletedAt" IS NULL
  AND sv."cycleMode" = 'QUANTITY_PER_INTERVAL'
  AND jv."standardCycle" IS NOT NULL
  AND jv."standardCycle" IS DISTINCT FROM sv."standardCycle"
ORDER BY 1, 2;

\echo '== 7. Count-by-time stations whose "expected per report" becomes a rate per minute'
SELECT s.name AS station, sv."standardQuantity" AS "expectedPerReport", sv."standardCycle" AS "reportEverySeconds",
       ROUND(sv."standardQuantity" * 60 / sv."standardCycle", 4) AS "newRatePerMinute"
FROM "Station" s JOIN "StationVersion" sv ON sv.id = s."currentVersionId"
WHERE s."deletedAt" IS NULL
  AND sv."cycleMode" = 'QUANTITY_PER_INTERVAL'
  AND sv."standardRate" IS NULL AND sv."standardQuantity" > 0 AND sv."standardCycle" > 0
ORDER BY 1;
