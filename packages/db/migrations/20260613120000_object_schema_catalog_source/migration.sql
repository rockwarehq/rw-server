-- CreateEnum
CREATE TYPE "ObjectSchemaSource" AS ENUM ('RECORD', 'DOCUMENT');

-- Extend ObjectSchema into the data catalog definition layer.
ALTER TABLE "ObjectSchema"
ADD COLUMN "key" TEXT,
ADD COLUMN "source" "ObjectSchemaSource" NOT NULL DEFAULT 'DOCUMENT',
ADD COLUMN "meta" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN "isSystem" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE UNIQUE INDEX "ObjectSchema_key_key" ON "ObjectSchema"("key");

-- CreateIndex
CREATE INDEX "ObjectSchema_source_idx" ON "ObjectSchema"("source");

-- CreateIndex
CREATE INDEX "ObjectSchema_isSystem_idx" ON "ObjectSchema"("isSystem");

-- Rename graph document binding terminology while preserving existing data.
ALTER TABLE "GraphNode" RENAME COLUMN "objectInstanceId" TO "documentId";
ALTER INDEX "GraphNode_objectInstanceId_idx" RENAME TO "GraphNode_documentId_idx";
ALTER TABLE "GraphNode" RENAME CONSTRAINT "GraphNode_objectInstanceId_fkey" TO "GraphNode_documentId_fkey";

-- Add system-record binding support.
ALTER TABLE "GraphNode" ADD COLUMN "recordId" UUID;

-- CreateIndex
CREATE INDEX "GraphNode_recordId_idx" ON "GraphNode"("recordId");

-- CreateIndex
CREATE INDEX "GraphNode_schemaId_recordId_idx" ON "GraphNode"("schemaId", "recordId");

-- Rename persisted entity resolver payloads from objectInstanceId to documentId.
UPDATE "GraphProperty"
SET "resolver" = jsonb_set("resolver" - 'objectInstanceId', '{documentId}', "resolver"->'objectInstanceId', true)
WHERE "resolverType" = 'entity'
  AND "resolver" ? 'objectInstanceId';
