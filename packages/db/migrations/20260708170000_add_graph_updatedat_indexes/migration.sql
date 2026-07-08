-- Livestore's 30s definition reconcile filters GraphNode/GraphProperty/GraphHook
-- on updatedAt; without these indexes each reconcile is a full table scan.

-- CreateIndex
CREATE INDEX "GraphNode_updatedAt_idx" ON "GraphNode"("updatedAt");

-- CreateIndex
CREATE INDEX "GraphProperty_updatedAt_idx" ON "GraphProperty"("updatedAt");

-- CreateIndex
CREATE INDEX "GraphHook_updatedAt_idx" ON "GraphHook"("updatedAt");
