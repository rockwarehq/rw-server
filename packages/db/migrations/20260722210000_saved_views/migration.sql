-- Saved page views (Linear-style): generic across pages via the `page`
-- discriminator; `config` validated per-page at the RPC boundary.

-- CreateTable
CREATE TABLE "SavedView" (
    "id" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "page" TEXT NOT NULL,
    "scopeId" UUID,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "visibility" TEXT NOT NULL DEFAULT 'PRIVATE',
    "createdById" UUID,
    "config" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "SavedView_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SavedView_siteId_page_scopeId_idx" ON "SavedView"("siteId", "page", "scopeId");

-- CreateIndex
CREATE INDEX "SavedView_createdById_idx" ON "SavedView"("createdById");

-- AddForeignKey
ALTER TABLE "SavedView" ADD CONSTRAINT "SavedView_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SavedView" ADD CONSTRAINT "SavedView_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
