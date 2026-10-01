-- Fast detection, workcenter-level detection defaults, and the pace each cycle ran at.
--
-- A station's slow/fast/down detect overrides its workcenter's; null on the
-- station means "use the workcenter's", and 0 turns one off for that station.
-- Every existing station keeps exactly what it had: its own slow and down
-- values stay, and no workcenter has a default yet.

-- CreateEnum
CREATE TYPE "CyclePace" AS ENUM ('NORMAL', 'SLOW', 'FAST');

-- AlterTable
ALTER TABLE "StationVersion" ADD COLUMN "fastDetect" DECIMAL(10,2);

-- AlterTable
ALTER TABLE "Workcenter"
  ADD COLUMN "slowDetect" DECIMAL(10,2),
  ADD COLUMN "fastDetect" DECIMAL(10,2),
  ADD COLUMN "downtimeDetect" DECIMAL(10,2);

-- AlterTable: null for every cycle already recorded (not judged).
ALTER TABLE "Cycle" ADD COLUMN "pace" "CyclePace";
