-- Gap rows (no definition, not scheduled) are named "Off Hours".
UPDATE "ShiftInstance" SET "shiftName" = 'Off Hours'
WHERE "definitionId" IS NULL AND "isScheduled" = false AND "shiftName" = 'Not Scheduled';
