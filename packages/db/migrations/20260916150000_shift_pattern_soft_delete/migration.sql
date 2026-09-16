-- A published pattern is never hard-deleted: its assignment anchors the
-- instances history is stamped on. Delete ends the assignment and sets this.
ALTER TABLE "ShiftPattern" ADD COLUMN "deletedAt" TIMESTAMPTZ(3);
