-- AlterTable: Add sortOrder and startDayOffset to ShiftDefinition
ALTER TABLE "ShiftDefinition" ADD COLUMN "sortOrder" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "ShiftDefinition" ADD COLUMN "startDayOffset" INTEGER NOT NULL DEFAULT 0;

-- Remove sortOrder default so future inserts must provide a value.
ALTER TABLE "ShiftDefinition" ALTER COLUMN "sortOrder" DROP DEFAULT;

-- Unique constraint: no duplicate sort orders within a pattern's rotation day.
CREATE UNIQUE INDEX "ShiftDefinition_patternId_dayOfRotation_sortOrder_key"
    ON "ShiftDefinition"("patternId", "dayOfRotation", "sortOrder");

-- CreateTable: ShiftInstance — materialized shift windows for fast runtime queries.
-- workCenterId = NULL → site-level default. workCenterId = set → workcenter override.
CREATE TABLE "ShiftInstance" (
    "id" UUID NOT NULL,
    "assignmentId" UUID NOT NULL,
    "definitionId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "workCenterId" UUID,
    "shiftName" TEXT NOT NULL,
    "businessDate" DATE NOT NULL,
    "startTime" TIMESTAMP(3) NOT NULL,
    "endTime" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShiftInstance_pkey" PRIMARY KEY ("id")
);

-- Unique: one shift per assignment per start time.
CREATE UNIQUE INDEX "ShiftInstance_assignmentId_startTime_key"
    ON "ShiftInstance"("assignmentId", "startTime");

-- Index: workcenter-level timestamp range queries (find shift, split range).
CREATE INDEX "ShiftInstance_workCenterId_startTime_endTime_idx"
    ON "ShiftInstance"("workCenterId", "startTime", "endTime");

-- Index: site-level timestamp range queries (fallback when no workcenter override).
CREATE INDEX "ShiftInstance_siteId_startTime_endTime_idx"
    ON "ShiftInstance"("siteId", "startTime", "endTime");

-- Index: business date queries (site-wide).
CREATE INDEX "ShiftInstance_siteId_businessDate_idx"
    ON "ShiftInstance"("siteId", "businessDate");

-- Index: business date queries (workcenter-scoped).
CREATE INDEX "ShiftInstance_workCenterId_businessDate_idx"
    ON "ShiftInstance"("workCenterId", "businessDate");

-- Foreign keys
ALTER TABLE "ShiftInstance"
    ADD CONSTRAINT "ShiftInstance_assignmentId_fkey"
    FOREIGN KEY ("assignmentId") REFERENCES "ShiftAssignment"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ShiftInstance"
    ADD CONSTRAINT "ShiftInstance_definitionId_fkey"
    FOREIGN KEY ("definitionId") REFERENCES "ShiftDefinition"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ShiftInstance"
    ADD CONSTRAINT "ShiftInstance_siteId_fkey"
    FOREIGN KEY ("siteId") REFERENCES "Site"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ShiftInstance"
    ADD CONSTRAINT "ShiftInstance_workCenterId_fkey"
    FOREIGN KEY ("workCenterId") REFERENCES "Workcenter"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
