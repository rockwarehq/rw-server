-- Calls and production modes share one actor-source enum.
ALTER TYPE "CallSource" RENAME TO "ActionSource";

-- StationModeLog: who forced the mode (MANUAL operator/user vs SYSTEM automation/alarm).
ALTER TABLE "StationModeLog"
  ADD COLUMN "source" "ActionSource" NOT NULL DEFAULT 'MANUAL',
  ADD COLUMN "sourceType" TEXT,
  ADD COLUMN "sourceRef" TEXT;
