-- CreateTable
CREATE TABLE "GraphNodeTypeInput" (
    "id" UUID NOT NULL,
    "typeId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT,
    "valueType" TEXT NOT NULL,
    "entityKey" TEXT,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "GraphNodeTypeInput_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GraphNodeTypeFacet" (
    "id" UUID NOT NULL,
    "typeId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT,
    "valueType" TEXT,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "resolverType" TEXT NOT NULL,
    "resolver" JSONB NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "GraphNodeTypeFacet_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GraphNodeTypeInput_typeId_idx" ON "GraphNodeTypeInput"("typeId");

-- CreateIndex
CREATE INDEX "GraphNodeTypeInput_isDeleted_idx" ON "GraphNodeTypeInput"("isDeleted");

-- CreateIndex
CREATE UNIQUE INDEX "GraphNodeTypeInput_typeId_key_key" ON "GraphNodeTypeInput"("typeId", "key");

-- CreateIndex
CREATE INDEX "GraphNodeTypeFacet_typeId_idx" ON "GraphNodeTypeFacet"("typeId");

-- CreateIndex
CREATE INDEX "GraphNodeTypeFacet_resolverType_idx" ON "GraphNodeTypeFacet"("resolverType");

-- CreateIndex
CREATE INDEX "GraphNodeTypeFacet_isDeleted_idx" ON "GraphNodeTypeFacet"("isDeleted");

-- CreateIndex
CREATE UNIQUE INDEX "GraphNodeTypeFacet_typeId_key_key" ON "GraphNodeTypeFacet"("typeId", "key");

-- AddForeignKey
ALTER TABLE "GraphNodeTypeInput" ADD CONSTRAINT "GraphNodeTypeInput_typeId_fkey" FOREIGN KEY ("typeId") REFERENCES "GraphNodeType"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GraphNodeTypeFacet" ADD CONSTRAINT "GraphNodeTypeFacet_typeId_fkey" FOREIGN KEY ("typeId") REFERENCES "GraphNodeType"("id") ON DELETE CASCADE ON UPDATE CASCADE;
