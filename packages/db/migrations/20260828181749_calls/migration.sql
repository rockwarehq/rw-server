-- CreateEnum
CREATE TYPE "CallSeverity" AS ENUM ('INFORMATION', 'ALERT', 'WARNING');

-- CreateEnum
CREATE TYPE "CallSource" AS ENUM ('MANUAL', 'SYSTEM');

-- CreateTable
CREATE TABLE "CallDefinition" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "severity" "CallSeverity" NOT NULL DEFAULT 'INFORMATION',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "archivedAt" TIMESTAMPTZ(3),
    "siteId" UUID NOT NULL,

    CONSTRAINT "CallDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Call" (
    "id" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "stationId" UUID NOT NULL,
    "definitionId" UUID NOT NULL,
    "severity" "CallSeverity" NOT NULL,
    "workcenterId" UUID,
    "jobId" UUID,
    "jobVersionId" UUID,
    "stationVersionId" UUID,
    "toolId" UUID,
    "productId" UUID,
    "toolVersionId" UUID,
    "productVersionId" UUID,
    "businessDate" DATE,
    "openedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMPTZ(3),
    "source" "CallSource" NOT NULL,
    "sourceType" TEXT,
    "sourceRef" TEXT,
    "message" TEXT,
    "openedByEmployeeId" UUID,
    "openedByEmployeeVersionId" UUID,
    "closedByEmployeeId" UUID,
    "closedByEmployeeVersionId" UUID,
    "closeMessage" TEXT,
    "shiftInstanceId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "Call_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CallDefinition_siteId_idx" ON "CallDefinition"("siteId");

-- CreateIndex
CREATE UNIQUE INDEX "CallDefinition_siteId_name_key" ON "CallDefinition"("siteId", "name");

-- CreateIndex
CREATE INDEX "Call_siteId_closedAt_idx" ON "Call"("siteId", "closedAt");

-- CreateIndex
CREATE INDEX "Call_siteId_businessDate_idx" ON "Call"("siteId", "businessDate");

-- CreateIndex
CREATE INDEX "Call_stationId_closedAt_idx" ON "Call"("stationId", "closedAt");

-- CreateIndex
CREATE INDEX "Call_stationId_openedAt_idx" ON "Call"("stationId", "openedAt");

-- CreateIndex
CREATE INDEX "Call_definitionId_idx" ON "Call"("definitionId");

-- CreateIndex
CREATE INDEX "Call_shiftInstanceId_idx" ON "Call"("shiftInstanceId");

-- CreateIndex
CREATE INDEX "Call_workcenterId_idx" ON "Call"("workcenterId");

-- CreateIndex
CREATE INDEX "Call_jobId_idx" ON "Call"("jobId");

-- CreateIndex
CREATE INDEX "Call_toolId_idx" ON "Call"("toolId");

-- CreateIndex
CREATE INDEX "Call_productId_idx" ON "Call"("productId");

-- AddForeignKey
ALTER TABLE "CallDefinition" ADD CONSTRAINT "CallDefinition_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Call" ADD CONSTRAINT "Call_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Call" ADD CONSTRAINT "Call_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "Station"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Call" ADD CONSTRAINT "Call_definitionId_fkey" FOREIGN KEY ("definitionId") REFERENCES "CallDefinition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Call" ADD CONSTRAINT "Call_workcenterId_fkey" FOREIGN KEY ("workcenterId") REFERENCES "Workcenter"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Call" ADD CONSTRAINT "Call_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Call" ADD CONSTRAINT "Call_jobVersionId_fkey" FOREIGN KEY ("jobVersionId") REFERENCES "JobVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Call" ADD CONSTRAINT "Call_stationVersionId_fkey" FOREIGN KEY ("stationVersionId") REFERENCES "StationVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Call" ADD CONSTRAINT "Call_toolId_fkey" FOREIGN KEY ("toolId") REFERENCES "Tool"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Call" ADD CONSTRAINT "Call_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Call" ADD CONSTRAINT "Call_openedByEmployeeId_fkey" FOREIGN KEY ("openedByEmployeeId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Call" ADD CONSTRAINT "Call_closedByEmployeeId_fkey" FOREIGN KEY ("closedByEmployeeId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Call" ADD CONSTRAINT "Call_shiftInstanceId_fkey" FOREIGN KEY ("shiftInstanceId") REFERENCES "ShiftInstance"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Hand-written (not representable in the Prisma schema): at most one open call
-- per (station, definition). Re-opening while an instance is active returns
-- the existing call; this index backstops the race window.
CREATE UNIQUE INDEX "Call_stationId_definitionId_open_unique"
  ON "Call"("stationId", "definitionId")
  WHERE "closedAt" IS NULL AND "deletedAt" IS NULL;
