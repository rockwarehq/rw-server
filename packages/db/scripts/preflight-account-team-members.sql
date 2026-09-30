-- Read-only preflight for 20261010100000_account_team_members.
--   psql "$DATABASE_URL" -f packages/db/scripts/preflight-account-team-members.sql
--
-- Lists, per unlinked account that reaches a plant, what the migration will
-- do: link to the team member with its email, create a new one (no match),
-- or create a new one because the email is ambiguous (review those and link
-- by hand if they are the same person). Also flags accounts with no name,
-- whose team member will be named after the email's local part.

BEGIN;

WITH account_member AS (
  SELECT u."id", u."email", u."firstName", u."lastName"
  FROM "User" u
  WHERE u."systemRole" IS NULL
    AND u."employeeId" IS NULL
    AND (
      u."isAccountAdmin"
      OR EXISTS (SELECT 1 FROM "BucketAccess" ba WHERE ba."userId" = u."id")
    )
),
matches AS (
  SELECT am."id" AS user_id, count(e."id") AS n,
         string_agg(v."firstName" || ' ' || v."lastName" || ' (' || e."id" || ')', ', ') AS team_members
  FROM account_member am
  LEFT JOIN "EmployeeVersion" v ON lower(btrim(v."email")) = lower(am."email")
  LEFT JOIN "Employee" e ON e."versionId" = v."id" AND e."status" = 'ACTIVE'
    AND NOT EXISTS (SELECT 1 FROM "User" o WHERE o."employeeId" = e."id")
  GROUP BY am."id"
)
SELECT
  am."email",
  CASE WHEN m.n = 1 THEN 'link' WHEN m.n = 0 THEN 'create' ELSE 'create (ambiguous email)' END AS action,
  m.team_members,
  CASE WHEN NULLIF(btrim(am."firstName"), '') IS NULL THEN 'no name: uses email' END AS note
FROM account_member am
JOIN matches m ON m.user_id = am."id"
ORDER BY action, am."email";

-- Plants missing the roles the backfill assigns by name.
SELECT s."name" AS plant, r.missing
FROM "Site" s
CROSS JOIN LATERAL (
  SELECT string_agg(wanted.role_name, ', ') AS missing
  FROM unnest(ARRAY['Operator', 'Supervisor', 'Manager']) AS wanted(role_name)
  WHERE NOT EXISTS (
    SELECT 1 FROM "EmployeeRole" er WHERE er."siteId" = s."id" AND er."name" = wanted.role_name
  )
) r
WHERE r.missing IS NOT NULL;

ROLLBACK;
