-- Labels: rename Classification -> Label (keeping all rows and attachments),
-- drop the kind field (station filters replace capability matching), add
-- labels to status/downtime and scrap codes, add LabelFilter (a station's
-- per-target filter criteria), and absorb ProcessType ("process groups"):
-- its rows become labels, its assignments become label attachments, then the
-- model is dropped. Hand-written renames because prisma migrate diff only
-- produces drop+create, which would lose data.

-- ── 1. Classification -> Label ──────────────────────────────────────────
ALTER TABLE "Classification" RENAME TO "Label";
ALTER TABLE "Label" DROP COLUMN "kind";
DROP TYPE "ClassificationKind";
ALTER INDEX "Classification_pkey" RENAME TO "Label_pkey";
ALTER INDEX "Classification_siteId_idx" RENAME TO "Label_siteId_idx";
ALTER INDEX "Classification_siteId_name_key" RENAME TO "Label_siteId_name_key";
ALTER TABLE "Label" RENAME CONSTRAINT "Classification_siteId_fkey" TO "Label_siteId_fkey";

-- ── 2. Rename the link tables whose column order stays the same ─────────
-- (Prisma sorts the two model names; Label sorts before Tool/Product/
-- Material/Station just like Classification did, so A/B keep their meaning.)
ALTER TABLE "_ClassificationToTool" RENAME TO "_LabelToTool";
ALTER INDEX "_ClassificationToTool_AB_pkey" RENAME TO "_LabelToTool_AB_pkey";
ALTER INDEX "_ClassificationToTool_B_index" RENAME TO "_LabelToTool_B_index";
ALTER TABLE "_LabelToTool" RENAME CONSTRAINT "_ClassificationToTool_A_fkey" TO "_LabelToTool_A_fkey";
ALTER TABLE "_LabelToTool" RENAME CONSTRAINT "_ClassificationToTool_B_fkey" TO "_LabelToTool_B_fkey";

ALTER TABLE "_ClassificationToProduct" RENAME TO "_LabelToProduct";
ALTER INDEX "_ClassificationToProduct_AB_pkey" RENAME TO "_LabelToProduct_AB_pkey";
ALTER INDEX "_ClassificationToProduct_B_index" RENAME TO "_LabelToProduct_B_index";
ALTER TABLE "_LabelToProduct" RENAME CONSTRAINT "_ClassificationToProduct_A_fkey" TO "_LabelToProduct_A_fkey";
ALTER TABLE "_LabelToProduct" RENAME CONSTRAINT "_ClassificationToProduct_B_fkey" TO "_LabelToProduct_B_fkey";

ALTER TABLE "_ClassificationToMaterial" RENAME TO "_LabelToMaterial";
ALTER INDEX "_ClassificationToMaterial_AB_pkey" RENAME TO "_LabelToMaterial_AB_pkey";
ALTER INDEX "_ClassificationToMaterial_B_index" RENAME TO "_LabelToMaterial_B_index";
ALTER TABLE "_LabelToMaterial" RENAME CONSTRAINT "_ClassificationToMaterial_A_fkey" TO "_LabelToMaterial_A_fkey";
ALTER TABLE "_LabelToMaterial" RENAME CONSTRAINT "_ClassificationToMaterial_B_fkey" TO "_LabelToMaterial_B_fkey";

ALTER TABLE "_ClassificationToStation" RENAME TO "_LabelToStation";
ALTER INDEX "_ClassificationToStation_AB_pkey" RENAME TO "_LabelToStation_AB_pkey";
ALTER INDEX "_ClassificationToStation_B_index" RENAME TO "_LabelToStation_B_index";
ALTER TABLE "_LabelToStation" RENAME CONSTRAINT "_ClassificationToStation_A_fkey" TO "_LabelToStation_A_fkey";
ALTER TABLE "_LabelToStation" RENAME CONSTRAINT "_ClassificationToStation_B_fkey" TO "_LabelToStation_B_fkey";

-- ── 3. Job's link table: Job sorts before Label, so A/B swap sides ──────
CREATE TABLE "_JobToLabel" (
    "A" UUID NOT NULL,
    "B" UUID NOT NULL,

    CONSTRAINT "_JobToLabel_AB_pkey" PRIMARY KEY ("A","B")
);
INSERT INTO "_JobToLabel" ("A", "B")
SELECT "B", "A" FROM "_ClassificationToJob";
CREATE INDEX "_JobToLabel_B_index" ON "_JobToLabel"("B");
ALTER TABLE "_JobToLabel" ADD CONSTRAINT "_JobToLabel_A_fkey" FOREIGN KEY ("A") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "_JobToLabel" ADD CONSTRAINT "_JobToLabel_B_fkey" FOREIGN KEY ("B") REFERENCES "Label"("id") ON DELETE CASCADE ON UPDATE CASCADE;
DROP TABLE "_ClassificationToJob";

-- ── 4. New: labels on codes, and station filters ────────────────────────
CREATE TYPE "LabelFilterTarget" AS ENUM ('JOB', 'TOOL', 'STATUS_REASON', 'DISPOSITION_REASON');

