-- Drop tables and columns that no code reads or writes.
--
-- Old access model (the bucket migrations already copied what mattered
-- into BucketAccess and User.isAccountAdmin, and run before this one):
--   Role, RoleAssignment, WorkcenterGrant, WorkspaceMember
-- Never used, or replaced long ago:
--   Location (replaced by Site), WorkOrder (never written),
--   StationJob, ToolStatus, ToolLocation
-- Dead columns:
--   Cycle.orderId, Cycle.rejectNumber, Gateway.locationId,
--   Datasource.locationId, Tool.toolStatusId, Tool.toolLocationId,
--   GraphHook.eventType (replaced by eventNamespace + eventName),
--   Workspace.isDefault (one workspace per deployment)
--
-- Dropping a column also drops its foreign keys and indexes. CASCADE on a
-- table drop removes foreign keys that point at it. No views, functions or
-- triggers use any of these.

-- ── 1. Columns ────────────────────────────────────────────────────────────

ALTER TABLE "Cycle"
  DROP COLUMN "orderId",
  DROP COLUMN "rejectNumber";

ALTER TABLE "Gateway" DROP COLUMN "locationId";

ALTER TABLE "Datasource" DROP COLUMN "locationId";

ALTER TABLE "Tool"
  DROP COLUMN "toolStatusId",
  DROP COLUMN "toolLocationId";

ALTER TABLE "GraphHook" DROP COLUMN "eventType";

ALTER TABLE "Workspace" DROP COLUMN "isDefault";

-- ── 2. Tables ─────────────────────────────────────────────────────────────

DROP TABLE "WorkcenterGrant" CASCADE;
DROP TABLE "RoleAssignment" CASCADE;
DROP TABLE "Role" CASCADE;
DROP TABLE "WorkspaceMember" CASCADE;
DROP TABLE "WorkOrder" CASCADE;
DROP TABLE "Location" CASCADE;
DROP TABLE "StationJob" CASCADE;
DROP TABLE "ToolStatus" CASCADE;
DROP TABLE "ToolLocation" CASCADE;

-- ── 3. Enums ──────────────────────────────────────────────────────────────

DROP TYPE "WorkcenterAccess";
DROP TYPE "RoleScope";
DROP TYPE "WorkspaceRole";
DROP TYPE "WorkOrderStatus";
DROP TYPE "LocationType";
