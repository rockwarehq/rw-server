-- CreateEnum
CREATE TYPE "PointValueQuality" AS ENUM ('GOOD', 'BAD', 'UNKNOWN');

-- CreateTable
CREATE TABLE "PointValue" (
    "id" UUID NOT NULL,
    "previousValueRaw" JSONB,
    "quality" "PointValueQuality" NOT NULL DEFAULT 'UNKNOWN',
    "valueRaw" JSONB NOT NULL,
    "previousValue" DOUBLE PRECISION,
    "value" DOUBLE PRECISION,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "gatewayTimestamp" TIMESTAMP(3) NOT NULL,
    "processorTimestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "pointId" UUID NOT NULL,

    CONSTRAINT "PointValue_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PointValue_pointId_timestamp_idx" ON "PointValue"("pointId", "timestamp");

-- CreateIndex
CREATE INDEX "PointValue_timestamp_idx" ON "PointValue"("timestamp");

-- AddForeignKey
ALTER TABLE "PointValue" ADD CONSTRAINT "PointValue_pointId_fkey" FOREIGN KEY ("pointId") REFERENCES "Point"("id") ON DELETE CASCADE ON UPDATE CASCADE;
