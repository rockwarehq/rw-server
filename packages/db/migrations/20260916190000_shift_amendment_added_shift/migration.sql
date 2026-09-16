-- An amendment that ADDS a shift to a day that already ran has no previous
-- window to record: the four "previous" columns describe the shift as it was,
-- and there was no shift. Undo reads them back: null means "remove the row".
ALTER TABLE "ShiftAmendment"
  ALTER COLUMN "previousStartTime" DROP NOT NULL,
  ALTER COLUMN "previousEndTime" DROP NOT NULL,
  ALTER COLUMN "previousScheduled" DROP NOT NULL,
  ALTER COLUMN "previousName" DROP NOT NULL;
