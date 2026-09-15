-- ShiftDefinition.startTime becomes site LOCAL wall-clock time (ADR-0015).
-- Rows were stored as UTC "HH:mm" and shown converted with the offset in force
-- today, so convert with that same offset: what users see does not change and
-- nothing already materialized moves. A shift that lands on the previous local
-- calendar day gets startDayOffset - 1 (the evening before the rotation day).
WITH conv AS (
  SELECT d.id,
         (((current_date::text || ' ' || d."startTime")::timestamp AT TIME ZONE 'UTC') AT TIME ZONE s.timezone) AS local_ts
  FROM "ShiftDefinition" d
  JOIN "ShiftPattern" p ON p.id = d."patternId"
  JOIN "Site" s ON s.id = p."siteId"
)
UPDATE "ShiftDefinition" d
SET "startTime"      = to_char(c.local_ts, 'HH24:MI'),
    "startDayOffset" = d."startDayOffset" + (c.local_ts::date - current_date)
FROM conv c
WHERE c.id = d.id;
