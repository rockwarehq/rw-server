-- How often a point group's values are published.
--
-- Null (every existing group) publishes each point when its value changes, as
-- before. A number of milliseconds puts the group in interval mode: the driver
-- reads it once per clock-aligned tick and publishes every point, changed or
-- not, followed by the group's tick point.

-- AlterTable
ALTER TABLE "PointGroup" ADD COLUMN "publishIntervalMs" INTEGER;
