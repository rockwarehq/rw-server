-- Invites now issue a temporary password (stored in passwordHash) instead of
-- an emailed token link. The token hash and its brute-force counter are dead.
-- inviteTokenExpiry is retained as the invite-validity window checked at login.
ALTER TABLE "User" DROP COLUMN "inviteTokenHash";
ALTER TABLE "User" DROP COLUMN "inviteAttempts";

-- Audit action for revoking (deleting) a pending invite.
ALTER TYPE "AuditAction" ADD VALUE 'INVITE_REVOKED';
