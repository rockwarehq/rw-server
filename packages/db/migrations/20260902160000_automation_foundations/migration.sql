-- AlterEnum
ALTER TYPE "AutomationRunStatus" ADD VALUE 'DROPPED';

-- Automation: site ownership. Label uniqueness becomes per-site.
DROP INDEX "Automation_label_key";
ALTER TABLE "Automation" ADD COLUMN "siteId" UUID;
CREATE INDEX "Automation_siteId_idx" ON "Automation"("siteId");
CREATE UNIQUE INDEX "Automation_siteId_label_key" ON "Automation"("siteId", "label");
ALTER TABLE "Automation" ADD CONSTRAINT "Automation_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AutomationRun: site + chain tracing. Existing runs were all root events, so their
-- correlationId is their own eventId.
ALTER TABLE "AutomationRun"
  ADD COLUMN "siteId" UUID,
  ADD COLUMN "correlationId" UUID,
  ADD COLUMN "causationId" UUID,
  ADD COLUMN "hop" INTEGER NOT NULL DEFAULT 0;
UPDATE "AutomationRun" SET "correlationId" = "eventId" WHERE "correlationId" IS NULL;
ALTER TABLE "AutomationRun" ALTER COLUMN "correlationId" SET NOT NULL;
CREATE INDEX "AutomationRun_siteId_firedAt_idx" ON "AutomationRun"("siteId", "firedAt" DESC);
CREATE INDEX "AutomationRun_correlationId_idx" ON "AutomationRun"("correlationId");
