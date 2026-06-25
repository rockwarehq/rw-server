-- AlterTable
ALTER TABLE "GraphNode" ADD COLUMN "facets" JSONB NOT NULL DEFAULT '{}';

-- CreateIndex
CREATE INDEX "GraphNode_facets_idx" ON "GraphNode" USING GIN ("facets");
