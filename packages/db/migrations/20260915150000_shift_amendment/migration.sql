-- CreateEnum
CREATE TYPE "ShiftAmendmentStatus" AS ENUM ('PENDING_REBUILD', 'APPLIED', 'FAILED');

-- CreateTable
CREATE TABLE "ShiftAmendment" (
    "id" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "workCenterId" UUID,
    "assignmentId" UUID NOT NULL,
    "businessDate" DATE NOT NULL,
    "shiftName" TEXT NOT NULL,
    "previousStartTime" TIMESTAMPTZ(3) NOT NULL,
    "previousEndTime" TIMESTAMPTZ(3) NOT NULL,
    "previousScheduled" BOOLEAN NOT NULL,
    "previousName" TEXT NOT NULL,
    "startTime" TIMESTAMPTZ(3),
    "endTime" TIMESTAMPTZ(3),
    "cancelled" BOOLEAN NOT NULL DEFAULT false,
    "label" TEXT,
    "windowStart" TIMESTAMPTZ(3) NOT NULL,
    "windowEnd" TIMESTAMPTZ(3) NOT NULL,
    "status" "ShiftAmendmentStatus" NOT NULL DEFAULT 'PENDING_REBUILD',
    "rebuildError" TEXT,
    "rebuiltAt" TIMESTAMPTZ(3),
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ShiftAmendment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ShiftAmendment_siteId_businessDate_idx" ON "ShiftAmendment"("siteId", "businessDate");

-- CreateIndex
CREATE INDEX "ShiftAmendment_workCenterId_businessDate_idx" ON "ShiftAmendment"("workCenterId", "businessDate");

-- CreateIndex
CREATE INDEX "ShiftAmendment_siteId_status_idx" ON "ShiftAmendment"("siteId", "status");

-- AddForeignKey
ALTER TABLE "ShiftAmendment" ADD CONSTRAINT "ShiftAmendment_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftAmendment" ADD CONSTRAINT "ShiftAmendment_workCenterId_fkey" FOREIGN KEY ("workCenterId") REFERENCES "Workcenter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftAmendment" ADD CONSTRAINT "ShiftAmendment_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "ShiftAssignment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftAmendment" ADD CONSTRAINT "ShiftAmendment_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

