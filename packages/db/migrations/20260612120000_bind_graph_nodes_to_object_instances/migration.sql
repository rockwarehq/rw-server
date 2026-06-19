-- AlterTable
ALTER TABLE "GraphNode" ADD COLUMN "objectInstanceId" UUID;

-- CreateIndex
CREATE INDEX "GraphNode_objectInstanceId_idx" ON "GraphNode"("objectInstanceId");

-- AddForeignKey
ALTER TABLE "GraphNode" ADD CONSTRAINT "GraphNode_objectInstanceId_fkey" FOREIGN KEY ("objectInstanceId") REFERENCES "ObjectInstance"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill new RBAC resources onto built-in system roles.
UPDATE "Role"
SET "permissions" = "permissions" || COALESCE((
    SELECT array_agg(permission)
    FROM unnest(ARRAY['entity:read', 'entity:write', 'entity:admin', 'graph:read', 'graph:write', 'graph:admin']::text[]) AS permission
    WHERE NOT permission = ANY("permissions")
  ), ARRAY[]::text[])
WHERE "isSystem" = true AND "name" = 'Company Administrator' AND "scope" = 'WORKSPACE';

UPDATE "Role"
SET "permissions" = "permissions" || COALESCE((
    SELECT array_agg(permission)
    FROM unnest(ARRAY['entity:read', 'entity:write', 'entity:admin', 'graph:read', 'graph:write', 'graph:admin']::text[]) AS permission
    WHERE NOT permission = ANY("permissions")
  ), ARRAY[]::text[])
WHERE "isSystem" = true AND "name" = 'Factory Administrator' AND "scope" = 'SITE';

UPDATE "Role"
SET "permissions" = "permissions" || COALESCE((
    SELECT array_agg(permission)
    FROM unnest(ARRAY['entity:read', 'entity:write', 'graph:read', 'graph:write']::text[]) AS permission
    WHERE NOT permission = ANY("permissions")
  ), ARRAY[]::text[])
WHERE "isSystem" = true AND "name" = 'Office User' AND "scope" = 'SITE';

UPDATE "Role"
SET "permissions" = "permissions" || COALESCE((
    SELECT array_agg(permission)
    FROM unnest(ARRAY['entity:read', 'graph:read']::text[]) AS permission
    WHERE NOT permission = ANY("permissions")
  ), ARRAY[]::text[])
WHERE "isSystem" = true AND "name" = 'Read-only User' AND "scope" = 'SITE';
