-- Every account is on its plants' teams.
--
-- A person who logs in is also a team member (Employee) with a team role at
-- each plant they reach, linked by User.employeeId. From here on the API
-- keeps that true (services/employee/account.ts); this backfills the
-- accounts that exist today. Data only, no schema change.
--
--   1. Link an account to the one active team member with its email.
--   2. Make a team member for every other account that reaches a plant.
--   3. Give each linked account a team role at every plant it reaches:
--      ADMIN -> Manager, MANAGE -> Supervisor, VIEW -> Operator (else
--      Operator; a plant without those roles is skipped). Account admins
--      reach every plant as ADMIN. Existing team access is left alone.
--
-- packages/db/scripts/preflight-account-team-members.sql lists what step 1
-- will and won't link, read-only, before this runs.

-- Accounts that belong on a team: not Rockware staff, and reaching a plant.
CREATE TEMP TABLE account_member AS
SELECT u."id" AS user_id
FROM "User" u
WHERE u."systemRole" IS NULL
  AND (
    u."isAccountAdmin"
    OR EXISTS (SELECT 1 FROM "BucketAccess" ba WHERE ba."userId" = u."id")
  );

-- ── 1. Link by email ──────────────────────────────────────────────────────
-- Only when exactly one unlinked, active team member has the email, and no
-- other account claims the same team member.

WITH candidate AS (
  SELECT u."id" AS user_id, e."id" AS employee_id
  FROM "User" u
  JOIN account_member am ON am.user_id = u."id"
  JOIN "EmployeeVersion" v ON lower(btrim(v."email")) = lower(u."email")
  JOIN "Employee" e ON e."versionId" = v."id" AND e."status" = 'ACTIVE'
  WHERE u."employeeId" IS NULL
    AND NOT EXISTS (SELECT 1 FROM "User" o WHERE o."employeeId" = e."id")
),
one_per_user AS (
  SELECT user_id, (array_agg(employee_id))[1] AS employee_id
  FROM candidate
  GROUP BY user_id
  HAVING count(*) = 1
),
one_per_employee AS (
  SELECT employee_id
  FROM one_per_user
  GROUP BY employee_id
  HAVING count(*) = 1
)
UPDATE "User" u
SET "employeeId" = p.employee_id
FROM one_per_user p
JOIN one_per_employee pe ON pe.employee_id = p.employee_id
WHERE u."id" = p.user_id;

-- ── 2. A team member for every other account ─────────────────────────────

CREATE TEMP TABLE account_profile AS
SELECT
  u."id" AS user_id,
  gen_random_uuid() AS employee_id,
  gen_random_uuid() AS version_id,
  COALESCE(NULLIF(btrim(u."firstName"), ''), split_part(u."email", '@', 1)) AS first_name,
  COALESCE(btrim(u."lastName"), '') AS last_name,
  u."email" AS email
FROM "User" u
JOIN account_member am ON am.user_id = u."id"
WHERE u."employeeId" IS NULL;

INSERT INTO "Employee" ("id", "workspaceId", "status", "failedLoginAttempts", "createdAt", "updatedAt")
SELECT p.employee_id, w."id", 'ACTIVE', 0, now(), now()
FROM account_profile p
CROSS JOIN (SELECT "id" FROM "Workspace" LIMIT 1) w;

INSERT INTO "EmployeeVersion" ("id", "version", "firstName", "lastName", "email", "employeeId", "createdAt")
SELECT p.version_id, 1, p.first_name, p.last_name, p.email, p.employee_id, now()
FROM account_profile p
JOIN "Employee" e ON e."id" = p.employee_id;

UPDATE "Employee" e
SET "versionId" = p.version_id
FROM account_profile p
WHERE e."id" = p.employee_id;

UPDATE "User" u
SET "employeeId" = p.employee_id
FROM account_profile p
JOIN "Employee" e ON e."id" = p.employee_id
WHERE u."id" = p.user_id;

-- ── 3. A team role at every plant the account reaches ────────────────────

WITH reach AS (
  SELECT
    u."employeeId" AS employee_id,
    b."siteId" AS site_id,
    CASE ba."level" WHEN 'ADMIN' THEN 2 WHEN 'MANAGE' THEN 1 ELSE 0 END AS rank
  FROM "User" u
  JOIN account_member am ON am.user_id = u."id"
  JOIN "BucketAccess" ba ON ba."userId" = u."id"
  JOIN "Bucket" b ON b."id" = ba."bucketId"
  WHERE u."employeeId" IS NOT NULL AND b."siteId" IS NOT NULL
  UNION ALL
  SELECT u."employeeId", s."id", 2
  FROM "User" u
  JOIN account_member am ON am.user_id = u."id"
  CROSS JOIN "Site" s
  WHERE u."isAccountAdmin" AND u."employeeId" IS NOT NULL
),
best AS (
  SELECT employee_id, site_id, max(rank) AS rank
  FROM reach
  GROUP BY employee_id, site_id
)
INSERT INTO "EmployeeSiteAccess" ("id", "employeeId", "siteId", "roleId", "status", "createdAt", "updatedAt")
SELECT gen_random_uuid(), b.employee_id, b.site_id, COALESCE(by_level."id", operator."id"), 'ACTIVE', now(), now()
FROM best b
LEFT JOIN "EmployeeRole" by_level
  ON by_level."siteId" = b.site_id
 AND by_level."name" = CASE b.rank WHEN 2 THEN 'Manager' WHEN 1 THEN 'Supervisor' ELSE 'Operator' END
LEFT JOIN "EmployeeRole" operator
  ON operator."siteId" = b.site_id AND operator."name" = 'Operator'
WHERE COALESCE(by_level."id", operator."id") IS NOT NULL
ON CONFLICT ("employeeId", "siteId") DO NOTHING;

DROP TABLE account_profile;
DROP TABLE account_member;
