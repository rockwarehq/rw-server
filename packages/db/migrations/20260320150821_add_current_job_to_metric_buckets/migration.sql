-- AlterTable
ALTER TABLE "MetricBucket" ADD COLUMN     "currentJobId" UUID,
ADD COLUMN     "currentJobName" TEXT;

-- AlterTable
ALTER TABLE "MetricBucketLog" ADD COLUMN     "currentJobId" UUID,
ADD COLUMN     "currentJobName" TEXT;
