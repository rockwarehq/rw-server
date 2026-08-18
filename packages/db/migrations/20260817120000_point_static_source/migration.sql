-- Static points: manually-entered device-level values (e.g. FeetPerTick=100)
-- never polled by a gateway; livestore reads them via the entity resolver.
CREATE TYPE "PointSourceType" AS ENUM ('DRIVER', 'STATIC');

ALTER TABLE "Point" ADD COLUMN "sourceType" "PointSourceType" NOT NULL DEFAULT 'DRIVER';
ALTER TABLE "Point" ADD COLUMN "staticValue" JSONB;
