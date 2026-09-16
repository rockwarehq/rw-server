-- AlterTable
ALTER TABLE "Call" ADD COLUMN     "isScheduled" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "Cycle" ADD COLUMN     "isScheduled" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "StationLogonSession" ADD COLUMN     "isScheduled" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "ProductStockAdjustment" ADD COLUMN     "isScheduled" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "OrderConsumption" ADD COLUMN     "isScheduled" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "InventoryItem" ADD COLUMN     "isScheduled" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "ItemDispositionLog" ADD COLUMN     "isScheduled" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "MaterialLedgerEntry" ADD COLUMN     "isScheduled" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "MaterialShiftUsage" ADD COLUMN     "isScheduled" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "MetricBucket" ADD COLUMN     "isScheduled" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "MetricBucketLog" ADD COLUMN     "isScheduled" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "StationModeLog" ADD COLUMN     "isScheduled" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "StationStateLog" ADD COLUMN     "isScheduled" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "StationJobLog" ADD COLUMN     "isScheduled" BOOLEAN NOT NULL DEFAULT true;


-- Backfill: facts stamped with an unscheduled shift instance carry the flag (ADR-0015).
UPDATE "Cycle" f SET "isScheduled" = false FROM "ShiftInstance" si WHERE si.id = f."shiftInstanceId" AND si."isScheduled" = false;
UPDATE "InventoryItem" f SET "isScheduled" = false FROM "ShiftInstance" si WHERE si.id = f."shiftInstanceId" AND si."isScheduled" = false;
UPDATE "ItemDispositionLog" f SET "isScheduled" = false FROM "ShiftInstance" si WHERE si.id = f."shiftInstanceId" AND si."isScheduled" = false;
UPDATE "Call" f SET "isScheduled" = false FROM "ShiftInstance" si WHERE si.id = f."shiftInstanceId" AND si."isScheduled" = false;
UPDATE "StationModeLog" f SET "isScheduled" = false FROM "ShiftInstance" si WHERE si.id = f."shiftInstanceId" AND si."isScheduled" = false;
UPDATE "StationLogonSession" f SET "isScheduled" = false FROM "ShiftInstance" si WHERE si.id = f."shiftInstanceId" AND si."isScheduled" = false;
UPDATE "StationStateLog" f SET "isScheduled" = false FROM "ShiftInstance" si WHERE si.id = f."shiftInstanceId" AND si."isScheduled" = false;
UPDATE "StationJobLog" f SET "isScheduled" = false FROM "ShiftInstance" si WHERE si.id = f."shiftInstanceId" AND si."isScheduled" = false;
UPDATE "MaterialLedgerEntry" f SET "isScheduled" = false FROM "ShiftInstance" si WHERE si.id = f."shiftInstanceId" AND si."isScheduled" = false;
UPDATE "OrderConsumption" f SET "isScheduled" = false FROM "ShiftInstance" si WHERE si.id = f."shiftInstanceId" AND si."isScheduled" = false;
UPDATE "ProductStockAdjustment" f SET "isScheduled" = false FROM "ShiftInstance" si WHERE si.id = f."shiftInstanceId" AND si."isScheduled" = false;
UPDATE "MaterialShiftUsage" f SET "isScheduled" = false FROM "ShiftInstance" si WHERE si.id = f."shiftInstanceId" AND si."isScheduled" = false;
UPDATE "MetricBucket" f SET "isScheduled" = false FROM "ShiftInstance" si WHERE si.id = f."shiftInstanceId" AND si."isScheduled" = false;
UPDATE "MetricBucketLog" f SET "isScheduled" = false FROM "ShiftInstance" si WHERE si.id = f."shiftInstanceId" AND si."isScheduled" = false;
