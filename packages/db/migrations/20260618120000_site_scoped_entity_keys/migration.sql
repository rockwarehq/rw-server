-- Add site-scoped entity identity while preserving existing workspace-scoped rows.
ALTER TABLE "ObjectSchema"
ADD COLUMN "label" TEXT;

ALTER TABLE "ObjectSchema"
ADD COLUMN "displayFieldKey" TEXT;

ALTER TABLE "ObjectSchema"
ADD COLUMN "siteId" UUID;

ALTER TABLE "ObjectSchemaField"
ADD COLUMN "key" TEXT;

ALTER TABLE "ObjectSchemaField"
ADD COLUMN "label" TEXT;

ALTER TABLE "ObjectInstance"
ADD COLUMN "siteId" UUID;

UPDATE "ObjectSchema"
SET
  "label" = COALESCE("label", "name"),
  "key" = COALESCE(
    "key",
    regexp_replace(
      regexp_replace(lower(trim("name")), '[^a-z0-9]+', '_', 'g'),
      '^_+|_+$',
      '',
      'g'
    )
  );

UPDATE "ObjectSchemaField"
SET
  "label" = COALESCE("label", "name"),
  "key" = COALESCE(
    "key",
    regexp_replace(
      regexp_replace(lower(trim("name")), '[^a-z0-9]+', '_', 'g'),
      '^_+|_+$',
      '',
      'g'
    )
  );

-- Infer site scope for existing schemas/instances from graph bindings where available.
UPDATE "ObjectInstance" oi
SET "siteId" = gn."siteId"
FROM "GraphNode" gn
WHERE gn."documentId" = oi."id"
  AND oi."siteId" IS NULL;

UPDATE "ObjectSchema" os
SET "siteId" = oi."siteId"
FROM "ObjectInstance" oi
WHERE oi."schemaId" = os."id"
  AND oi."siteId" IS NOT NULL
  AND os."siteId" IS NULL;

ALTER TABLE "ObjectSchema"
ALTER COLUMN "key" SET NOT NULL;

ALTER TABLE "ObjectSchema"
ALTER COLUMN "label" SET NOT NULL;

ALTER TABLE "ObjectSchemaField"
ALTER COLUMN "key" SET NOT NULL;

ALTER TABLE "ObjectSchemaField"
ALTER COLUMN "label" SET NOT NULL;

DROP INDEX IF EXISTS "ObjectSchema_key_key";

CREATE UNIQUE INDEX "ObjectSchema_siteId_key_key" ON "ObjectSchema"("siteId", "key");
CREATE INDEX "ObjectSchema_siteId_idx" ON "ObjectSchema"("siteId");
CREATE UNIQUE INDEX "ObjectSchemaField_schemaId_key_key" ON "ObjectSchemaField"("schemaId", "key");
CREATE INDEX "ObjectInstance_siteId_idx" ON "ObjectInstance"("siteId");
CREATE INDEX "ObjectInstance_siteId_schemaId_isDeleted_idx" ON "ObjectInstance"("siteId", "schemaId", "isDeleted");

ALTER TABLE "ObjectSchema"
ADD CONSTRAINT "ObjectSchema_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ObjectInstance"
ADD CONSTRAINT "ObjectInstance_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;
