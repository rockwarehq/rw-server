-- Permission simplification: code and SQL deliberately share a conservative
-- custom-role mapping (mapLegacyCustomPermissions in @rw/auth/iam/permissions).
-- No migration/seeding of WorkcenterGrant rows: READ/WRITE stay exactly that;
-- runtime evaluates them as scoped production read/write, never Engineer.

ALTER TYPE "RoleScope" ADD VALUE 'WORKCENTER';
ALTER TABLE "RoleAssignment" ADD COLUMN "workcenterId" UUID;
CREATE INDEX "RoleAssignment_workcenterId_idx" ON "RoleAssignment"("workcenterId");
ALTER TABLE "RoleAssignment" ADD CONSTRAINT "RoleAssignment_workcenterId_fkey"
  FOREIGN KEY ("workcenterId") REFERENCES "Workcenter"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RoleAssignment" ADD CONSTRAINT "RoleAssignment_workcenter_requires_site"
  CHECK ("workcenterId" IS NULL OR "siteId" IS NOT NULL);

-- Keep the exact original array (including ordering/duplicates) for audit,
-- read-only previews and an operator-directed rollback. Never evaluated.
ALTER TABLE "Role" ADD COLUMN "legacyPermissions" JSONB;
UPDATE "Role" SET "legacyPermissions" = to_jsonb("permissions");
-- Permission-array rollback, if needed with the corresponding old code:
-- UPDATE "Role" r SET "permissions" = ARRAY(
--   SELECT jsonb_array_elements_text(r."legacyPermissions")
-- ) WHERE r."legacyPermissions" IS NOT NULL;
-- Newly introduced roles have a NULL backup and are not part of this rollback.

