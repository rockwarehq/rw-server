-- Manual stock reconciliation: append-only adjustment ledger backing
-- ProductStock.adjustment, which becomes a rebuildable fact aggregate like
-- produced/scrapped/consumed. No backfill: the adjustment column has never
-- been written, so SUM(deltas) = 0 = adjustment holds from day one.

-- CreateEnum
CREATE TYPE "StockAdjustmentReason" AS ENUM ('CYCLE_COUNT', 'DAMAGE', 'FOUND', 'INITIAL', 'OTHER');

-- CreateTable
CREATE TABLE "ProductStockAdjustment" (
    "id" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "delta" DECIMAL(18,4) NOT NULL,
    "resultingOnHand" DECIMAL(18,4) NOT NULL,
    "reason" "StockAdjustmentReason" NOT NULL,
    "note" TEXT,
    "performedByUserId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductStockAdjustment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProductStockAdjustment_siteId_productId_createdAt_idx" ON "ProductStockAdjustment"("siteId", "productId", "createdAt");

-- CreateIndex
CREATE INDEX "ProductStockAdjustment_siteId_createdAt_idx" ON "ProductStockAdjustment"("siteId", "createdAt");

-- AddForeignKey
ALTER TABLE "ProductStockAdjustment" ADD CONSTRAINT "ProductStockAdjustment_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductStockAdjustment" ADD CONSTRAINT "ProductStockAdjustment_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductStockAdjustment" ADD CONSTRAINT "ProductStockAdjustment_performedByUserId_fkey" FOREIGN KEY ("performedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
