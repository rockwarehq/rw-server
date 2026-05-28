-- DropForeignKey
ALTER TABLE "Automation" DROP CONSTRAINT "Automation_workspaceId_fkey";

-- DropIndex
DROP INDEX "Automation_workspaceId_enabled_event_idx";

-- DropIndex
DROP INDEX "Automation_workspaceId_label_key";

-- AlterTable
ALTER TABLE "Automation" ADD COLUMN     "siteId" UUID NOT NULL,
ALTER COLUMN "workspaceId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "AutomationRun" DROP COLUMN "matched",
DROP COLUMN "eventId",
ADD COLUMN     "eventId" UUID NOT NULL;

-- CreateTable
CREATE TABLE "AutomationRunMatch" (
    "id" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "automationId" UUID NOT NULL,
    "matchIdx" INTEGER NOT NULL,

    CONSTRAINT "AutomationRunMatch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AutomationRunMatch_automationId_idx" ON "AutomationRunMatch"("automationId");

-- CreateIndex
CREATE UNIQUE INDEX "AutomationRunMatch_runId_automationId_key" ON "AutomationRunMatch"("runId", "automationId");

-- CreateIndex
CREATE INDEX "Automation_siteId_idx" ON "Automation"("siteId");

-- CreateIndex
CREATE INDEX "Automation_siteId_enabled_event_idx" ON "Automation"("siteId", "enabled", "event");

-- CreateIndex
CREATE UNIQUE INDEX "Automation_siteId_label_key" ON "Automation"("siteId", "label");

-- AddForeignKey
ALTER TABLE "Automation" ADD CONSTRAINT "Automation_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Automation" ADD CONSTRAINT "Automation_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationRunMatch" ADD CONSTRAINT "AutomationRunMatch_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AutomationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

