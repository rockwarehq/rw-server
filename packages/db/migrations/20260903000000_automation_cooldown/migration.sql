-- AlterTable
ALTER TABLE "Automation" ADD COLUMN     "cooldownMs" INTEGER;

-- AlterTable
ALTER TABLE "AutomationRunMatch" ADD COLUMN     "skipped" TEXT;

-- CreateTable
CREATE TABLE "AutomationCooldown" (
    "automationId" UUID NOT NULL,
    "scope" TEXT NOT NULL,
    "firedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "AutomationCooldown_pkey" PRIMARY KEY ("automationId","scope")
);

-- AddForeignKey
ALTER TABLE "AutomationCooldown" ADD CONSTRAINT "AutomationCooldown_automationId_fkey" FOREIGN KEY ("automationId") REFERENCES "Automation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

