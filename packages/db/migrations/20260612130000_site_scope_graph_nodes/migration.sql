-- Existing graph rows are disposable for this transition.
DELETE FROM "GraphEdge";
DELETE FROM "GraphProperty";
DELETE FROM "GraphNode";

-- Drop global node-name uniqueness; graph nodes are site scoped.
DROP INDEX "GraphNode_name_key";

ALTER TABLE "GraphNode" ADD COLUMN "siteId" UUID NOT NULL;

CREATE INDEX "GraphNode_siteId_idx" ON "GraphNode"("siteId");
CREATE UNIQUE INDEX "GraphNode_siteId_name_key" ON "GraphNode"("siteId", "name");

ALTER TABLE "GraphNode" ADD CONSTRAINT "GraphNode_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;
