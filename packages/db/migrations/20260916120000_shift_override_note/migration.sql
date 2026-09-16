-- The override/amendment label becomes a free-text note; a switched-off shift
-- keeps its own name instead of being renamed by the label.
ALTER TABLE "ShiftOverride" RENAME COLUMN "label" TO "note";
ALTER TABLE "ShiftAmendment" RENAME COLUMN "label" TO "note";

-- Rows already renamed by a label get their definition's name back.
UPDATE "ShiftInstance" si
SET "shiftName" = d."shiftName"
FROM "ShiftDefinition" d
WHERE si."definitionId" = d.id AND si."isScheduled" = false AND si."shiftName" <> d."shiftName";
