-- Overhead paging: saved pages (OverheadPage) and a log of every manual send (OverheadPageLog).
-- CreateEnum
CREATE TYPE "OverheadPageLogStatus" AS ENUM ('SENT', 'PARTIAL', 'FAILED');

-- CreateEnum
CREATE TYPE "OverheadPagePriority" AS ENUM ('NORMAL', 'HIGH', 'EMERGENCY');

-- CreateTable
CREATE TABLE "OverheadPageLog" (
    "id" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "pageId" UUID,
    "pageName" TEXT,
    "text" TEXT NOT NULL,
    "gatewayIds" UUID[],
    "priority" "OverheadPagePriority" NOT NULL,
    "chimeBefore" TEXT,
    "chimeAfter" TEXT,
    "repeat" INTEGER NOT NULL,
    "voice" TEXT,
    "speed" DOUBLE PRECISION,
    "status" "OverheadPageLogStatus" NOT NULL,
    "error" TEXT,
    "sentByUserId" UUID,
    "sentByName" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OverheadPageLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OverheadPage" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "gatewayIds" UUID[],
    "priority" "OverheadPagePriority" NOT NULL DEFAULT 'NORMAL',
    "chimeBefore" TEXT,
    "chimeAfter" TEXT,
    "repeat" INTEGER NOT NULL DEFAULT 1,
    "voice" TEXT,
    "speed" DOUBLE PRECISION,
    "siteId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "archivedAt" TIMESTAMPTZ(3),

    CONSTRAINT "OverheadPage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OverheadPageLog_siteId_createdAt_idx" ON "OverheadPageLog"("siteId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "OverheadPageLog_pageId_idx" ON "OverheadPageLog"("pageId");

-- CreateIndex
CREATE INDEX "OverheadPage_siteId_idx" ON "OverheadPage"("siteId");

-- CreateIndex
CREATE UNIQUE INDEX "OverheadPage_siteId_name_key" ON "OverheadPage"("siteId", "name");

-- AddForeignKey
ALTER TABLE "OverheadPageLog" ADD CONSTRAINT "OverheadPageLog_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OverheadPageLog" ADD CONSTRAINT "OverheadPageLog_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "OverheadPage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OverheadPage" ADD CONSTRAINT "OverheadPage_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

