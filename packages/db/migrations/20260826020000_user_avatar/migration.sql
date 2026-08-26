-- User.avatarKey: S3 storage key for the account avatar; null means no
-- avatar uploaded (UI falls back to initials).
ALTER TABLE "User" ADD COLUMN "avatarKey" TEXT;
