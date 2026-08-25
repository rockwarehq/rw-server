-- Labels + station filters, in one migration (no server has run any
-- earlier version of this work).
--
-- Creates: Label (one shared list of labels per site), LabelFilter (a
-- station's per-target filter criteria), and the link tables connecting
-- labels to jobs, tools, products, materials, stations, status/downtime
-- codes, and scrap codes.
--
-- Carries over, keeping ids where names don't collide:
--   * rows from the old never-wired ToolClassification/StationClassification
--     tables (and their station/tool attachments),
--   * ProcessType ("process groups") rows and their assignments — jobs,
--     stations (via current version), scrap codes, and status-code links
--     all become label attachments.
-- Then drops the old tables and columns. Workcenter.processTypeId is dropped
-- without conversion: it was only written by the legacy importer and read by
-- nothing. Generated with prisma migrate diff, resequenced
-- create -> carry-over -> drop so existing rows survive.

-- CreateEnum
CREATE TYPE "LabelFilterTarget" AS ENUM ('JOB', 'TOOL', 'STATUS_REASON', 'DISPOSITION_REASON');

-- CreateTable
CREATE TABLE "Label" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "siteId" UUID NOT NULL,

CONSTRAINT "Label_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LabelFilter" (
    "id" UUID NOT NULL,
    "stationId" UUID NOT NULL,
    "target" "LabelFilterTarget" NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

CONSTRAINT "LabelFilter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_ItemDispositionReasonToLabel" (
    "A" UUID NOT NULL,
    "B" UUID NOT NULL,

CONSTRAINT "_ItemDispositionReasonToLabel_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "_JobToLabel" (
    "A" UUID NOT NULL,
    "B" UUID NOT NULL,

CONSTRAINT "_JobToLabel_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "_LabelToTool" (
    "A" UUID NOT NULL,
    "B" UUID NOT NULL,

CONSTRAINT "_LabelToTool_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "_LabelToProduct" (
    "A" UUID NOT NULL,
    "B" UUID NOT NULL,

CONSTRAINT "_LabelToProduct_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "_LabelToMaterial" (
    "A" UUID NOT NULL,
    "B" UUID NOT NULL,

CONSTRAINT "_LabelToMaterial_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "_LabelToStation" (
    "A" UUID NOT NULL,
    "B" UUID NOT NULL,

CONSTRAINT "_LabelToStation_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "_LabelToStatusReason" (
    "A" UUID NOT NULL,
    "B" UUID NOT NULL,

CONSTRAINT "_LabelToStatusReason_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "_LabelToLabelFilter" (
    "A" UUID NOT NULL,
    "B" UUID NOT NULL,

CONSTRAINT "_LabelToLabelFilter_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE INDEX "Label_siteId_idx" ON "Label"("siteId");

-- CreateIndex
CREATE UNIQUE INDEX "Label_siteId_name_key" ON "Label"("siteId", "name");

-- CreateIndex
CREATE INDEX "LabelFilter_stationId_idx" ON "LabelFilter"("stationId");

-- CreateIndex
CREATE UNIQUE INDEX "LabelFilter_stationId_target_key" ON "LabelFilter"("stationId", "target");

-- CreateIndex
CREATE INDEX "_ItemDispositionReasonToLabel_B_index" ON "_ItemDispositionReasonToLabel"("B");

-- CreateIndex
CREATE INDEX "_JobToLabel_B_index" ON "_JobToLabel"("B");

-- CreateIndex
CREATE INDEX "_LabelToTool_B_index" ON "_LabelToTool"("B");

-- CreateIndex
CREATE INDEX "_LabelToProduct_B_index" ON "_LabelToProduct"("B");

-- CreateIndex
CREATE INDEX "_LabelToMaterial_B_index" ON "_LabelToMaterial"("B");

-- CreateIndex
CREATE INDEX "_LabelToStation_B_index" ON "_LabelToStation"("B");

-- CreateIndex
CREATE INDEX "_LabelToStatusReason_B_index" ON "_LabelToStatusReason"("B");

-- CreateIndex
CREATE INDEX "_LabelToLabelFilter_B_index" ON "_LabelToLabelFilter"("B");

-- AddForeignKey
ALTER TABLE "Label" ADD CONSTRAINT "Label_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LabelFilter" ADD CONSTRAINT "LabelFilter_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "Station"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_ItemDispositionReasonToLabel" ADD CONSTRAINT "_ItemDispositionReasonToLabel_A_fkey" FOREIGN KEY ("A") REFERENCES "ItemDispositionReason"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_ItemDispositionReasonToLabel" ADD CONSTRAINT "_ItemDispositionReasonToLabel_B_fkey" FOREIGN KEY ("B") REFERENCES "Label"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_JobToLabel" ADD CONSTRAINT "_JobToLabel_A_fkey" FOREIGN KEY ("A") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_JobToLabel" ADD CONSTRAINT "_JobToLabel_B_fkey" FOREIGN KEY ("B") REFERENCES "Label"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_LabelToTool" ADD CONSTRAINT "_LabelToTool_A_fkey" FOREIGN KEY ("A") REFERENCES "Label"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_LabelToTool" ADD CONSTRAINT "_LabelToTool_B_fkey" FOREIGN KEY ("B") REFERENCES "Tool"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_LabelToProduct" ADD CONSTRAINT "_LabelToProduct_A_fkey" FOREIGN KEY ("A") REFERENCES "Label"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_LabelToProduct" ADD CONSTRAINT "_LabelToProduct_B_fkey" FOREIGN KEY ("B") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_LabelToMaterial" ADD CONSTRAINT "_LabelToMaterial_A_fkey" FOREIGN KEY ("A") REFERENCES "Label"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_LabelToMaterial" ADD CONSTRAINT "_LabelToMaterial_B_fkey" FOREIGN KEY ("B") REFERENCES "Material"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_LabelToStation" ADD CONSTRAINT "_LabelToStation_A_fkey" FOREIGN KEY ("A") REFERENCES "Label"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_LabelToStation" ADD CONSTRAINT "_LabelToStation_B_fkey" FOREIGN KEY ("B") REFERENCES "Station"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_LabelToStatusReason" ADD CONSTRAINT "_LabelToStatusReason_A_fkey" FOREIGN KEY ("A") REFERENCES "Label"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_LabelToStatusReason" ADD CONSTRAINT "_LabelToStatusReason_B_fkey" FOREIGN KEY ("B") REFERENCES "StatusReason"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_LabelToLabelFilter" ADD CONSTRAINT "_LabelToLabelFilter_A_fkey" FOREIGN KEY ("A") REFERENCES "Label"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_LabelToLabelFilter" ADD CONSTRAINT "_LabelToLabelFilter_B_fkey" FOREIGN KEY ("B") REFERENCES "LabelFilter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Carry-over: old classification tables become labels ────────────────
INSERT INTO "Label" ("id", "name", "createdAt", "updatedAt", "siteId")
SELECT "id", "name", "createdAt", "updatedAt", "siteId"
FROM "StationClassification"
ON CONFLICT ("siteId", "name") DO NOTHING;

INSERT INTO "Label" ("id", "name", "createdAt", "updatedAt", "siteId")
SELECT "id", "name", "createdAt", "updatedAt", "siteId"
FROM "ToolClassification"
ON CONFLICT ("siteId", "name") DO NOTHING;

INSERT INTO "_LabelToStation" ("A", "B")
SELECT l."id", old."A"
FROM "_StationToStationClassification" old
JOIN "StationClassification" sc ON sc."id" = old."B"
JOIN "Label" l ON l."siteId" = sc."siteId" AND l."name" = sc."name"
ON CONFLICT DO NOTHING;

INSERT INTO "_LabelToTool" ("A", "B")
SELECT l."id", old."A"
FROM "_ToolToToolClassification" old
JOIN "ToolClassification" tc ON tc."id" = old."B"
JOIN "Label" l ON l."siteId" = tc."siteId" AND l."name" = tc."name"
ON CONFLICT DO NOTHING;

-- ── Carry-over: ProcessType ("process groups") becomes labels ───────────
INSERT INTO "Label" ("id", "name", "createdAt", "updatedAt", "siteId")
SELECT "id", "name", "createdAt", "updatedAt", "siteId"
FROM "ProcessType" WHERE "deletedAt" IS NULL
ON CONFLICT ("siteId", "name") DO NOTHING;

INSERT INTO "_JobToLabel" ("A", "B")
SELECT j."id", l."id"
FROM "Job" j
JOIN "ProcessType" pt ON pt."id" = j."processTypeId" AND pt."deletedAt" IS NULL
JOIN "Label" l ON l."siteId" = pt."siteId" AND l."name" = pt."name"
ON CONFLICT DO NOTHING;

INSERT INTO "_LabelToStation" ("A", "B")
SELECT l."id", s."id"
FROM "Station" s
JOIN "StationVersion" sv ON sv."id" = s."currentVersionId"
JOIN "ProcessType" pt ON pt."id" = sv."processTypeId" AND pt."deletedAt" IS NULL
JOIN "Label" l ON l."siteId" = pt."siteId" AND l."name" = pt."name"
ON CONFLICT DO NOTHING;

INSERT INTO "_ItemDispositionReasonToLabel" ("A", "B")
SELECT r."id", l."id"
FROM "ItemDispositionReason" r
JOIN "ProcessType" pt ON pt."id" = r."processTypeId" AND pt."deletedAt" IS NULL
JOIN "Label" l ON l."siteId" = pt."siteId" AND l."name" = pt."name"
ON CONFLICT DO NOTHING;

INSERT INTO "_LabelToStatusReason" ("A", "B")
SELECT l."id", x."B"
FROM "_ProcessTypeToStatusReason" x
JOIN "ProcessType" pt ON pt."id" = x."A" AND pt."deletedAt" IS NULL
JOIN "Label" l ON l."siteId" = pt."siteId" AND l."name" = pt."name"
ON CONFLICT DO NOTHING;

-- DropForeignKey
ALTER TABLE "ItemDispositionReason" DROP CONSTRAINT "ItemDispositionReason_processTypeId_fkey";

-- DropForeignKey
ALTER TABLE "Job" DROP CONSTRAINT "Job_processTypeId_fkey";

-- DropForeignKey
ALTER TABLE "ToolClassification" DROP CONSTRAINT "ToolClassification_siteId_fkey";

-- DropForeignKey
ALTER TABLE "Workcenter" DROP CONSTRAINT "Workcenter_processTypeId_fkey";

-- DropForeignKey
ALTER TABLE "StationVersion" DROP CONSTRAINT "StationVersion_processTypeId_fkey";

-- DropForeignKey
ALTER TABLE "StationClassification" DROP CONSTRAINT "StationClassification_siteId_fkey";

-- DropForeignKey
ALTER TABLE "ProcessType" DROP CONSTRAINT "ProcessType_siteId_fkey";

-- DropForeignKey
ALTER TABLE "_ToolToToolClassification" DROP CONSTRAINT "_ToolToToolClassification_A_fkey";

-- DropForeignKey
ALTER TABLE "_ToolToToolClassification" DROP CONSTRAINT "_ToolToToolClassification_B_fkey";

-- DropForeignKey
ALTER TABLE "_StationToStationClassification" DROP CONSTRAINT "_StationToStationClassification_A_fkey";

-- DropForeignKey
ALTER TABLE "_StationToStationClassification" DROP CONSTRAINT "_StationToStationClassification_B_fkey";

-- DropForeignKey
ALTER TABLE "_ProcessTypeToStatusReason" DROP CONSTRAINT "_ProcessTypeToStatusReason_A_fkey";

-- DropForeignKey
ALTER TABLE "_ProcessTypeToStatusReason" DROP CONSTRAINT "_ProcessTypeToStatusReason_B_fkey";

-- DropIndex
DROP INDEX "Job_processTypeId_idx";

-- AlterTable
ALTER TABLE "ItemDispositionReason" DROP COLUMN "processTypeId";

-- AlterTable
ALTER TABLE "Job" DROP COLUMN "processTypeId";

-- AlterTable
ALTER TABLE "Workcenter" DROP COLUMN "processTypeId";

-- AlterTable
ALTER TABLE "StationVersion" DROP COLUMN "processTypeId";

-- DropTable
DROP TABLE "ToolClassification";

-- DropTable
DROP TABLE "StationClassification";

-- DropTable
DROP TABLE "ProcessType";

-- DropTable
DROP TABLE "_ToolToToolClassification";

-- DropTable
DROP TABLE "_StationToStationClassification";

-- DropTable
DROP TABLE "_ProcessTypeToStatusReason";

-- DropEnum
DROP TYPE "ToolClassificationType";

-- DropEnum
DROP TYPE "StationClassificationType";
