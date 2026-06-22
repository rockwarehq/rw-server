-- CreateTable
CREATE TABLE "GraphHook" (
    "id" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "condition" JSONB NOT NULL,
    "eventType" TEXT NOT NULL,
    "eventVersion" TEXT NOT NULL DEFAULT '1',
    "eventPayload" JSONB NOT NULL DEFAULT '{}',
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "GraphHook_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GraphHook_siteId_enabled_idx" ON "GraphHook"("siteId", "enabled");

-- CreateIndex
CREATE INDEX "GraphHook_isDeleted_idx" ON "GraphHook"("isDeleted");

-- CreateIndex
CREATE INDEX "GraphHook_eventType_idx" ON "GraphHook"("eventType");

-- CreateIndex
CREATE UNIQUE INDEX "GraphHook_siteId_name_key" ON "GraphHook"("siteId", "name");

-- AddForeignKey
ALTER TABLE "GraphHook" ADD CONSTRAINT "GraphHook_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;
