-- AlterTable
ALTER TABLE "GraphHook" ADD COLUMN     "eventContext" JSONB NOT NULL DEFAULT '{}';
