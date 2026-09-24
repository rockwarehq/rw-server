-- Document revisions (delegated type): a FILE document's bytes move off the
-- Document row into immutable DocumentFile versions. Document keeps identity,
-- name, folder, labels, scope and links, and points at its current version
-- through currentFileId, the way Job points at its current JobVersion.
--
-- Every existing file becomes version 1 with its current filename, type,
-- size, storage key, status and creation time; then the old columns go.

-- ── 1. Versions table ─────────────────────────────────────────────────────

CREATE TABLE "DocumentFile" (
    "id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "DocumentStatus" NOT NULL DEFAULT 'PENDING_UPLOAD',
    "filename" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "documentId" UUID NOT NULL,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentFile_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DocumentFile_storageKey_key" ON "DocumentFile"("storageKey");
CREATE INDEX "DocumentFile_documentId_idx" ON "DocumentFile"("documentId");
CREATE UNIQUE INDEX "DocumentFile_documentId_version_key" ON "DocumentFile"("documentId", "version");

ALTER TABLE "DocumentFile" ADD CONSTRAINT "DocumentFile_documentId_fkey"
  FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DocumentFile" ADD CONSTRAINT "DocumentFile_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Document" ADD COLUMN "currentFileId" UUID;
CREATE UNIQUE INDEX "Document_currentFileId_key" ON "Document"("currentFileId");
ALTER TABLE "Document" ADD CONSTRAINT "Document_currentFileId_fkey"
  FOREIGN KEY ("currentFileId") REFERENCES "DocumentFile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── 2. Backfill version 1 ─────────────────────────────────────────────────
-- Only files that got as far as a storage key have bytes to point at. A FILE
-- row without one never finished createUpload; it keeps no current file.

INSERT INTO "DocumentFile"
  ("id", "version", "status", "filename", "contentType", "size", "storageKey", "documentId", "createdAt")
SELECT
  gen_random_uuid(), 1, d."status",
  COALESCE(d."filename", d."name"),
  COALESCE(d."contentType", 'application/octet-stream'),
  COALESCE(d."size", 0),
  d."storageKey", d."id", d."createdAt"
FROM "Document" d
WHERE d."kind" = 'FILE' AND d."storageKey" IS NOT NULL;

UPDATE "Document" d
SET "currentFileId" = f."id"
FROM "DocumentFile" f
WHERE f."documentId" = d."id";

-- ── 3. Drop the moved columns ─────────────────────────────────────────────

DROP INDEX "Document_storageKey_key";

ALTER TABLE "Document"
  DROP COLUMN "filename",
  DROP COLUMN "contentType",
  DROP COLUMN "size",
  DROP COLUMN "storageKey";
