-- Permission vocabulary expansion (transition step 1 of 2).
--
-- The permission catalog is shrinking from 49 resource:action keys to eight
-- responsibility keys. During the transition, role rows carry BOTH key sets
-- so old and new permission checks work against the same data. This
-- migration adds the new keys; a later migration removes the legacy keys
-- once every call site checks the new ones.
--
-- Built-in (isSystem) roles are NOT touched here: the deploy-time seed
-- (apps/api/src/seed.ts) rewrites their bundles from code on every release.
-- Custom roles are expanded conservatively: a role gains a new key only when
-- it holds that key's COMPLETE legacy bundle. Nothing is ever pooled across
-- roles, and no legacy key is removed. The rules below are embedded verbatim
-- from packages/auth/src/iam/permissions.ts (LEGACY_PERMISSION_RULES);
-- permissions.migration.test.ts asserts the two copies stay identical.

-- ── 1. Back up every role's exact current array ──────────────────────────
ALTER TABLE "Role" ADD COLUMN "legacyPermissions" JSONB;

UPDATE "Role" SET "legacyPermissions" = to_jsonb("permissions");

-- Rollback (restores the pre-expansion arrays):
--   UPDATE "Role"
--   SET "permissions" = ARRAY(SELECT jsonb_array_elements_text("legacyPermissions"))
--   WHERE "legacyPermissions" IS NOT NULL;
--   ALTER TABLE "Role" DROP COLUMN "legacyPermissions";

-- ── 2. Append earned new keys to custom roles ────────────────────────────
WITH rules AS (
  SELECT
    rule.permission,
    ARRAY(SELECT jsonb_array_elements_text(rule.required)) AS required
  FROM jsonb_to_recordset($rules$
[
  {
    "permission": "production:read",
    "required": [
      "facility:read",
      "job:read",
      "status:read",
      "calls:read",
      "modes:read",
      "tool:read",
      "product:read",
      "schedule:read",
      "dashboard:read",
      "employee:read",
      "graph:read",
      "entity:read"
    ]
  },
  {
    "permission": "production:write",
    "required": [
      "facility:read",
      "job:read",
      "status:read",
      "calls:read",
      "modes:read",
      "tool:read",
      "product:read",
      "schedule:read",
      "dashboard:read",
      "employee:read",
      "graph:read",
      "entity:read",
      "facility:write",
      "facility:admin",
      "job:write",
      "status:write",
      "calls:write",
      "modes:write",
      "tool:write",
      "product:write",
      "product:admin",
      "schedule:write"
    ]
  },
  {
    "permission": "production:admin",
    "required": [
      "facility:read",
      "facility:write",
      "facility:admin",
      "schedule:read",
      "schedule:write",
      "schedule:admin",
      "job:read",
      "job:write",
      "job:admin",
      "status:read",
      "status:write",
      "status:admin",
      "calls:read",
      "calls:write",
      "calls:admin",
      "modes:read",
      "modes:write",
      "modes:admin",
      "notifications:read",
      "notifications:write",
      "notifications:admin",
      "tool:read",
      "tool:write",
      "tool:admin",
      "product:read",
      "product:write",
      "product:admin",
      "dashboard:read",
      "dashboard:write",
      "dashboard:admin",
      "entity:read",
      "entity:write",
      "entity:admin",
      "graph:read",
      "graph:write",
      "graph:admin",
      "user:read",
      "user:write",
      "user:admin",
      "employee:read",
      "employee:write",
      "employee:admin",
      "billing:read",
      "billing:write",
      "billing:admin",
      "settings:read",
      "settings:write",
      "settings:admin"
    ]
  },
  {
    "permission": "planning:read",
    "required": [
      "job:read",
      "schedule:read"
    ]
  },
  {
    "permission": "planning:write",
    "required": [
      "job:read",
      "job:write",
      "schedule:read",
      "schedule:write"
    ]
  },
  {
    "permission": "configuration:read",
    "required": [
      "facility:read",
      "job:read",
      "status:read",
      "calls:read",
      "modes:read",
      "notifications:read",
      "dashboard:read",
      "entity:read",
      "graph:read",
      "settings:read"
    ]
  },
  {
    "permission": "configuration:write",
    "required": [
      "facility:read",
      "facility:write",
      "facility:admin",
      "job:read",
      "job:write",
      "job:admin",
      "status:read",
      "status:write",
      "status:admin",
      "calls:read",
      "calls:write",
      "calls:admin",
      "modes:read",
      "modes:write",
      "modes:admin",
      "notifications:read",
      "notifications:write",
      "notifications:admin",
      "dashboard:read",
      "dashboard:write",
      "dashboard:admin",
      "entity:read",
      "entity:write",
      "entity:admin",
      "graph:read",
      "graph:write",
      "graph:admin",
      "settings:read",
      "settings:write",
      "settings:admin"
    ]
  },
  {
    "permission": "plant:admin",
    "required": [
      "user:read",
      "user:write",
      "user:admin",
      "employee:read",
      "employee:write",
      "employee:admin",
      "settings:read",
      "settings:write",
      "settings:admin"
    ]
  }
]
$rules$::jsonb) AS rule(permission text, required jsonb)
),
additions AS (
  SELECT
    r."id" AS role_id,
    array_agg(rules.permission ORDER BY rules.permission) AS new_keys
  FROM "Role" r
  JOIN rules
    ON r."permissions" @> rules.required
   AND NOT r."permissions" @> ARRAY[rules.permission]
  WHERE r."isSystem" = false
  GROUP BY r."id"
)
UPDATE "Role" r
SET "permissions" = r."permissions" || a.new_keys
FROM additions a
WHERE r."id" = a.role_id;
