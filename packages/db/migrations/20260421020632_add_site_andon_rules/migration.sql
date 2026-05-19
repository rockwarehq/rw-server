-- CreateTable
CREATE TABLE "SiteAndonRule" (
    "id" UUID NOT NULL,
    "name" TEXT,
    "expression" TEXT NOT NULL,
    "referencedVariables" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "colorHex" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "siteId" UUID NOT NULL,

    CONSTRAINT "SiteAndonRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SiteAndonRule_siteId_idx" ON "SiteAndonRule"("siteId");

-- CreateIndex
CREATE INDEX "SiteAndonRule_siteId_sortOrder_idx" ON "SiteAndonRule"("siteId", "sortOrder");

-- AddForeignKey
ALTER TABLE "SiteAndonRule" ADD CONSTRAINT "SiteAndonRule_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;
