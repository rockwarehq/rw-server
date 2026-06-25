-- DropForeignKey
ALTER TABLE "GraphNode" DROP CONSTRAINT "GraphNode_documentId_fkey";

-- DropForeignKey
ALTER TABLE "GraphNode" DROP CONSTRAINT "GraphNode_schemaId_fkey";

-- DropForeignKey
ALTER TABLE "GraphProperty" DROP CONSTRAINT "GraphProperty_schemaFieldId_fkey";

-- DropIndex
DROP INDEX "GraphNode_documentId_idx";

-- DropIndex
DROP INDEX "GraphNode_recordId_idx";

-- DropIndex
DROP INDEX "GraphNode_schemaId_idx";

-- DropIndex
DROP INDEX "GraphNode_schemaId_recordId_idx";

-- DropIndex
DROP INDEX "GraphProperty_schemaFieldId_idx";

-- AlterTable
ALTER TABLE "GraphNode" DROP COLUMN "documentId",
DROP COLUMN "recordId",
DROP COLUMN "schemaId",
ADD COLUMN     "typeContext" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "typeRef" TEXT;

-- AlterTable
ALTER TABLE "GraphProperty" DROP COLUMN "schemaFieldId",
ADD COLUMN     "typeFieldKey" TEXT;

-- CreateTable
CREATE TABLE "GraphNodeType" (
    "id" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "GraphNodeType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GraphNodeTypeField" (
    "id" UUID NOT NULL,
    "typeId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT,
    "valueType" TEXT NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "resolverType" TEXT NOT NULL,
    "resolver" JSONB NOT NULL,
    "sampleRateMs" INTEGER,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "GraphNodeTypeField_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GraphNodeType_siteId_idx" ON "GraphNodeType"("siteId");

-- CreateIndex
CREATE INDEX "GraphNodeType_isDeleted_idx" ON "GraphNodeType"("isDeleted");

-- CreateIndex
CREATE UNIQUE INDEX "GraphNodeType_siteId_key_key" ON "GraphNodeType"("siteId", "key");

-- CreateIndex
CREATE INDEX "GraphNodeTypeField_typeId_idx" ON "GraphNodeTypeField"("typeId");

-- CreateIndex
CREATE INDEX "GraphNodeTypeField_isDeleted_idx" ON "GraphNodeTypeField"("isDeleted");

-- CreateIndex
CREATE UNIQUE INDEX "GraphNodeTypeField_typeId_key_key" ON "GraphNodeTypeField"("typeId", "key");

-- CreateIndex
CREATE INDEX "GraphNode_siteId_typeRef_idx" ON "GraphNode"("siteId", "typeRef");

-- CreateIndex
CREATE INDEX "GraphProperty_nodeId_typeFieldKey_idx" ON "GraphProperty"("nodeId", "typeFieldKey");

-- AddForeignKey
ALTER TABLE "GraphNodeType" ADD CONSTRAINT "GraphNodeType_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GraphNodeTypeField" ADD CONSTRAINT "GraphNodeTypeField_typeId_fkey" FOREIGN KEY ("typeId") REFERENCES "GraphNodeType"("id") ON DELETE CASCADE ON UPDATE CASCADE;
