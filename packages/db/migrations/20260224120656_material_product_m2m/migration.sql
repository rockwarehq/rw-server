/*
  Warnings:

  - You are about to drop the column `productId` on the `Material` table. All the data in the column will be lost.

*/
-- DropForeignKey
ALTER TABLE "Material" DROP CONSTRAINT "Material_productId_fkey";

-- DropIndex
DROP INDEX "Material_productId_idx";

-- AlterTable
ALTER TABLE "Material" DROP COLUMN "productId";

-- CreateTable
CREATE TABLE "ProductMaterial" (
    "id" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "materialId" UUID NOT NULL,
    "attrs" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "ProductMaterial_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProductMaterial_materialId_idx" ON "ProductMaterial"("materialId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductMaterial_productId_materialId_key" ON "ProductMaterial"("productId", "materialId");

-- AddForeignKey
ALTER TABLE "ProductMaterial" ADD CONSTRAINT "ProductMaterial_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductMaterial" ADD CONSTRAINT "ProductMaterial_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "Material"("id") ON DELETE CASCADE ON UPDATE CASCADE;
