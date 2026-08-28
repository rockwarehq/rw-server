-- Inventory-first orders: replace the automatic allocation engine with an
-- on-hand ProductStock aggregate + durable OrderConsumption records written at
-- order completion. OrderInventoryAllocation and the OrderLineItem counters
-- (completedQuantity/scrapQuantity/status) are frozen in place — no further
-- writes — and will be dropped in a later cleanup migration.

-- CreateEnum
CREATE TYPE "ConsumptionSource" AS ENUM ('MANUAL', 'AUTO', 'BACKFILL');

-- CreateTable
CREATE TABLE "ProductStock" (
    "siteId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "produced" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "scrapped" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "consumed" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "adjustment" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ProductStock_pkey" PRIMARY KEY ("siteId","productId")
);

-- CreateTable
CREATE TABLE "OrderConsumption" (
    "id" UUID NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "source" "ConsumptionSource" NOT NULL,
    "siteId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "orderLineItemId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "createdByUserId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderConsumption_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrderConsumption_orderId_idx" ON "OrderConsumption"("orderId");

-- CreateIndex
CREATE INDEX "OrderConsumption_siteId_productId_idx" ON "OrderConsumption"("siteId", "productId");

-- CreateIndex
CREATE INDEX "ItemDispositionLog_siteId_productVersionId_idx" ON "ItemDispositionLog"("siteId", "productVersionId");

-- AddForeignKey
ALTER TABLE "ProductStock" ADD CONSTRAINT "ProductStock_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductStock" ADD CONSTRAINT "ProductStock_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderConsumption" ADD CONSTRAINT "OrderConsumption_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderConsumption" ADD CONSTRAINT "OrderConsumption_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderConsumption" ADD CONSTRAINT "OrderConsumption_orderLineItemId_fkey" FOREIGN KEY ("orderLineItemId") REFERENCES "OrderLineItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderConsumption" ADD CONSTRAINT "OrderConsumption_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Backfill 1: OrderConsumption from legacy allocation history.
-- COMPLETED orders really used their allocated stock; convert net good
-- quantity (capped at target — spill over-allocation returns to stock) into
-- BACKFILL consumption rows stamped at the order's completion time.
-- ---------------------------------------------------------------------------
INSERT INTO "OrderConsumption" ("id", "quantity", "source", "siteId", "orderId", "orderLineItemId", "productId", "createdAt")
SELECT gen_random_uuid(),
       LEAST(oli."targetQuantity", GREATEST(oli."completedQuantity" - oli."scrapQuantity", 0)),
       'BACKFILL',
       o."siteId",
       o."id",
       oli."id",
       oli."productId",
       o."updatedAt"
FROM "OrderLineItem" oli
JOIN "Order" o ON o."id" = oli."orderId"
WHERE o."status" = 'COMPLETED'
  AND o."deletedAt" IS NULL
  AND GREATEST(oli."completedQuantity" - oli."scrapQuantity", 0) > 0;

-- ---------------------------------------------------------------------------
-- Backfill 2: ProductStock from facts (same SQL as the re-derivation script).
-- produced: all InventoryItems (via Cycle for siteId, ProductVersion for productId)
-- scrapped: all ItemDispositionLog quantities
-- consumed: the OrderConsumption rows created above
-- ---------------------------------------------------------------------------
INSERT INTO "ProductStock" ("siteId", "productId", "produced", "scrapped", "consumed", "adjustment", "updatedAt")
SELECT COALESCE(p."siteId", s."siteId", c."siteId"),
       COALESCE(p."productId", s."productId", c."productId"),
       COALESCE(p."produced", 0),
       COALESCE(s."scrapped", 0),
       COALESCE(c."consumed", 0),
       0,
       NOW()
FROM (
    SELECT cy."siteId", pv."productId", SUM(ii."quantity") AS "produced"
    FROM "InventoryItem" ii
    JOIN "Cycle" cy ON cy."id" = ii."cycleId"
    JOIN "ProductVersion" pv ON pv."id" = ii."productVersionId"
    WHERE ii."deletedAt" IS NULL
    GROUP BY cy."siteId", pv."productId"
) p
FULL OUTER JOIN (
    SELECT idl."siteId", pv."productId", SUM(idl."quantity")::DECIMAL(18,4) AS "scrapped"
    FROM "ItemDispositionLog" idl
    JOIN "ProductVersion" pv ON pv."id" = idl."productVersionId"
    WHERE idl."deletedAt" IS NULL
    GROUP BY idl."siteId", pv."productId"
) s ON s."siteId" = p."siteId" AND s."productId" = p."productId"
FULL OUTER JOIN (
    SELECT oc."siteId", oc."productId", SUM(oc."quantity") AS "consumed"
    FROM "OrderConsumption" oc
    GROUP BY oc."siteId", oc."productId"
) c ON c."siteId" = COALESCE(p."siteId", s."siteId")
   AND c."productId" = COALESCE(p."productId", s."productId");
