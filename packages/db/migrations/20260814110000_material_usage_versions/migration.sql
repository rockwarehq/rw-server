-- Material facts: conformed context + version snapshots.
-- MaterialShiftUsage gains workcenter/businessDate context plus
-- job/product/material version snapshots, stamped at row creation (first
-- contribution wins — a mid-shift re-version keeps the shift's opening
-- snapshot). MaterialLedgerEntry gains businessDate and a materialVersionId
-- snapshot that freezes the unit/cost validation basis at entry time.
-- All columns nullable: legacy rows get context (businessDate/workcenter/
-- jobVersion) from the batched backfill (scripts/backfill-material-context.sql);
-- version snapshots on legacy rows stay NULL by design — backfilling with
-- current versions would falsify history.
-- NOTE: authored by hand; review before deploy. Do NOT run backfills here.

-- AlterTable
ALTER TABLE "MaterialShiftUsage" ADD COLUMN     "workcenterId" UUID,
ADD COLUMN     "businessDate" DATE,
ADD COLUMN     "jobVersionId" UUID,
ADD COLUMN     "productVersionId" UUID,
ADD COLUMN     "materialVersionId" UUID;

-- AlterTable
ALTER TABLE "MaterialLedgerEntry" ADD COLUMN     "materialVersionId" UUID,
ADD COLUMN     "businessDate" DATE;

-- CreateIndex
CREATE INDEX "MaterialShiftUsage_siteId_businessDate_idx" ON "MaterialShiftUsage"("siteId", "businessDate");

-- AddForeignKey
ALTER TABLE "MaterialShiftUsage" ADD CONSTRAINT "MaterialShiftUsage_workcenterId_fkey" FOREIGN KEY ("workcenterId") REFERENCES "Workcenter"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaterialShiftUsage" ADD CONSTRAINT "MaterialShiftUsage_jobVersionId_fkey" FOREIGN KEY ("jobVersionId") REFERENCES "JobVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaterialShiftUsage" ADD CONSTRAINT "MaterialShiftUsage_productVersionId_fkey" FOREIGN KEY ("productVersionId") REFERENCES "ProductVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaterialShiftUsage" ADD CONSTRAINT "MaterialShiftUsage_materialVersionId_fkey" FOREIGN KEY ("materialVersionId") REFERENCES "MaterialVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaterialLedgerEntry" ADD CONSTRAINT "MaterialLedgerEntry_materialVersionId_fkey" FOREIGN KEY ("materialVersionId") REFERENCES "MaterialVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;
