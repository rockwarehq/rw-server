-- CreateTable
CREATE TABLE "_DispositionReasonDispositions" (
    "A" UUID NOT NULL,
    "B" UUID NOT NULL,

    CONSTRAINT "_DispositionReasonDispositions_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE INDEX "_DispositionReasonDispositions_B_index" ON "_DispositionReasonDispositions"("B");

-- AddForeignKey
ALTER TABLE "_DispositionReasonDispositions" ADD CONSTRAINT "_DispositionReasonDispositions_A_fkey" FOREIGN KEY ("A") REFERENCES "ItemDisposition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_DispositionReasonDispositions" ADD CONSTRAINT "_DispositionReasonDispositions_B_fkey" FOREIGN KEY ("B") REFERENCES "ItemDispositionReason"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill existing one-to-one reason links into the many-to-many join table.
INSERT INTO "_DispositionReasonDispositions" ("A", "B")
SELECT "itemDispositionId", "id"
FROM "ItemDispositionReason"
WHERE "itemDispositionId" IS NOT NULL
ON CONFLICT DO NOTHING;

-- DropForeignKey
ALTER TABLE "ItemDispositionReason" DROP CONSTRAINT "ItemDispositionReason_itemDispositionId_fkey";

-- AlterTable
ALTER TABLE "ItemDispositionReason" DROP COLUMN "itemDispositionId";
