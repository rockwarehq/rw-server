-- CreateTable
CREATE TABLE "GraphNode" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT,
    "entityType" TEXT,
    "entityId" TEXT,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "GraphNode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GraphProperty" (
    "id" UUID NOT NULL,
    "nodeId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "resolverType" TEXT NOT NULL,
    "resolver" JSONB NOT NULL,
    "sampleRateMs" INTEGER,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "GraphProperty_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GraphEdge" (
    "id" UUID NOT NULL,
    "fromPropertyId" UUID NOT NULL,
    "toPropertyId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GraphEdge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GraphNode_name_key" ON "GraphNode"("name");

-- CreateIndex
CREATE UNIQUE INDEX "GraphNode_entityType_entityId_key" ON "GraphNode"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "GraphNode_kind_idx" ON "GraphNode"("kind");

-- CreateIndex
CREATE INDEX "GraphNode_isDeleted_idx" ON "GraphNode"("isDeleted");

-- CreateIndex
CREATE UNIQUE INDEX "GraphProperty_nodeId_name_key" ON "GraphProperty"("nodeId", "name");

-- CreateIndex
CREATE INDEX "GraphProperty_resolverType_idx" ON "GraphProperty"("resolverType");

-- CreateIndex
CREATE INDEX "GraphProperty_isDeleted_idx" ON "GraphProperty"("isDeleted");

-- CreateIndex
CREATE UNIQUE INDEX "GraphEdge_fromPropertyId_toPropertyId_key" ON "GraphEdge"("fromPropertyId", "toPropertyId");

-- CreateIndex
CREATE INDEX "GraphEdge_fromPropertyId_idx" ON "GraphEdge"("fromPropertyId");

-- CreateIndex
CREATE INDEX "GraphEdge_toPropertyId_idx" ON "GraphEdge"("toPropertyId");

-- AddForeignKey
ALTER TABLE "GraphProperty" ADD CONSTRAINT "GraphProperty_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "GraphNode"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GraphEdge" ADD CONSTRAINT "GraphEdge_fromPropertyId_fkey" FOREIGN KEY ("fromPropertyId") REFERENCES "GraphProperty"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GraphEdge" ADD CONSTRAINT "GraphEdge_toPropertyId_fkey" FOREIGN KEY ("toPropertyId") REFERENCES "GraphProperty"("id") ON DELETE CASCADE ON UPDATE CASCADE;
