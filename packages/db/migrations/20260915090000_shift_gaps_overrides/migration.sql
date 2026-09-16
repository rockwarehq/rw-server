-- DropForeignKey
ALTER TABLE "ShiftInstance" DROP CONSTRAINT "ShiftInstance_definitionId_fkey";

-- AlterTable
ALTER TABLE "ShiftInstance" ADD COLUMN     "isScheduled" BOOLEAN NOT NULL DEFAULT true,
ALTER COLUMN "definitionId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "ShiftOverride" (
    "id" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "workCenterId" UUID,
    "businessDate" DATE NOT NULL,
    "shiftName" TEXT,
    "startTime" TIMESTAMPTZ(3),
    "endTime" TIMESTAMPTZ(3),
    "cancelled" BOOLEAN NOT NULL DEFAULT false,
    "label" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ShiftOverride_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ShiftOverride_siteId_businessDate_idx" ON "ShiftOverride"("siteId", "businessDate");

-- CreateIndex
CREATE INDEX "ShiftOverride_workCenterId_businessDate_idx" ON "ShiftOverride"("workCenterId", "businessDate");

-- AddForeignKey
ALTER TABLE "ShiftInstance" ADD CONSTRAINT "ShiftInstance_definitionId_fkey" FOREIGN KEY ("definitionId") REFERENCES "ShiftDefinition"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftOverride" ADD CONSTRAINT "ShiftOverride_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftOverride" ADD CONSTRAINT "ShiftOverride_workCenterId_fkey" FOREIGN KEY ("workCenterId") REFERENCES "Workcenter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

