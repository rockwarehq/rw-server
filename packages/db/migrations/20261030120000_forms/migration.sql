-- CreateEnum
CREATE TYPE "DocumentFormStatus" AS ENUM ('DRAFT', 'PUBLISHED');

-- AlterEnum
ALTER TYPE "DocumentKind" ADD VALUE 'FORM';

-- AlterTable
ALTER TABLE "Document" ADD COLUMN     "currentFormId" UUID;

-- CreateTable
CREATE TABLE "DocumentForm" (
    "id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "DocumentFormStatus" NOT NULL DEFAULT 'DRAFT',
    "content" JSONB NOT NULL,
    "fields" JSONB NOT NULL DEFAULT '[]',
    "note" TEXT,
    "documentId" UUID NOT NULL,
    "createdById" UUID,
    "publishedById" UUID,
    "publishedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "DocumentForm_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FormSubmission" (
    "id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "documentId" UUID NOT NULL,
    "formId" UUID NOT NULL,
    "answers" JSONB NOT NULL,
    "siteId" UUID,
    "workcenterId" UUID,
    "stationId" UUID,
    "jobId" UUID,
    "submittedById" UUID,
    "submittedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FormSubmission_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DocumentForm_documentId_idx" ON "DocumentForm"("documentId");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentForm_documentId_version_key" ON "DocumentForm"("documentId", "version");

-- CreateIndex
CREATE INDEX "FormSubmission_documentId_submittedAt_idx" ON "FormSubmission"("documentId", "submittedAt");

-- CreateIndex
CREATE INDEX "FormSubmission_stationId_idx" ON "FormSubmission"("stationId");

-- CreateIndex
CREATE INDEX "FormSubmission_formId_idx" ON "FormSubmission"("formId");

-- CreateIndex
CREATE UNIQUE INDEX "FormSubmission_documentId_number_key" ON "FormSubmission"("documentId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "Document_currentFormId_key" ON "Document"("currentFormId");

-- AddForeignKey
ALTER TABLE "DocumentForm" ADD CONSTRAINT "DocumentForm_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentForm" ADD CONSTRAINT "DocumentForm_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentForm" ADD CONSTRAINT "DocumentForm_publishedById_fkey" FOREIGN KEY ("publishedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_currentFormId_fkey" FOREIGN KEY ("currentFormId") REFERENCES "DocumentForm"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FormSubmission" ADD CONSTRAINT "FormSubmission_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FormSubmission" ADD CONSTRAINT "FormSubmission_formId_fkey" FOREIGN KEY ("formId") REFERENCES "DocumentForm"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FormSubmission" ADD CONSTRAINT "FormSubmission_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FormSubmission" ADD CONSTRAINT "FormSubmission_workcenterId_fkey" FOREIGN KEY ("workcenterId") REFERENCES "Workcenter"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FormSubmission" ADD CONSTRAINT "FormSubmission_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "Station"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FormSubmission" ADD CONSTRAINT "FormSubmission_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FormSubmission" ADD CONSTRAINT "FormSubmission_submittedById_fkey" FOREIGN KEY ("submittedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

