-- CreateEnum
CREATE TYPE "ObjectFieldType" AS ENUM ('TEXT', 'NUMBER', 'BOOLEAN', 'DATE', 'TIMESTAMP', 'SELECT', 'JSON', 'OBJECT');

-- DropIndex
DROP INDEX "GraphNode_entityType_entityId_key";

-- DropIndex
DROP INDEX "GraphNode_kind_idx";

-- AlterTable
ALTER TABLE "GraphNode" DROP COLUMN "kind",
DROP COLUMN "entityType",
DROP COLUMN "entityId",
ADD COLUMN "schemaId" UUID;

-- AlterTable
ALTER TABLE "GraphProperty" ADD COLUMN "schemaFieldId" UUID;

-- CreateTable
CREATE TABLE "ObjectSchema" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "workspaceId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ObjectSchema_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ObjectSchemaField" (
    "id" UUID NOT NULL,
    "schemaId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "type" "ObjectFieldType" NOT NULL,
    "refSchemaId" UUID,
    "isList" BOOLEAN NOT NULL DEFAULT false,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "config" JSONB,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ObjectSchemaField_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ObjectInstance" (
    "id" UUID NOT NULL,
    "schemaId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "values" JSONB NOT NULL DEFAULT '{}',
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ObjectInstance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ObjectSchema_workspaceId_name_key" ON "ObjectSchema"("workspaceId", "name");

-- CreateIndex
CREATE INDEX "ObjectSchema_workspaceId_idx" ON "ObjectSchema"("workspaceId");

-- CreateIndex
CREATE INDEX "ObjectSchema_isDeleted_idx" ON "ObjectSchema"("isDeleted");

-- CreateIndex
CREATE UNIQUE INDEX "ObjectSchemaField_schemaId_name_key" ON "ObjectSchemaField"("schemaId", "name");

-- CreateIndex
CREATE INDEX "ObjectSchemaField_schemaId_idx" ON "ObjectSchemaField"("schemaId");

-- CreateIndex
CREATE INDEX "ObjectSchemaField_refSchemaId_idx" ON "ObjectSchemaField"("refSchemaId");

-- CreateIndex
CREATE INDEX "ObjectSchemaField_type_idx" ON "ObjectSchemaField"("type");

-- CreateIndex
CREATE INDEX "ObjectSchemaField_isDeleted_idx" ON "ObjectSchemaField"("isDeleted");

-- CreateIndex
CREATE INDEX "ObjectInstance_schemaId_idx" ON "ObjectInstance"("schemaId");

-- CreateIndex
CREATE INDEX "ObjectInstance_schemaId_isDeleted_idx" ON "ObjectInstance"("schemaId", "isDeleted");

-- CreateIndex
CREATE INDEX "ObjectInstance_values_idx" ON "ObjectInstance" USING GIN ("values");

-- CreateIndex
CREATE INDEX "GraphNode_schemaId_idx" ON "GraphNode"("schemaId");

-- CreateIndex
CREATE INDEX "GraphProperty_schemaFieldId_idx" ON "GraphProperty"("schemaFieldId");

-- AddForeignKey
ALTER TABLE "GraphNode" ADD CONSTRAINT "GraphNode_schemaId_fkey" FOREIGN KEY ("schemaId") REFERENCES "ObjectSchema"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GraphProperty" ADD CONSTRAINT "GraphProperty_schemaFieldId_fkey" FOREIGN KEY ("schemaFieldId") REFERENCES "ObjectSchemaField"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ObjectSchema" ADD CONSTRAINT "ObjectSchema_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ObjectSchemaField" ADD CONSTRAINT "ObjectSchemaField_schemaId_fkey" FOREIGN KEY ("schemaId") REFERENCES "ObjectSchema"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ObjectSchemaField" ADD CONSTRAINT "ObjectSchemaField_refSchemaId_fkey" FOREIGN KEY ("refSchemaId") REFERENCES "ObjectSchema"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ObjectInstance" ADD CONSTRAINT "ObjectInstance_schemaId_fkey" FOREIGN KEY ("schemaId") REFERENCES "ObjectSchema"("id") ON DELETE CASCADE ON UPDATE CASCADE;
