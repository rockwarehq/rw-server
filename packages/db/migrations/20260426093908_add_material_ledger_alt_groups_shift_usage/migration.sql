-- Material ledger system: append-only quantity log (immutable rows) +
-- staging table for in-shift consumption that flushes to immutable ledger
-- entries at shift close, plus product-material alt groups for swappable
-- materials.

-- ============================================================================
-- Enums
-- ============================================================================

CREATE TYPE "MaterialLedgerKind" AS ENUM (
  'RECEIPT',
  'ADJUSTMENT',
  'WRITE_OFF',
  'TRANSFER_IN',
  'TRANSFER_OUT',
  'OPENING_BALANCE',
  'PRODUCTION'
);

-- ============================================================================
-- AlterTable: MaterialBlob — add cost + per-version weight units
-- ============================================================================

ALTER TABLE "MaterialBlob"
  ADD COLUMN "unitCost"    DECIMAL(14,4),
  ADD COLUMN "weightUnits" "WeightUnit";

-- ============================================================================
-- AlterTable: ProductMaterial — alt-group membership + soft archive
-- ============================================================================

ALTER TABLE "ProductMaterial"
  ADD COLUMN "altGroupId" UUID,
  ADD COLUMN "archivedAt" TIMESTAMPTZ(3);

-- ============================================================================
-- CreateTable: ProductMaterialAltGroup — group of swappable materials per product
-- ============================================================================

