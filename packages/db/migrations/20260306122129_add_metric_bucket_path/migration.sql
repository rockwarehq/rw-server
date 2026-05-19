-- AlterTable
ALTER TABLE "MetricBucket" ADD COLUMN     "entityName" TEXT NOT NULL DEFAULT '';
ALTER TABLE "MetricBucket" ADD COLUMN     "granularityName" TEXT NOT NULL DEFAULT '';
ALTER TABLE "MetricBucket" ADD COLUMN     "path" TEXT NOT NULL DEFAULT '';
