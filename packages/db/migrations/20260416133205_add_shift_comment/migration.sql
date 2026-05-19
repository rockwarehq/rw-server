-- CreateTable
CREATE TABLE "ShiftComment" (
    "id" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "shiftInstanceId" UUID NOT NULL,
    "workcenterId" UUID NOT NULL,
    "stationId" UUID,
    "text" TEXT NOT NULL,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "ShiftComment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ShiftComment_shiftInstanceId_idx" ON "ShiftComment"("shiftInstanceId");

-- CreateIndex
CREATE INDEX "ShiftComment_shiftInstanceId_stationId_idx" ON "ShiftComment"("shiftInstanceId", "stationId");

-- CreateIndex
CREATE INDEX "ShiftComment_stationId_idx" ON "ShiftComment"("stationId");

-- AddForeignKey
ALTER TABLE "ShiftComment" ADD CONSTRAINT "ShiftComment_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftComment" ADD CONSTRAINT "ShiftComment_shiftInstanceId_fkey" FOREIGN KEY ("shiftInstanceId") REFERENCES "ShiftInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftComment" ADD CONSTRAINT "ShiftComment_workcenterId_fkey" FOREIGN KEY ("workcenterId") REFERENCES "Workcenter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftComment" ADD CONSTRAINT "ShiftComment_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "Station"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftComment" ADD CONSTRAINT "ShiftComment_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
