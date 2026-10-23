-- AlterTable
ALTER TABLE "SetupChangeset" ADD COLUMN     "mapping" JSONB,
ADD COLUMN     "origin" JSONB;

-- CreateTable
CREATE TABLE "SetupChangesetRow" (
    "id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "entity" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entityId" UUID,
    "matchedBy" TEXT,
    "changes" JSONB NOT NULL,
    "links" JSONB,
    "issues" JSONB NOT NULL,
    "origin" JSONB,
    "changesetId" UUID NOT NULL,

    CONSTRAINT "SetupChangesetRow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SetupUpload" (
    "id" UUID NOT NULL,
    "filename" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "receivedAt" TIMESTAMPTZ(3),
    "size" INTEGER,
    "data" BYTEA,
    "grantId" UUID,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "siteId" UUID NOT NULL,

    CONSTRAINT "SetupUpload_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SetupChangesetRow_changesetId_action_position_idx" ON "SetupChangesetRow"("changesetId", "action", "position");

-- CreateIndex
CREATE UNIQUE INDEX "SetupChangesetRow_changesetId_position_key" ON "SetupChangesetRow"("changesetId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "SetupUpload_tokenHash_key" ON "SetupUpload"("tokenHash");

-- CreateIndex
CREATE INDEX "SetupUpload_siteId_createdAt_idx" ON "SetupUpload"("siteId", "createdAt");

-- AddForeignKey
ALTER TABLE "SetupChangesetRow" ADD CONSTRAINT "SetupChangesetRow_changesetId_fkey" FOREIGN KEY ("changesetId") REFERENCES "SetupChangeset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SetupUpload" ADD CONSTRAINT "SetupUpload_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SetupUpload" ADD CONSTRAINT "SetupUpload_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

