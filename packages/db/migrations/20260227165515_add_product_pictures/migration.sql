-- CreateTable
CREATE TABLE "ProductPicture" (
    "id" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductPicture_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProductPicture_productId_idx" ON "ProductPicture"("productId");

-- AddForeignKey
ALTER TABLE "ProductPicture" ADD CONSTRAINT "ProductPicture_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
