CREATE TYPE "ShiftCommentAuthorKind" AS ENUM ('UNKNOWN', 'USER', 'EMPLOYEE', 'DISPLAY');
CREATE TYPE "OperatorAssurance" AS ENUM ('TERMINAL', 'IDENTIFIED', 'VERIFIED', 'ACCOUNT');

ALTER TABLE "ShiftComment"
  ADD COLUMN "authorKind" "ShiftCommentAuthorKind" NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN "authorId" UUID,
  ADD COLUMN "authorEmployeeId" UUID,
  ADD COLUMN "authorDisplayId" UUID,
  ADD COLUMN "sourceDisplayId" UUID,
  ADD COLUMN "operatorSessionId" UUID,
  ADD COLUMN "authorEmployeeVersionId" UUID,
  ADD COLUMN "authorAssurance" "OperatorAssurance",
  ADD COLUMN "deletedById" UUID;

-- Existing attribution is historical fact, not evidence of PIN verification.
UPDATE "ShiftComment" SET "authorKind" = 'USER', "authorId" = "createdById"
WHERE "createdById" IS NOT NULL;

ALTER TABLE "ShiftComment"
  ADD CONSTRAINT "ShiftComment_authorEmployeeId_fkey" FOREIGN KEY ("authorEmployeeId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "ShiftComment_authorDisplayId_fkey" FOREIGN KEY ("authorDisplayId") REFERENCES "Display"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "ShiftComment_sourceDisplayId_fkey" FOREIGN KEY ("sourceDisplayId") REFERENCES "Display"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "ShiftComment_deletedById_fkey" FOREIGN KEY ("deletedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ShiftComment_author_identity_check" CHECK (("authorKind" = 'UNKNOWN' AND "authorId" IS NULL) OR ("authorKind" <> 'UNKNOWN' AND "authorId" IS NOT NULL));

CREATE INDEX "ShiftComment_authorKind_authorId_idx" ON "ShiftComment"("authorKind", "authorId");
CREATE INDEX "ShiftComment_sourceDisplayId_idx" ON "ShiftComment"("sourceDisplayId");

-- Deleting a station must never silently turn a station-fixed device into a site-free device.
ALTER TABLE "Display" DROP CONSTRAINT "Display_stationId_fkey";
ALTER TABLE "Display" ADD CONSTRAINT "Display_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "Station"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION "preserve_shift_comment_author"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- A captured employee link also identifies the person behind a USER author.
  -- Permit FK SET NULL on employee deletion, but never retarget or backfill it.
  IF NEW."authorEmployeeId" IS NOT NULL AND NEW."authorEmployeeId" IS DISTINCT FROM OLD."authorEmployeeId" THEN
    RAISE EXCEPTION 'Shift comment employee author identity is immutable';
  END IF;
  IF (NEW."authorKind", NEW."authorId", NEW."operatorSessionId", NEW."authorEmployeeVersionId", NEW."authorAssurance")
     IS DISTINCT FROM
     (OLD."authorKind", OLD."authorId", OLD."operatorSessionId", OLD."authorEmployeeVersionId", OLD."authorAssurance") THEN
    RAISE EXCEPTION 'Shift comment author identity and identification evidence are immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "ShiftComment_preserve_author" BEFORE UPDATE ON "ShiftComment"
FOR EACH ROW EXECUTE FUNCTION "preserve_shift_comment_author"();
