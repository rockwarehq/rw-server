-- Undo is itself an amendment: it reverses the window an earlier one replaced.
-- Naming the amendment it undid marks both as history, so a corrected shift
-- that has been put back reads as planned again rather than staying "amended".
ALTER TABLE "ShiftAmendment" ADD COLUMN "undoOfId" UUID;

CREATE INDEX "ShiftAmendment_undoOfId_idx" ON "ShiftAmendment" ("undoOfId");