CREATE TABLE "ProductMaterialAltGroup" (
  "id"                      UUID         NOT NULL,
  "productId"               UUID         NOT NULL,
  "label"                   TEXT,
  "activeProductMaterialId" UUID,
  "createdAt"               TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"               TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "ProductMaterialAltGroup_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProductMaterialAltGroup_activeProductMaterialId_key"
  ON "ProductMaterialAltGroup"("activeProductMaterialId");
CREATE INDEX "ProductMaterialAltGroup_productId_idx"
  ON "ProductMaterialAltGroup"("productId");
CREATE UNIQUE INDEX "ProductMaterialAltGroup_productId_label_key"
  ON "ProductMaterialAltGroup"("productId", "label");

-- ============================================================================
-- CreateTable: MaterialLedgerEntry — append-only, immutable.
-- One row per quantity-changing event. PRODUCTION rows are inserted by
-- `flushShiftUsage` at shift close. Balance for a material is SUM(quantity).
-- ============================================================================

CREATE TABLE "MaterialLedgerEntry" (
  "id"                UUID                 NOT NULL,
  "siteId"            UUID                 NOT NULL,
  "materialId"        UUID                 NOT NULL,
  "kind"              "MaterialLedgerKind" NOT NULL,
  "quantity"          DECIMAL(18,4)        NOT NULL,
  "unit"              "WeightUnit"         NOT NULL,
  "unitCost"          DECIMAL(14,4),
  "reference"         TEXT,
  "note"              TEXT,
  "description"       TEXT,
  "performedByUserId" UUID,
  "createdAt"         TIMESTAMPTZ(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "MaterialLedgerEntry_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "MaterialLedgerEntry_materialId_createdAt_idx"
  ON "MaterialLedgerEntry"("materialId", "createdAt");
CREATE INDEX "MaterialLedgerEntry_siteId_createdAt_idx"
  ON "MaterialLedgerEntry"("siteId", "createdAt");

-- ============================================================================
-- CreateTable: MaterialShiftUsage — in-shift staging + post-flush audit.
-- One row per (shift × station × job × product × material). `quantity`
-- accumulates positive (amount consumed) during the shift, then flush
-- writes one immutable PRODUCTION ledger entry of `-quantity` and stamps
-- `flushedAt` + `flushedLedgerEntryId` on the staging row.
-- ============================================================================

CREATE TABLE "MaterialShiftUsage" (
  "id"                   UUID           NOT NULL,
  "siteId"               UUID           NOT NULL,
  "shiftInstanceId"      UUID           NOT NULL,
  "stationId"            UUID           NOT NULL,
  "jobId"                UUID           NOT NULL,
  "productId"            UUID           NOT NULL,
  "materialId"           UUID           NOT NULL,
  "quantity"             DECIMAL(18,4)  NOT NULL,
  "unit"                 "WeightUnit"   NOT NULL,
  "itemCount"            INTEGER        NOT NULL DEFAULT 0,
  "flushedAt"            TIMESTAMPTZ(3),
  "flushedLedgerEntryId" UUID,
  "createdAt"            TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"            TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "MaterialShiftUsage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "MaterialShiftUsage_flushedLedgerEntryId_idx"
  ON "MaterialShiftUsage"("flushedLedgerEntryId");
CREATE UNIQUE INDEX "MaterialShiftUsage_shiftInstanceId_stationId_jobId_productId_materialId_key"
  ON "MaterialShiftUsage"("shiftInstanceId", "stationId", "jobId", "productId", "materialId");
CREATE INDEX "MaterialShiftUsage_materialId_flushedAt_idx"
  ON "MaterialShiftUsage"("materialId", "flushedAt");
CREATE INDEX "MaterialShiftUsage_siteId_shiftInstanceId_idx"
  ON "MaterialShiftUsage"("siteId", "shiftInstanceId");
CREATE INDEX "MaterialShiftUsage_stationId_idx"
  ON "MaterialShiftUsage"("stationId");
CREATE INDEX "MaterialShiftUsage_jobId_idx"
  ON "MaterialShiftUsage"("jobId");

-- ============================================================================
-- Indexes on existing tables
-- ============================================================================

CREATE INDEX "ProductMaterial_altGroupId_idx" ON "ProductMaterial"("altGroupId");
CREATE INDEX "ProductMaterialBlob_materialBlobId_idx" ON "ProductMaterialBlob"("materialBlobId");

-- ============================================================================
-- Foreign keys
-- ============================================================================

ALTER TABLE "ProductMaterialAltGroup"
  ADD CONSTRAINT "ProductMaterialAltGroup_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "Product"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ProductMaterialAltGroup"
  ADD CONSTRAINT "ProductMaterialAltGroup_activeProductMaterialId_fkey"
  FOREIGN KEY ("activeProductMaterialId") REFERENCES "ProductMaterial"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ProductMaterial"
  ADD CONSTRAINT "ProductMaterial_altGroupId_fkey"
  FOREIGN KEY ("altGroupId") REFERENCES "ProductMaterialAltGroup"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "MaterialLedgerEntry"
  ADD CONSTRAINT "MaterialLedgerEntry_siteId_fkey"
  FOREIGN KEY ("siteId") REFERENCES "Site"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "MaterialLedgerEntry"
  ADD CONSTRAINT "MaterialLedgerEntry_materialId_fkey"
  FOREIGN KEY ("materialId") REFERENCES "Material"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "MaterialLedgerEntry"
  ADD CONSTRAINT "MaterialLedgerEntry_performedByUserId_fkey"
  FOREIGN KEY ("performedByUserId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "MaterialShiftUsage"
  ADD CONSTRAINT "MaterialShiftUsage_siteId_fkey"
  FOREIGN KEY ("siteId") REFERENCES "Site"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MaterialShiftUsage"
  ADD CONSTRAINT "MaterialShiftUsage_shiftInstanceId_fkey"
  FOREIGN KEY ("shiftInstanceId") REFERENCES "ShiftInstance"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MaterialShiftUsage"
  ADD CONSTRAINT "MaterialShiftUsage_stationId_fkey"
  FOREIGN KEY ("stationId") REFERENCES "Station"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MaterialShiftUsage"
  ADD CONSTRAINT "MaterialShiftUsage_jobId_fkey"
  FOREIGN KEY ("jobId") REFERENCES "Job"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MaterialShiftUsage"
  ADD CONSTRAINT "MaterialShiftUsage_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "Product"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MaterialShiftUsage"
  ADD CONSTRAINT "MaterialShiftUsage_materialId_fkey"
  FOREIGN KEY ("materialId") REFERENCES "Material"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "MaterialShiftUsage"
  ADD CONSTRAINT "MaterialShiftUsage_flushedLedgerEntryId_fkey"
  FOREIGN KEY ("flushedLedgerEntryId") REFERENCES "MaterialLedgerEntry"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
