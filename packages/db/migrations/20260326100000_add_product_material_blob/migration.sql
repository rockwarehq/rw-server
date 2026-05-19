-- CreateTable
CREATE TABLE "ProductMaterialBlob" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "version" INTEGER NOT NULL,
    "weight" DECIMAL(10,2),
    "weightUnits" "WeightUnit",
    "itemCost" DECIMAL(10,2),
    "attrs" JSONB NOT NULL DEFAULT '{}',
    "productMaterialId" UUID NOT NULL,
    "materialBlobId" UUID NOT NULL,
    "productBlobId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductMaterialBlob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProductMaterialBlob_productMaterialId_version_key" ON "ProductMaterialBlob"("productMaterialId", "version");

-- CreateIndex
CREATE INDEX "ProductMaterialBlob_productMaterialId_idx" ON "ProductMaterialBlob"("productMaterialId");

-- AddForeignKey
ALTER TABLE "ProductMaterialBlob" ADD CONSTRAINT "ProductMaterialBlob_productMaterialId_fkey" FOREIGN KEY ("productMaterialId") REFERENCES "ProductMaterial"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductMaterialBlob" ADD CONSTRAINT "ProductMaterialBlob_materialBlobId_fkey" FOREIGN KEY ("materialBlobId") REFERENCES "MaterialBlob"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductMaterialBlob" ADD CONSTRAINT "ProductMaterialBlob_productBlobId_fkey" FOREIGN KEY ("productBlobId") REFERENCES "ProductBlob"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Add currentBlobId to ProductMaterial
ALTER TABLE "ProductMaterial" ADD COLUMN "currentBlobId" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "ProductMaterial_currentBlobId_key" ON "ProductMaterial"("currentBlobId");

-- AddForeignKey
ALTER TABLE "ProductMaterial" ADD CONSTRAINT "ProductMaterial_currentBlobId_fkey" FOREIGN KEY ("currentBlobId") REFERENCES "ProductMaterialBlob"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill: create ProductMaterialBlob v1 for every existing ProductMaterial
INSERT INTO "ProductMaterialBlob" ("id", "version", "weight", "weightUnits", "itemCost", "attrs", "productMaterialId", "materialBlobId", "productBlobId", "createdAt")
SELECT
    gen_random_uuid(),
    1,
    pm."weight",
    pm."weightUnits",
    pm."itemCost",
    pm."attrs",
    pm."id",
    m."currentBlobId",
    p."currentBlobId",
    pm."createdAt"
FROM "ProductMaterial" pm
JOIN "Material" m ON m."id" = pm."materialId"
JOIN "Product" p ON p."id" = pm."productId"
WHERE m."currentBlobId" IS NOT NULL
  AND p."currentBlobId" IS NOT NULL;

-- Backfill: set currentBlobId on ProductMaterial to the v1 blob we just created
UPDATE "ProductMaterial" pm
SET "currentBlobId" = pmb."id"
FROM "ProductMaterialBlob" pmb
WHERE pmb."productMaterialId" = pm."id"
  AND pmb."version" = 1;

-- Create implicit many-to-many join table for InventoryItem <-> ProductMaterialBlob
CREATE TABLE "_InventoryItemToProductMaterialBlob" (
    "A" UUID NOT NULL,
    "B" UUID NOT NULL,
    CONSTRAINT "_InventoryItemToProductMaterialBlob_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE INDEX "_InventoryItemToProductMaterialBlob_B_index" ON "_InventoryItemToProductMaterialBlob"("B");

-- AddForeignKey
ALTER TABLE "_InventoryItemToProductMaterialBlob" ADD CONSTRAINT "_InventoryItemToProductMaterialBlob_A_fkey" FOREIGN KEY ("A") REFERENCES "InventoryItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_InventoryItemToProductMaterialBlob" ADD CONSTRAINT "_InventoryItemToProductMaterialBlob_B_fkey" FOREIGN KEY ("B") REFERENCES "ProductMaterialBlob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: migrate existing InventoryItem <-> MaterialBlob links to ProductMaterialBlob
-- For each InventoryItem that was linked to a MaterialBlob, find the corresponding
-- ProductMaterialBlob (via the product on the inventory item and the material on the blob)
INSERT INTO "_InventoryItemToProductMaterialBlob" ("A", "B")
SELECT DISTINCT
    old_link."A",  -- InventoryItem id
    pmb."id"       -- ProductMaterialBlob id
FROM "_InventoryItemToMaterialBlob" old_link
JOIN "InventoryItem" ii ON ii."id" = old_link."A"
JOIN "MaterialBlob" mb ON mb."id" = old_link."B"
JOIN "ProductBlob" pb ON pb."id" = ii."productBlobId"
JOIN "ProductMaterial" pm ON pm."productId" = pb."productId" AND pm."materialId" = mb."materialId"
JOIN "ProductMaterialBlob" pmb ON pmb."productMaterialId" = pm."id"
WHERE pmb."version" = 1;

-- Create implicit many-to-many join table for ItemDispositionLog <-> ProductMaterialBlob
CREATE TABLE "_ItemDispositionLogToProductMaterialBlob" (
    "A" UUID NOT NULL,
    "B" UUID NOT NULL,
    CONSTRAINT "_ItemDispositionLogToProductMaterialBlob_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE INDEX "_ItemDispositionLogToProductMaterialBlob_B_index" ON "_ItemDispositionLogToProductMaterialBlob"("B");

-- AddForeignKey
ALTER TABLE "_ItemDispositionLogToProductMaterialBlob" ADD CONSTRAINT "_ItemDispositionLogToProductMaterialBlob_A_fkey" FOREIGN KEY ("A") REFERENCES "ItemDispositionLog"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_ItemDispositionLogToProductMaterialBlob" ADD CONSTRAINT "_ItemDispositionLogToProductMaterialBlob_B_fkey" FOREIGN KEY ("B") REFERENCES "ProductMaterialBlob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: migrate existing ItemDispositionLog <-> MaterialBlob links (same pattern)
INSERT INTO "_ItemDispositionLogToProductMaterialBlob" ("A", "B")
SELECT DISTINCT
    old_link."A",
    pmb."id"
FROM "_ItemDispositionLogToMaterialBlob" old_link
JOIN "ItemDispositionLog" idl ON idl."id" = old_link."A"
JOIN "MaterialBlob" mb ON mb."id" = old_link."B"
JOIN "ProductBlob" pb ON pb."id" = idl."productBlobId"
JOIN "ProductMaterial" pm ON pm."productId" = pb."productId" AND pm."materialId" = mb."materialId"
JOIN "ProductMaterialBlob" pmb ON pmb."productMaterialId" = pm."id"
WHERE pmb."version" = 1;

-- Drop old implicit join tables
DROP TABLE "_InventoryItemToMaterialBlob";
DROP TABLE "_ItemDispositionLogToMaterialBlob";

-- Drop denormalized columns from ProductMaterial (data now lives only in ProductMaterialBlob)
ALTER TABLE "ProductMaterial" DROP COLUMN "weight",
                              DROP COLUMN "weightUnits",
                              DROP COLUMN "itemCost";
