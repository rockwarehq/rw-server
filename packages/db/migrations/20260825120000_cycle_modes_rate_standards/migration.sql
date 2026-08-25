-- CreateEnum
CREATE TYPE "RatePeriod" AS ENUM ('SECOND', 'MINUTE', 'HOUR');

-- CreateEnum
CREATE TYPE "CycleMode" AS ENUM ('DISCRETE', 'QUANTITY_PER_CYCLE', 'QUANTITY_PER_INTERVAL');

-- AlterTable
ALTER TABLE "Cycle" ADD COLUMN     "quantity" DECIMAL(18,4),
ADD COLUMN     "quantityUnit" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "standardCycle" DECIMAL(10,2),
ADD COLUMN     "standardQuantity" DECIMAL(18,4);

-- AlterTable
ALTER TABLE "Order" ALTER COLUMN "defaultTargetQuantity" SET DEFAULT 1,
ALTER COLUMN "defaultTargetQuantity" SET DATA TYPE DECIMAL(18,4);

-- AlterTable
ALTER TABLE "OrderLineItem" ALTER COLUMN "targetQuantity" SET DATA TYPE DECIMAL(18,4),
ALTER COLUMN "completedQuantity" SET DEFAULT 0,
ALTER COLUMN "completedQuantity" SET DATA TYPE DECIMAL(18,4),
ALTER COLUMN "scrapQuantity" SET DEFAULT 0,
ALTER COLUMN "scrapQuantity" SET DATA TYPE DECIMAL(18,4);

-- AlterTable
ALTER TABLE "OrderInventoryAllocation" ALTER COLUMN "quantity" SET DEFAULT 1,
ALTER COLUMN "quantity" SET DATA TYPE DECIMAL(18,4);

-- AlterTable
ALTER TABLE "JobVersion" ADD COLUMN     "standardQuantity" DECIMAL(18,4),
ADD COLUMN     "standardRate" DECIMAL(18,4),
ADD COLUMN     "standardRatePeriod" "RatePeriod" NOT NULL DEFAULT 'MINUTE',
ADD COLUMN     "standardRateUnit" TEXT NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE "StationVersion" ADD COLUMN     "cycleMode" "CycleMode" NOT NULL DEFAULT 'DISCRETE',
ADD COLUMN     "quantityUnit" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "standardQuantity" DECIMAL(18,4),
ADD COLUMN     "standardRate" DECIMAL(18,4),
ADD COLUMN     "standardRatePeriod" "RatePeriod" NOT NULL DEFAULT 'MINUTE',
ADD COLUMN     "standardRateUnit" TEXT NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE "StationJobLog" ADD COLUMN     "quantityUnit" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "standardQuantity" DECIMAL(18,4);

