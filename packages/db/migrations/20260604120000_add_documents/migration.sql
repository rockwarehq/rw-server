-- CreateEnum
CREATE TYPE "DocumentKind" AS ENUM ('FILE', 'FOLDER');

-- CreateEnum
CREATE TYPE "DocumentStatus" AS ENUM ('PENDING_UPLOAD', 'READY');

-- CreateEnum
CREATE TYPE "DocumentTargetType" AS ENUM ('SITE', 'WORKCENTER', 'STATION', 'JOB', 'TOOL', 'PRODUCT', 'MATERIAL');

-- CreateTable
CREATE TABLE "Document" (
    "id" UUID NOT NULL,
    "kind" "DocumentKind" NOT NULL,
    "status" "DocumentStatus" NOT NULL DEFAULT 'READY',
    "name" TEXT NOT NULL,
    "description" TEXT,
    "labels" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "attrs" JSONB NOT NULL DEFAULT '{}',
    "filename" TEXT,
    "contentType" TEXT,
    "size" INTEGER,
    "storageKey" TEXT,
    "siteId" UUID,
    "parentId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "Document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentLink" (
    "id" UUID NOT NULL,
    "documentId" UUID NOT NULL,
    "targetType" "DocumentTargetType" NOT NULL,
    "targetId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Document_storageKey_key" ON "Document"("storageKey");

-- CreateIndex
CREATE INDEX "Document_siteId_idx" ON "Document"("siteId");

-- CreateIndex
CREATE INDEX "Document_parentId_idx" ON "Document"("parentId");

-- CreateIndex
CREATE INDEX "Document_kind_status_idx" ON "Document"("kind", "status");

-- CreateIndex
CREATE INDEX "Document_labels_idx" ON "Document" USING GIN ("labels" array_ops);

-- CreateIndex
CREATE INDEX "Document_deletedAt_idx" ON "Document"("deletedAt");

-- CreateIndex
CREATE INDEX "DocumentLink_targetType_targetId_idx" ON "DocumentLink"("targetType", "targetId");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentLink_documentId_targetType_targetId_key" ON "DocumentLink"("documentId", "targetType", "targetId");

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentLink" ADD CONSTRAINT "DocumentLink_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;
