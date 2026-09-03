-- DropForeignKey
ALTER TABLE "Notification" DROP CONSTRAINT "Notification_groupId_fkey";

-- AlterTable
ALTER TABLE "Notification" ALTER COLUMN "groupId" DROP NOT NULL,
ALTER COLUMN "groupName" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "NotificationGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

