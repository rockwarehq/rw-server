-- One-time continuity backfill for the permission cutover.
--
-- The new Plant Member role is planning-only: production (floor)
-- visibility now comes from workcenter grants, never from base
-- membership. Without help, every existing member would lose the floor
-- views they can open today the moment the cutover deploys.
--
-- So: every membership that holds the BUILT-IN Plant Member role at a
-- site gets a View (READ) grant on every workcenter in that site. What a
-- member could see yesterday, they can still see today; admins prune
-- grants afterward. Members created after the cutover start with no
-- grants (the target model).
--
-- Deliberately narrow:
-- - Built-in Plant Member assignments only. Custom roles that held the
--   complete legacy read bundle already kept visibility through the
--   expand migration's production:read.
-- - Never touches an existing grant (ON CONFLICT DO NOTHING), so a
--   member's existing WRITE grant is never downgraded.
-- - Idempotent: re-running inserts nothing new.

INSERT INTO "WorkcenterGrant" ("id", "membershipId", "workcenterId", "access", "updatedAt")
SELECT gen_random_uuid(), ra."membershipId", wc."id", 'READ', now()
FROM "RoleAssignment" ra
JOIN "Role" r ON r."id" = ra."roleId"
JOIN "Workcenter" wc ON wc."siteId" = ra."siteId"
WHERE r."isSystem" = true
  AND r."name" = 'Plant Member'
  AND r."scope" = 'SITE'
  AND ra."siteId" IS NOT NULL
ON CONFLICT ("membershipId", "workcenterId") DO NOTHING;
