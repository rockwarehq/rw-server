-- CreateEnum
CREATE TYPE "IntegrationRunStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED');

-- CreateTable
CREATE TABLE "Integration" (
    "id" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "config" JSONB NOT NULL DEFAULT '{}',
    "secretCipher" BYTEA,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Integration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntegrationTrigger" (
    "id" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "eventNamespace" TEXT NOT NULL,
    "eventName" TEXT NOT NULL,
    "eventVersion" TEXT NOT NULL DEFAULT '1',
    "hookId" UUID,
    "integrationId" UUID NOT NULL,
    "actionKey" TEXT NOT NULL,
    "actionVersion" TEXT NOT NULL DEFAULT '1',
    "input" JSONB NOT NULL DEFAULT '{}',
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "IntegrationTrigger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntegrationRun" (
    "id" UUID NOT NULL,
    "integrationId" UUID NOT NULL,
    "actionKey" TEXT NOT NULL,
    "actionVersion" TEXT NOT NULL,
    "status" "IntegrationRunStatus" NOT NULL DEFAULT 'PENDING',
    "triggerType" TEXT NOT NULL,
    "triggerId" TEXT,
    "input" JSONB NOT NULL DEFAULT '{}',
    "result" JSONB,
    "error" TEXT,
    "dedupeKey" TEXT,
    "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMPTZ(3),
    "durationMs" INTEGER,

    CONSTRAINT "IntegrationRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Integration_siteId_enabled_idx" ON "Integration"("siteId", "enabled");

-- CreateIndex
CREATE INDEX "Integration_isDeleted_idx" ON "Integration"("isDeleted");

-- CreateIndex
CREATE INDEX "Integration_updatedAt_idx" ON "Integration"("updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Integration_siteId_name_key" ON "Integration"("siteId", "name");

-- CreateIndex
CREATE INDEX "IntegrationTrigger_siteId_eventNamespace_eventName_eventVer_idx" ON "IntegrationTrigger"("siteId", "eventNamespace", "eventName", "eventVersion", "enabled");

-- CreateIndex
CREATE INDEX "IntegrationTrigger_integrationId_idx" ON "IntegrationTrigger"("integrationId");

-- CreateIndex
CREATE INDEX "IntegrationTrigger_hookId_idx" ON "IntegrationTrigger"("hookId");

-- CreateIndex
CREATE INDEX "IntegrationTrigger_isDeleted_idx" ON "IntegrationTrigger"("isDeleted");

-- CreateIndex
CREATE UNIQUE INDEX "IntegrationTrigger_siteId_name_key" ON "IntegrationTrigger"("siteId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "IntegrationRun_dedupeKey_key" ON "IntegrationRun"("dedupeKey");

-- CreateIndex
CREATE INDEX "IntegrationRun_integrationId_startedAt_idx" ON "IntegrationRun"("integrationId", "startedAt");

-- CreateIndex
CREATE INDEX "IntegrationRun_status_idx" ON "IntegrationRun"("status");

-- CreateIndex
CREATE INDEX "IntegrationRun_triggerType_triggerId_idx" ON "IntegrationRun"("triggerType", "triggerId");

-- AddForeignKey
ALTER TABLE "Integration" ADD CONSTRAINT "Integration_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationTrigger" ADD CONSTRAINT "IntegrationTrigger_hookId_fkey" FOREIGN KEY ("hookId") REFERENCES "GraphHook"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationTrigger" ADD CONSTRAINT "IntegrationTrigger_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "Integration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationTrigger" ADD CONSTRAINT "IntegrationTrigger_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationRun" ADD CONSTRAINT "IntegrationRun_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "Integration"("id") ON DELETE CASCADE ON UPDATE CASCADE;