-- Map only COMPLETE per-domain prerequisite sets within the SAME role. Legacy
-- writes/admins did not imply reads, and several old admin/delete gates now
-- require new write: those prerequisites are explicitly included below.
-- production:admin adds deleting others' comments, so only the complete old
-- catalog (or an already-current explicit key) qualifies. No single old admin
-- permission, assignment union, or WorkcenterGrant can synthesize it.
--
-- The JSON is executable rule data, not documentation. The unit parity test
-- compares it to LEGACY_PERMISSION_MIGRATION_RULES. Rule order is canonical.
-- Preview flags removed legacy strings for review even when translated: one
-- old key can cover multiple new responsibilities (e.g. planning and live
-- production both formerly used job:write). Missing per-rule requirements and
-- unmapped strings are exposed by mapLegacyCustomPermissions. Backups above
-- retain ordering/duplicates; billing/ownership is never granted to custom roles.
WITH rule_documents AS (
  SELECT value, ordinality
  FROM jsonb_array_elements($permission_rules$[
    {
      "permission": "production:read",
      "requiredPermissions": [
        "facility:read", "job:read", "status:read", "calls:read", "modes:read", "tool:read",
        "product:read", "schedule:read", "dashboard:read", "employee:read", "graph:read", "entity:read"
      ],
      "allowedScopes": ["WORKSPACE", "SITE", "WORKCENTER"]
    },
    {
      "permission": "production:write",
      "requiredPermissions": [
        "facility:read", "job:read", "status:read", "calls:read", "modes:read", "tool:read",
        "product:read", "schedule:read", "dashboard:read", "employee:read", "graph:read", "entity:read",
        "facility:write", "facility:admin", "job:write", "status:write", "calls:write", "modes:write",
        "tool:write", "product:write", "product:admin", "schedule:write"
      ],
      "allowedScopes": ["WORKSPACE", "SITE", "WORKCENTER"]
    },
    {
      "permission": "production:admin",
      "requiredPermissions": [
        "facility:read", "facility:write", "facility:admin",
        "schedule:read", "schedule:write", "schedule:admin",
        "job:read", "job:write", "job:admin",
        "status:read", "status:write", "status:admin",
        "calls:read", "calls:write", "calls:admin",
        "modes:read", "modes:write", "modes:admin",
        "notifications:read", "notifications:write", "notifications:admin",
        "tool:read", "tool:write", "tool:admin",
        "product:read", "product:write", "product:admin",
        "dashboard:read", "dashboard:write", "dashboard:admin",
        "entity:read", "entity:write", "entity:admin",
        "graph:read", "graph:write", "graph:admin",
        "user:read", "user:write", "user:admin",
        "employee:read", "employee:write", "employee:admin",
        "billing:read", "billing:write", "billing:admin",
        "settings:read", "settings:write", "settings:admin"
      ],
      "allowedScopes": ["WORKSPACE", "SITE", "WORKCENTER"]
    },
    {
      "permission": "planning:read",
      "requiredPermissions": ["job:read", "schedule:read"],
      "allowedScopes": ["WORKSPACE", "SITE"]
    },
    {
      "permission": "planning:write",
      "requiredPermissions": ["job:read", "job:write", "job:admin", "schedule:read", "schedule:write", "schedule:admin"],
      "allowedScopes": ["WORKSPACE", "SITE"]
    },
    {
      "permission": "configuration:read",
      "requiredPermissions": [
        "facility:read", "job:read", "status:read", "calls:read", "modes:read",
        "notifications:read", "dashboard:read", "entity:read", "graph:read", "settings:read"
      ],
      "allowedScopes": ["WORKSPACE", "SITE"]
    },
    {
      "permission": "configuration:write",
      "requiredPermissions": [
        "facility:read", "facility:write", "facility:admin",
        "job:read", "job:write", "job:admin",
        "status:read", "status:write", "status:admin",
        "calls:read", "calls:write", "calls:admin",
        "modes:read", "modes:write", "modes:admin",
        "notifications:read", "notifications:write", "notifications:admin",
        "dashboard:read", "dashboard:write", "dashboard:admin",
        "entity:read", "entity:write", "entity:admin",
        "graph:read", "graph:write", "graph:admin",
        "settings:read", "settings:write", "settings:admin"
      ],
      "allowedScopes": ["WORKSPACE", "SITE"]
    },
    {
      "permission": "plant:admin",
      "requiredPermissions": [
        "user:read", "user:write", "user:admin",
        "employee:read", "employee:write", "employee:admin",
        "settings:read", "settings:write", "settings:admin"
      ],
      "allowedScopes": ["WORKSPACE", "SITE"]
    }
  ]$permission_rules$::jsonb) WITH ORDINALITY
), migration_rules AS (
  SELECT document.ordinality, rule.*
  FROM rule_documents document
  CROSS JOIN LATERAL jsonb_to_record(document.value) AS rule(
    permission text, "requiredPermissions" text[], "allowedScopes" text[]
  )
)
UPDATE "Role" r
SET "permissions" = ARRAY(
  SELECT rule.permission
  FROM migration_rules rule
  WHERE (r."permissions" @> rule."requiredPermissions" OR rule.permission = ANY(r."permissions"))
    AND r."scope"::text = ANY(rule."allowedScopes")
  ORDER BY rule.ordinality
), "updatedAt" = now()
WHERE r."isSystem" = false;

-- Refresh existing built-ins explicitly, and create the two new site roles.
-- Keep IDs/assignments. A custom role with a colliding name is never promoted
-- or overwritten; resolve that name collision before running the seed again.
INSERT INTO "Role" ("id", "workspaceId", "name", "description", "scope", "permissions", "isSystem", "createdAt", "updatedAt")
SELECT gen_random_uuid(), w."id", s.name, s.description, s.scope::"RoleScope", s.permissions, true, now(), now()
FROM "Workspace" w
CROSS JOIN (VALUES
  ('Company Administrator', 'Company ownership and full access across all sites.', 'WORKSPACE', ARRAY[
    'production:read','production:write','production:admin','planning:read','planning:write',
    'configuration:read','configuration:write','plant:admin','owner:all'
  ]),
  ('Plant Member', 'Plant membership and planning reads. Production access requires assigned workcenters.', 'SITE', ARRAY['planning:read']),
  ('Planner', 'Planning read/write access without site-wide production access.', 'SITE', ARRAY['planning:write']),
  ('Plant Engineer', 'Production administration, planning and configuration across the plant.', 'SITE', ARRAY[
    'production:admin','planning:write','configuration:write'
  ]),
  ('Plant Admin', 'Plant administrator with full plant data, settings and user management.', 'SITE', ARRAY[
    'production:admin','planning:write','configuration:write','plant:admin'
  ])
) AS s(name, description, scope, permissions)
ON CONFLICT ("workspaceId", "name", "scope") DO UPDATE
SET "permissions" = EXCLUDED."permissions", "description" = EXCLUDED."description", "updatedAt" = now()
WHERE "Role"."isSystem" = true;