CREATE TABLE "LabelFilter" (
    "id" UUID NOT NULL,
    "stationId" UUID NOT NULL,
    "target" "LabelFilterTarget" NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "LabelFilter_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "LabelFilter_stationId_idx" ON "LabelFilter"("stationId");
CREATE UNIQUE INDEX "LabelFilter_stationId_target_key" ON "LabelFilter"("stationId", "target");
ALTER TABLE "LabelFilter" ADD CONSTRAINT "LabelFilter_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "Station"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "_LabelToLabelFilter" (
    "A" UUID NOT NULL,
    "B" UUID NOT NULL,

    CONSTRAINT "_LabelToLabelFilter_AB_pkey" PRIMARY KEY ("A","B")
);
CREATE INDEX "_LabelToLabelFilter_B_index" ON "_LabelToLabelFilter"("B");
ALTER TABLE "_LabelToLabelFilter" ADD CONSTRAINT "_LabelToLabelFilter_A_fkey" FOREIGN KEY ("A") REFERENCES "Label"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "_LabelToLabelFilter" ADD CONSTRAINT "_LabelToLabelFilter_B_fkey" FOREIGN KEY ("B") REFERENCES "LabelFilter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "_LabelToStatusReason" (
    "A" UUID NOT NULL,
    "B" UUID NOT NULL,

    CONSTRAINT "_LabelToStatusReason_AB_pkey" PRIMARY KEY ("A","B")
);
CREATE INDEX "_LabelToStatusReason_B_index" ON "_LabelToStatusReason"("B");
ALTER TABLE "_LabelToStatusReason" ADD CONSTRAINT "_LabelToStatusReason_A_fkey" FOREIGN KEY ("A") REFERENCES "Label"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "_LabelToStatusReason" ADD CONSTRAINT "_LabelToStatusReason_B_fkey" FOREIGN KEY ("B") REFERENCES "StatusReason"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "_ItemDispositionReasonToLabel" (
    "A" UUID NOT NULL,
    "B" UUID NOT NULL,

    CONSTRAINT "_ItemDispositionReasonToLabel_AB_pkey" PRIMARY KEY ("A","B")
);
CREATE INDEX "_ItemDispositionReasonToLabel_B_index" ON "_ItemDispositionReasonToLabel"("B");
ALTER TABLE "_ItemDispositionReasonToLabel" ADD CONSTRAINT "_ItemDispositionReasonToLabel_A_fkey" FOREIGN KEY ("A") REFERENCES "ItemDispositionReason"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "_ItemDispositionReasonToLabel" ADD CONSTRAINT "_ItemDispositionReasonToLabel_B_fkey" FOREIGN KEY ("B") REFERENCES "Label"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── 5. Absorb ProcessType ("process groups") into labels ────────────────
-- Each live process type becomes a label with the same name (skipped if a
-- label with that name already exists at the site; attachments below map by
-- site+name so they land on the surviving label either way).
INSERT INTO "Label" ("id", "name", "attrs", "createdAt", "updatedAt", "siteId")
SELECT "id", "name", '{}'::jsonb, "createdAt", "updatedAt", "siteId"
FROM "ProcessType" WHERE "deletedAt" IS NULL
ON CONFLICT ("siteId", "name") DO NOTHING;

-- Jobs that had a process type get that label.
INSERT INTO "_JobToLabel" ("A", "B")
SELECT j."id", l."id"
FROM "Job" j
JOIN "ProcessType" pt ON pt."id" = j."processTypeId" AND pt."deletedAt" IS NULL
JOIN "Label" l ON l."siteId" = pt."siteId" AND l."name" = pt."name"
ON CONFLICT DO NOTHING;

-- Stations get their current version's process type as a label.
INSERT INTO "_LabelToStation" ("A", "B")
SELECT l."id", s."id"
FROM "Station" s
JOIN "StationVersion" sv ON sv."id" = s."currentVersionId"
JOIN "ProcessType" pt ON pt."id" = sv."processTypeId" AND pt."deletedAt" IS NULL
JOIN "Label" l ON l."siteId" = pt."siteId" AND l."name" = pt."name"
ON CONFLICT DO NOTHING;

-- Scrap codes that had a process type get that label.
INSERT INTO "_ItemDispositionReasonToLabel" ("A", "B")
SELECT r."id", l."id"
FROM "ItemDispositionReason" r
JOIN "ProcessType" pt ON pt."id" = r."processTypeId" AND pt."deletedAt" IS NULL
JOIN "Label" l ON l."siteId" = pt."siteId" AND l."name" = pt."name"
ON CONFLICT DO NOTHING;

-- Status/downtime codes linked to process types get those labels.
INSERT INTO "_LabelToStatusReason" ("A", "B")
SELECT l."id", x."B"
FROM "_ProcessTypeToStatusReason" x
JOIN "ProcessType" pt ON pt."id" = x."A" AND pt."deletedAt" IS NULL
JOIN "Label" l ON l."siteId" = pt."siteId" AND l."name" = pt."name"
ON CONFLICT DO NOTHING;

-- ── 6. Drop ProcessType ─────────────────────────────────────────────────
-- Workcenter.processTypeId is written only by the legacy importer and read
-- by nothing, so it is dropped without conversion.
ALTER TABLE "Workcenter" DROP COLUMN "processTypeId";
ALTER TABLE "StationVersion" DROP COLUMN "processTypeId";
ALTER TABLE "Job" DROP COLUMN "processTypeId";
ALTER TABLE "ItemDispositionReason" DROP COLUMN "processTypeId";
DROP TABLE "_ProcessTypeToStatusReason";
DROP TABLE "ProcessType";
