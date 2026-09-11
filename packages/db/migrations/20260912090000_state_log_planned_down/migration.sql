-- Planned-downtime flag stamped on each state period (editable per period).
ALTER TABLE "StationStateLog" ADD COLUMN "isPlannedDown" BOOLEAN NOT NULL DEFAULT false;

UPDATE "StationStateLog" ssl
SET "isPlannedDown" = sr."isPlannedDown"
FROM "StatusReason" sr
WHERE sr.id = ssl."statusReasonId" AND sr."isPlannedDown" = true;
