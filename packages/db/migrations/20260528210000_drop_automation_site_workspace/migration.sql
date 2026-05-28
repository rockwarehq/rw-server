-- DropForeignKey
ALTER TABLE "Automation" DROP CONSTRAINT "Automation_siteId_fkey";

-- DropForeignKey
ALTER TABLE "Automation" DROP CONSTRAINT "Automation_workspaceId_fkey";

-- DropIndex
DROP INDEX "Automation_siteId_enabled_event_idx";

-- DropIndex
DROP INDEX "Automation_siteId_idx";

-- DropIndex
DROP INDEX "Automation_siteId_label_key";

-- DropIndex
DROP INDEX "Automation_workspaceId_idx";

-- AlterTable
ALTER TABLE "Automation" DROP COLUMN "siteId",
DROP COLUMN "workspaceId";

-- CreateIndex
CREATE UNIQUE INDEX "Automation_label_key" ON "Automation"("label");

-- CreateIndex
CREATE INDEX "Automation_enabled_event_idx" ON "Automation"("enabled", "event");
