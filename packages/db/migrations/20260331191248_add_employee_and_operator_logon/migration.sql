-- CreateEnum
CREATE TYPE "EmployeeStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "EmployeeRole" AS ENUM ('OPERATOR', 'SUPERVISOR', 'LEAD');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'OPERATOR_LOGON';
ALTER TYPE "AuditAction" ADD VALUE 'OPERATOR_LOGOFF';
ALTER TYPE "AuditAction" ADD VALUE 'OPERATOR_LOGON_FAILED';
ALTER TYPE "AuditAction" ADD VALUE 'OPERATOR_SUPERVISOR_CHALLENGE';
ALTER TYPE "AuditAction" ADD VALUE 'OPERATOR_SUPERVISOR_CHALLENGE_FAILED';

-- CreateTable
CREATE TABLE "Employee" (
    "id" UUID NOT NULL,
    "employeeNumber" TEXT NOT NULL,
    "username" TEXT,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "status" "EmployeeStatus" NOT NULL DEFAULT 'ACTIVE',
    "siteId" UUID NOT NULL,
    "currentBlobId" UUID,
    "failedLoginAttempts" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Employee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmployeeBlob" (
    "id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "role" "EmployeeRole" NOT NULL DEFAULT 'OPERATOR',
    "passwordHash" TEXT,
    "pinHash" TEXT,
    "badgeNumber" TEXT,
    "employeeId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmployeeBlob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StationLogonSession" (
    "id" UUID NOT NULL,
    "employeeId" UUID,
    "employeeBlobId" UUID,
    "stationId" UUID NOT NULL,
    "displayId" UUID NOT NULL,
    "genericName" TEXT,
    "logonMethod" TEXT NOT NULL,
    "logonTime" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "logoffTime" TIMESTAMPTZ(3),
    "shiftInstanceId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "StationLogonSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Employee_currentBlobId_key" ON "Employee"("currentBlobId");

-- CreateIndex
CREATE INDEX "Employee_siteId_status_idx" ON "Employee"("siteId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Employee_siteId_employeeNumber_key" ON "Employee"("siteId", "employeeNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Employee_siteId_username_key" ON "Employee"("siteId", "username");

-- CreateIndex
CREATE INDEX "EmployeeBlob_employeeId_idx" ON "EmployeeBlob"("employeeId");

-- CreateIndex
CREATE INDEX "EmployeeBlob_badgeNumber_idx" ON "EmployeeBlob"("badgeNumber");

-- CreateIndex
CREATE UNIQUE INDEX "EmployeeBlob_employeeId_version_key" ON "EmployeeBlob"("employeeId", "version");

-- CreateIndex
CREATE INDEX "StationLogonSession_stationId_logoffTime_idx" ON "StationLogonSession"("stationId", "logoffTime");

-- CreateIndex
CREATE INDEX "StationLogonSession_employeeId_idx" ON "StationLogonSession"("employeeId");

-- CreateIndex
CREATE INDEX "StationLogonSession_displayId_idx" ON "StationLogonSession"("displayId");

-- CreateIndex
CREATE INDEX "Cycle_siteId_deletedAt_end_idx" ON "Cycle"("siteId", "deletedAt", "end");

-- CreateIndex
CREATE INDEX "Cycle_stationId_deletedAt_end_idx" ON "Cycle"("stationId", "deletedAt", "end");

-- CreateIndex
CREATE INDEX "InventoryItem_cycleId_deletedAt_idx" ON "InventoryItem"("cycleId", "deletedAt");

-- AddForeignKey
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_currentBlobId_fkey" FOREIGN KEY ("currentBlobId") REFERENCES "EmployeeBlob"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeBlob" ADD CONSTRAINT "EmployeeBlob_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationLogonSession" ADD CONSTRAINT "StationLogonSession_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationLogonSession" ADD CONSTRAINT "StationLogonSession_employeeBlobId_fkey" FOREIGN KEY ("employeeBlobId") REFERENCES "EmployeeBlob"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationLogonSession" ADD CONSTRAINT "StationLogonSession_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "Station"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationLogonSession" ADD CONSTRAINT "StationLogonSession_displayId_fkey" FOREIGN KEY ("displayId") REFERENCES "Display"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationLogonSession" ADD CONSTRAINT "StationLogonSession_shiftInstanceId_fkey" FOREIGN KEY ("shiftInstanceId") REFERENCES "ShiftInstance"("id") ON DELETE SET NULL ON UPDATE CASCADE;
