-- CreateEnum
CREATE TYPE "DisplayStatus" AS ENUM ('UNCLAIMED', 'CLAIMED');

-- CreateTable
CREATE TABLE "Dashboard" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "spec" JSONB NOT NULL DEFAULT '{}',
    "state" JSONB NOT NULL DEFAULT '{}',
    "attrs" JSONB NOT NULL DEFAULT '{}',
    "siteId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Dashboard_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Display" (
    "id" UUID NOT NULL,
    "name" TEXT,
    "claimCode" TEXT NOT NULL,
    "status" "DisplayStatus" NOT NULL DEFAULT 'UNCLAIMED',
    "attrs" JSONB NOT NULL DEFAULT '{}',
    "siteId" UUID,
    "dashboardId" UUID,
    "claimedAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Display_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Dashboard_siteId_idx" ON "Dashboard"("siteId");

-- CreateIndex
CREATE UNIQUE INDEX "Display_claimCode_key" ON "Display"("claimCode");

-- CreateIndex
CREATE INDEX "Display_siteId_idx" ON "Display"("siteId");

-- CreateIndex
CREATE INDEX "Display_claimCode_idx" ON "Display"("claimCode");

-- CreateIndex
CREATE INDEX "Display_dashboardId_idx" ON "Display"("dashboardId");

-- AddForeignKey
ALTER TABLE "Dashboard" ADD CONSTRAINT "Dashboard_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Display" ADD CONSTRAINT "Display_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Display" ADD CONSTRAINT "Display_dashboardId_fkey" FOREIGN KEY ("dashboardId") REFERENCES "Dashboard"("id") ON DELETE SET NULL ON UPDATE CASCADE;
