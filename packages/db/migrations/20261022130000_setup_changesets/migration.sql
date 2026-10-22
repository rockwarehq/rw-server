-- Bulk setup: external keys and proposed master-data changesets.
-- CreateEnum
CREATE TYPE "SetupEntity" AS ENUM ('MATERIAL', 'PRODUCT', 'TOOL', 'JOB', 'WORKCENTER', 'STATION');

-- CreateEnum
CREATE TYPE "SetupChangesetStatus" AS ENUM ('DRAFT', 'APPLIED', 'DISCARDED');

-- AlterEnum


ALTER TYPE "AuditAction" ADD VALUE 'SETUP_CHANGESET_PROPOSED';
ALTER TYPE "AuditAction" ADD VALUE 'SETUP_CHANGESET_APPLIED';
ALTER TYPE "AuditAction" ADD VALUE 'SETUP_CHANGESET_DISCARDED';

-- CreateTable
CREATE TABLE "ExternalRef" (
    "id" UUID NOT NULL,
    "entityType" "SetupEntity" NOT NULL,
    "source" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "entityId" UUID NOT NULL,
    "changesetId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "siteId" UUID NOT NULL,

    CONSTRAINT "ExternalRef_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SetupChangeset" (
    "id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "status" "SetupChangesetStatus" NOT NULL DEFAULT 'DRAFT',
    "author" "GraphChangesetAuthor" NOT NULL DEFAULT 'USER',
    "spec" JSONB NOT NULL,
    "planResult" JSONB NOT NULL,
    "summary" JSONB NOT NULL,
    "grantId" UUID,
    "clientName" TEXT,
    "createdById" UUID,
    "appliedById" UUID,
    "appliedAt" TIMESTAMPTZ(3),
    "discardedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "siteId" UUID NOT NULL,

    CONSTRAINT "SetupChangeset_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ExternalRef_siteId_entityType_entityId_idx" ON "ExternalRef"("siteId", "entityType", "entityId");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalRef_siteId_entityType_source_key_key" ON "ExternalRef"("siteId", "entityType", "source", "key");

-- CreateIndex
CREATE INDEX "SetupChangeset_siteId_status_createdAt_idx" ON "SetupChangeset"("siteId", "status", "createdAt");

-- AddForeignKey
ALTER TABLE "ExternalRef" ADD CONSTRAINT "ExternalRef_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SetupChangeset" ADD CONSTRAINT "SetupChangeset_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SetupChangeset" ADD CONSTRAINT "SetupChangeset_appliedById_fkey" FOREIGN KEY ("appliedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SetupChangeset" ADD CONSTRAINT "SetupChangeset_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

