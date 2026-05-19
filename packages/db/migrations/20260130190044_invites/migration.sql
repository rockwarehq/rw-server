/*
  Warnings:

  - You are about to drop the column `inviteToken` on the `User` table. All the data in the column will be lost.
  - You are about to drop the column `resetToken` on the `User` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[inviteTokenHash]` on the table `User` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[resetTokenHash]` on the table `User` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "AuditAction" AS ENUM ('USER_INVITED', 'INVITE_VERIFIED', 'INVITE_COMPLETED', 'INVITE_FAILED', 'INVITE_EXPIRED', 'PASSWORD_RESET_REQUESTED', 'PASSWORD_RESET_COMPLETED', 'PASSWORD_RESET_FAILED', 'LOGIN_SUCCESS', 'LOGIN_FAILED', 'LOGIN_LOCKED', 'LOGOUT', 'ACCOUNT_UNLOCKED', 'PASSWORD_CHANGED', 'USER_DISABLED', 'USER_ENABLED');

-- DropIndex
DROP INDEX "User_inviteToken_key";

-- DropIndex
DROP INDEX "User_resetToken_key";

-- AlterTable
ALTER TABLE "User" DROP COLUMN "inviteToken",
DROP COLUMN "resetToken",
ADD COLUMN     "failedLoginAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "inviteAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "inviteTokenHash" TEXT,
ADD COLUMN     "lockedUntil" TIMESTAMP(3),
ADD COLUMN     "resetAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "resetTokenHash" TEXT;

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" UUID NOT NULL,
    "action" "AuditAction" NOT NULL,
    "userId" UUID,
    "actorId" UUID,
    "workspaceId" UUID,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AuditLog_userId_idx" ON "AuditLog"("userId");

-- CreateIndex
CREATE INDEX "AuditLog_actorId_idx" ON "AuditLog"("actorId");

-- CreateIndex
CREATE INDEX "AuditLog_action_idx" ON "AuditLog"("action");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "User_inviteTokenHash_key" ON "User"("inviteTokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "User_resetTokenHash_key" ON "User"("resetTokenHash");
