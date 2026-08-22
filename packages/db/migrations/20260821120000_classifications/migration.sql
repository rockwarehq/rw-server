-- Classification: one site-scoped vocabulary (GROUP labels + CAPABILITY
-- matching) applied m2m to Job/Tool/Product/Material/Station. Supersedes the
-- never-wired ToolClassification/StationClassification. Prisma-generated via
-- migrate diff (PG16 shadow-DB replay is broken by rename_blob_to_version),
-- resequenced create -> carry-over -> drop so existing rows survive.

-- CreateEnum
CREATE TYPE "ClassificationKind" AS ENUM ('GROUP', 'CAPABILITY');

-- CreateTable
CREATE TABLE "Classification" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "ClassificationKind" NOT NULL DEFAULT 'GROUP',
    "attrs" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "siteId" UUID NOT NULL,

CONSTRAINT "Classification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_ClassificationToJob" (
    "A" UUID NOT NULL,
    "B" UUID NOT NULL,

CONSTRAINT "_ClassificationToJob_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "_ClassificationToTool" (
    "A" UUID NOT NULL,
    "B" UUID NOT NULL,

CONSTRAINT "_ClassificationToTool_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "_ClassificationToProduct" (
    "A" UUID NOT NULL,
    "B" UUID NOT NULL,

CONSTRAINT "_ClassificationToProduct_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "_ClassificationToMaterial" (
    "A" UUID NOT NULL,
    "B" UUID NOT NULL,

CONSTRAINT "_ClassificationToMaterial_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "_ClassificationToStation" (
    "A" UUID NOT NULL,
    "B" UUID NOT NULL,

CONSTRAINT "_ClassificationToStation_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE INDEX "Classification_siteId_idx" ON "Classification"("siteId");

-- CreateIndex
CREATE UNIQUE INDEX "Classification_siteId_name_key" ON "Classification"("siteId", "name");

-- CreateIndex
CREATE INDEX "_ClassificationToJob_B_index" ON "_ClassificationToJob"("B");

-- CreateIndex
CREATE INDEX "_ClassificationToTool_B_index" ON "_ClassificationToTool"("B");

-- CreateIndex
CREATE INDEX "_ClassificationToProduct_B_index" ON "_ClassificationToProduct"("B");

-- CreateIndex
CREATE INDEX "_ClassificationToMaterial_B_index" ON "_ClassificationToMaterial"("B");

-- CreateIndex
CREATE INDEX "_ClassificationToStation_B_index" ON "_ClassificationToStation"("B");

-- AddForeignKey
ALTER TABLE "Classification" ADD CONSTRAINT "Classification_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_ClassificationToJob" ADD CONSTRAINT "_ClassificationToJob_A_fkey" FOREIGN KEY ("A") REFERENCES "Classification"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_ClassificationToJob" ADD CONSTRAINT "_ClassificationToJob_B_fkey" FOREIGN KEY ("B") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_ClassificationToTool" ADD CONSTRAINT "_ClassificationToTool_A_fkey" FOREIGN KEY ("A") REFERENCES "Classification"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_ClassificationToTool" ADD CONSTRAINT "_ClassificationToTool_B_fkey" FOREIGN KEY ("B") REFERENCES "Tool"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_ClassificationToProduct" ADD CONSTRAINT "_ClassificationToProduct_A_fkey" FOREIGN KEY ("A") REFERENCES "Classification"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_ClassificationToProduct" ADD CONSTRAINT "_ClassificationToProduct_B_fkey" FOREIGN KEY ("B") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_ClassificationToMaterial" ADD CONSTRAINT "_ClassificationToMaterial_A_fkey" FOREIGN KEY ("A") REFERENCES "Classification"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_ClassificationToMaterial" ADD CONSTRAINT "_ClassificationToMaterial_B_fkey" FOREIGN KEY ("B") REFERENCES "Material"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_ClassificationToStation" ADD CONSTRAINT "_ClassificationToStation_A_fkey" FOREIGN KEY ("A") REFERENCES "Classification"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_ClassificationToStation" ADD CONSTRAINT "_ClassificationToStation_B_fkey" FOREIGN KEY ("B") REFERENCES "Station"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Carry over rows from the superseded classification tables (id-preserving,
-- so saved shift-view classificationIds keep resolving). MACHINE_SPEC maps to
-- CAPABILITY; name collisions across the two old tables are skipped.
INSERT INTO "Classification" ("id", "name", "kind", "attrs", "createdAt", "updatedAt", "siteId")
SELECT "id", "name",
       (CASE WHEN "type" = 'MACHINE_SPEC' THEN 'CAPABILITY' ELSE 'GROUP' END)::"ClassificationKind",
       "attrs", "createdAt", "updatedAt", "siteId"
FROM "StationClassification"
ON CONFLICT ("siteId", "name") DO NOTHING;

INSERT INTO "Classification" ("id", "name", "kind", "attrs", "createdAt", "updatedAt", "siteId")
SELECT "id", "name",
       (CASE WHEN "type" = 'MACHINE_SPEC' THEN 'CAPABILITY' ELSE 'GROUP' END)::"ClassificationKind",
       "attrs", "createdAt", "updatedAt", "siteId"
FROM "ToolClassification"
ON CONFLICT ("siteId", "name") DO NOTHING;

INSERT INTO "_ClassificationToStation" ("A", "B")
SELECT old."B", old."A"
FROM "_StationToStationClassification" old
JOIN "Classification" c ON c."id" = old."B";

INSERT INTO "_ClassificationToTool" ("A", "B")
SELECT old."B", old."A"
FROM "_ToolToToolClassification" old
JOIN "Classification" c ON c."id" = old."B";

-- DropForeignKey
ALTER TABLE "ToolClassification" DROP CONSTRAINT "ToolClassification_siteId_fkey";

-- DropForeignKey
ALTER TABLE "StationClassification" DROP CONSTRAINT "StationClassification_siteId_fkey";

-- DropForeignKey
ALTER TABLE "_ToolToToolClassification" DROP CONSTRAINT "_ToolToToolClassification_A_fkey";

-- DropForeignKey
ALTER TABLE "_ToolToToolClassification" DROP CONSTRAINT "_ToolToToolClassification_B_fkey";

-- DropForeignKey
ALTER TABLE "_StationToStationClassification" DROP CONSTRAINT "_StationToStationClassification_A_fkey";

-- DropForeignKey
ALTER TABLE "_StationToStationClassification" DROP CONSTRAINT "_StationToStationClassification_B_fkey";

-- DropTable
DROP TABLE "ToolClassification";

-- DropTable
DROP TABLE "StationClassification";

-- DropTable
DROP TABLE "_ToolToToolClassification";

-- DropTable
DROP TABLE "_StationToStationClassification";

-- DropEnum
DROP TYPE "ToolClassificationType";

-- DropEnum
DROP TYPE "StationClassificationType";
