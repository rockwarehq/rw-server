-- Password reset moves from long emailed links to short emailed codes.
-- Codes are looked up by email, so the reset hash no longer needs to be unique.
DROP INDEX "User_resetTokenHash_key";

-- Set when an admin issues a temporary password; cleared on any password change.
ALTER TABLE "User" ADD COLUMN "mustChangePassword" BOOLEAN NOT NULL DEFAULT false;

-- Audit action for an admin setting a user's password.
ALTER TYPE "AuditAction" ADD VALUE 'PASSWORD_ADMIN_RESET';
