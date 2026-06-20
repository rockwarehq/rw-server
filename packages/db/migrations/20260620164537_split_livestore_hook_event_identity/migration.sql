-- DropIndex
DROP INDEX "GraphHook_eventType_idx";

-- AlterTable
ALTER TABLE "GraphHook" ADD COLUMN     "eventName" TEXT NOT NULL DEFAULT 'hook_triggered',
ADD COLUMN     "eventNamespace" TEXT NOT NULL DEFAULT 'livestore',
ALTER COLUMN "eventType" SET DEFAULT 'livestore_hook_triggered';

-- CreateIndex
CREATE INDEX "GraphHook_eventNamespace_eventName_idx" ON "GraphHook"("eventNamespace", "eventName");
