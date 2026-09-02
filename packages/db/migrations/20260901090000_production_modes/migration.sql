-- CreateTable
CREATE TABLE "ProductionMode" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "scrapAll" BOOLEAN NOT NULL DEFAULT false,
    "itemDispositionId" UUID,
    "dispositionReasonId" UUID,
    "statusReasonId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "archivedAt" TIMESTAMPTZ(3),
    "siteId" UUID NOT NULL,

    CONSTRAINT "ProductionMode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StationModeLog" (
    "id" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "stationId" UUID NOT NULL,
    "modeId" UUID NOT NULL,
    "startTime" TIMESTAMPTZ(3) NOT NULL,
    "endTime" TIMESTAMPTZ(3),
    "startedByEmployeeId" UUID,
    "endedByEmployeeId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "StationModeLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_ProductionModeRoles" (
    "A" UUID NOT NULL,
    "B" UUID NOT NULL,

    CONSTRAINT "_ProductionModeRoles_AB_pkey" PRIMARY KEY ("A","B")
);

-- AlterTable
ALTER TABLE "ItemDisposition" ADD COLUMN "isSystem" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Cycle" ADD COLUMN "modeId" UUID;

-- AlterTable
ALTER TABLE "InventoryItem" ADD COLUMN "modeId" UUID;

-- AlterTable
ALTER TABLE "ItemDispositionLog" ADD COLUMN "modeId" UUID;

-- AlterTable: widen scrap quantity to match InventoryItem.quantity so
-- continuous-mode fractional quantities scrap exactly (lossless: int → numeric).
ALTER TABLE "ItemDispositionLog" ALTER COLUMN "quantity" SET DATA TYPE DECIMAL(18,4),
ALTER COLUMN "quantity" SET DEFAULT 1;

-- AlterTable
ALTER TABLE "StationStateLog" ADD COLUMN "modeId" UUID;

-- CreateIndex
CREATE INDEX "ProductionMode_siteId_idx" ON "ProductionMode"("siteId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductionMode_siteId_name_key" ON "ProductionMode"("siteId", "name");

-- CreateIndex
CREATE INDEX "StationModeLog_stationId_startTime_idx" ON "StationModeLog"("stationId", "startTime");

-- CreateIndex
CREATE INDEX "StationModeLog_stationId_endTime_idx" ON "StationModeLog"("stationId", "endTime");

-- CreateIndex
CREATE INDEX "StationModeLog_siteId_idx" ON "StationModeLog"("siteId");

-- CreateIndex
CREATE INDEX "StationModeLog_modeId_idx" ON "StationModeLog"("modeId");

-- CreateIndex
CREATE INDEX "_ProductionModeRoles_B_index" ON "_ProductionModeRoles"("B");

-- CreateIndex
CREATE INDEX "Cycle_modeId_idx" ON "Cycle"("modeId");

-- CreateIndex
CREATE INDEX "ItemDispositionLog_modeId_idx" ON "ItemDispositionLog"("modeId");

-- AddForeignKey
ALTER TABLE "ProductionMode" ADD CONSTRAINT "ProductionMode_itemDispositionId_fkey" FOREIGN KEY ("itemDispositionId") REFERENCES "ItemDisposition"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductionMode" ADD CONSTRAINT "ProductionMode_dispositionReasonId_fkey" FOREIGN KEY ("dispositionReasonId") REFERENCES "ItemDispositionReason"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductionMode" ADD CONSTRAINT "ProductionMode_statusReasonId_fkey" FOREIGN KEY ("statusReasonId") REFERENCES "StatusReason"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductionMode" ADD CONSTRAINT "ProductionMode_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationModeLog" ADD CONSTRAINT "StationModeLog_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationModeLog" ADD CONSTRAINT "StationModeLog_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "Station"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationModeLog" ADD CONSTRAINT "StationModeLog_modeId_fkey" FOREIGN KEY ("modeId") REFERENCES "ProductionMode"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationModeLog" ADD CONSTRAINT "StationModeLog_startedByEmployeeId_fkey" FOREIGN KEY ("startedByEmployeeId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationModeLog" ADD CONSTRAINT "StationModeLog_endedByEmployeeId_fkey" FOREIGN KEY ("endedByEmployeeId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_ProductionModeRoles" ADD CONSTRAINT "_ProductionModeRoles_A_fkey" FOREIGN KEY ("A") REFERENCES "EmployeeRole"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_ProductionModeRoles" ADD CONSTRAINT "_ProductionModeRoles_B_fkey" FOREIGN KEY ("B") REFERENCES "ProductionMode"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Cycle" ADD CONSTRAINT "Cycle_modeId_fkey" FOREIGN KEY ("modeId") REFERENCES "ProductionMode"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_modeId_fkey" FOREIGN KEY ("modeId") REFERENCES "ProductionMode"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemDispositionLog" ADD CONSTRAINT "ItemDispositionLog_modeId_fkey" FOREIGN KEY ("modeId") REFERENCES "ProductionMode"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationStateLog" ADD CONSTRAINT "StationStateLog_modeId_fkey" FOREIGN KEY ("modeId") REFERENCES "ProductionMode"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Hand-written (not representable in the Prisma schema): at most one open
-- mode log entry per station. Forcing while forced switches modes by closing
-- the open entry; this index backstops the race window.
CREATE UNIQUE INDEX "StationModeLog_stationId_open_unique"
  ON "StationModeLog"("stationId")
  WHERE "endTime" IS NULL;

-- Hand-written: at most one system (protected "Scrap") disposition per site —
-- scrap-all production modes resolve it by this flag.
CREATE UNIQUE INDEX "ItemDisposition_siteId_system_unique"
  ON "ItemDisposition"("siteId")
  WHERE "isSystem";
