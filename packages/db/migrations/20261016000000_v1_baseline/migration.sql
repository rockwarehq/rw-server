-- v1 baseline: squashes the 151 migrations from 20260115205313_init through
-- 20261015100000_overhead_page_log_source.
--
--   - new database (none of the old migrations recorded): create the schema
--   - every old migration recorded: the schema is already here; do nothing,
--     and Prisma records this migration as applied
--   - some old migrations recorded, some not: stop. Deploy the last release
--     before the squash (2748b90) so they apply, then deploy again.
--
-- The last case is normally caught first by scripts/baseline-guard.mjs, which
-- `pnpm db:migrate` runs before Prisma so nothing is recorded. Reaching it here
-- (running `prisma migrate deploy` directly) leaves a failed migration that
-- must be cleared with `prisma migrate resolve --rolled-back 20261016000000_v1_baseline`.
--
-- The old rows in _prisma_migrations are kept: rolling back to the
-- pre-squash release needs them.
--
-- The schema is `prisma migrate diff --from-empty --to-schema schema --script`,
-- plus the hand-written SQL Prisma can't express: generated columns on
-- MetricBucket/MetricBucketLog (inline) and functions, storage params, CHECKs
-- and partial unique indexes (at the end). A DO block is one statement, so a
-- new database gets all of it or none of it.

DO $guard$
DECLARE
  legacy text[] := ARRAY[
    '20260115205313_init',
    '20260127230334_add_workspace_to_location',
    '20260130190044_invites',
    '20260211014709_add_station_models',
    '20260212185450_add_workcenters',
    '20260213143429_cycle_job_shift_models',
    '20260216225152_add_datasource_status',
    '20260217145238_station_site_relation',
    '20260217154557_point_value',
    '20260219214301_add_station_events',
    '20260220221728_part_materials_job_tools',
    '20260223224745_versioning_inventory_jobs_cycles',
    '20260224120656_material_product_m2m',
    '20260226222911_state_state_and_support_tables',
    '20260227165515_add_product_pictures',
    '20260227190325_add_cavity_count_and_quantity',
    '20260227193000_add_station_event_executions',
    '20260304191542_job_updates',
    '20260305162437_add_dashboard_and_display',
    '20260305171208_add_metric_buckets',
    '20260305213548_site_timezone_addition',
    '20260306122129_add_metric_bucket_path',
    '20260306182810_station_job_bucket',
    '20260309120000_add_shift_sort_order',
    '20260310155305_oee_building_blocks',
    '20260311180000_add_metric_bucket_shift_instance_id',
    '20260311200000_widen_oee_decimal_precision',
    '20260311210000_enforce_single_open_state_log',
    '20260312000000_metrics_overhaul',
    '20260312165035_add_workcenter_process_type',
    '20260313000000_goodcycles_generated_columns',
    '20260313174755_scrap_downtime_schema_additions',
    '20260316150827_add_station_blob_refs',
    '20260317000000_replace_rotation_start_shift_with_definition_fk',
    '20260319164929_add_display_workcenter_station',
    '20260320112737_add_workcenter_to_disposition_log',
    '20260320121500_inventory_relationships_no_delete',
    '20260320150821_add_current_job_to_metric_buckets',
    '20260324171925_use_timestamptz',
    '20260325000000_oee_zero_not_null',
    '20260326000000_metric_bucket_log_generated_columns',
    '20260326100000_add_product_material_blob',
    '20260326182530_product_material_blob',
    '20260331120423_add_job_blob_id_to_station_state_log',
    '20260331191248_add_employee_and_operator_logon',
    '20260402175132_production_orders',
    '20260403000000_employee_role_table',
    '20260410114621_add_starttime_indexes_for_rollup_queries',
    '20260412005102_display_auth',
    '20260416133205_add_shift_comment',
    '20260421020632_add_site_andon_rules',
    '20260426093908_add_material_ledger_alt_groups_shift_usage',
    '20260427155847_add_weight_unit_mt_ton',
    '20260427233455_rbac',
    '20260430141632_widen_product_blob_weight_cost_precision',
    '20260430160333_disposition_reason_m2m',
    '20260529182020_automations',
    '20260604120000_add_documents',
    '20260606000000_add_graph_models',
    '20260611120000_add_user_entities',
    '20260612120000_bind_graph_nodes_to_object_instances',
    '20260612130000_site_scope_graph_nodes',
    '20260613120000_object_schema_catalog_source',
    '20260618120000_site_scoped_entity_keys',
    '20260619192711_add_livestore_hooks',
    '20260619201302_add_livestore_hook_context',
    '20260620164537_split_livestore_hook_event_identity',
    '20260622120000_graph_types',
    '20260623120000_graph_node_facets',
    '20260623130000_graph_type_inputs_facets',
    '20260708164934_api_tokens',
    '20260708165507_api_token_audit_actions',
    '20260708170000_add_graph_updatedat_indexes',
    '20260710120000_rename_blob_to_version',
    '20260713120000_add_station_state_log_updatedat_index',
    '20260714120000_refresh_reuse_grace',
    '20260722180000_add_metric_bucket_historian_indexes',
    '20260722210000_saved_views',
    '20260803120000_cycle_source_event_id',
    '20260804144907_integrations',
    '20260812190000_metricbucket_hot_updates',
    '20260817120000_point_static_source',
    '20260819120000_inventory_item_quantity',
    '20260824140000_labels',
    '20260825112710_reset_code_and_admin_reset',
    '20260825120000_cycle_modes_rate_standards',
    '20260825190000_invite_temp_password',
    '20260826010000_label_color',
    '20260826020000_user_avatar',
    '20260827090000_inventory_first_orders',
    '20260828090000_product_stock_adjustments',
    '20260828181749_calls',
    '20260831151747_call_definition_require_open_message',
    '20260831155743_call_definition_role_restrictions',
    '20260901000000_simplify_site_roles',
    '20260901090000_production_modes',
    '20260901120000_workcenter_grants',
    '20260902160000_automation_foundations',
    '20260902180000_mode_events_source',
    '20260902200000_notifications',
    '20260902230000_mode_log_dimensions',
    '20260903000000_automation_cooldown',
    '20260903010000_notification_direct_recipients',
    '20260904000000_sms_consent',
    '20260909000000_star_pattern_stamps',
    '20260910090000_job_history_amendment',
    '20260910120000_job_log_block_id',
    '20260911090000_cycle_amendment_id',
    '20260911093000_item_amendment_id',
    '20260912090000_state_log_planned_down',
    '20260913090000_job_log_amendment_id',
    '20260915090000_shift_gaps_overrides',
    '20260915130000_shift_definition_local_time',
    '20260915150000_shift_amendment',
    '20260915160000_shift_scheduled_flag',
    '20260915170000_shift_amendment_scheduled_flag',
    '20260916090000_shift_scheduled_stamps',
    '20260916120000_shift_override_note',
    '20260916150000_shift_pattern_soft_delete',
    '20260916160000_shift_gap_off_hours',
    '20260916190000_shift_amendment_added_shift',
    '20260916210000_shift_amendment_undo',
    '20260917120000_add_shift_signoff',
    '20260921180000_order_lifecycle',
    '20260922190000_expand_permission_vocabulary',
    '20260923100000_contract_permission_vocabulary',
    '20260924100000_bucket_access_model',
    '20260925100000_bucket_integrity',
    '20260926100000_plant_member_admin_split',
    '20260927100000_bucket_level_rename',
    '20260928100000_account_admin_flag',
    '20260929100000_drop_dead_models',
    '20260930100000_document_file_versions',
    '20261001100000_stock_ledger',
    '20261002100000_shift_comment_employee_author',
    '20261003100000_material_stock_book',
    '20261004100000_station_profiles',
    '20261005100000_station_profile_default',
    '20261006100000_automation_schedule',
    '20261006100000_station_profile_variations',
    '20261007100000_report_decks',
    '20261008100000_site_week_start',
    '20261009100000_report_deck_kind',
    '20261010100000_account_team_members',
    '20261011100000_station_sort_order',
    '20261012100000_fast_detect_workcenter_defaults',
    '20261013100000_graph_changesets_and_agent',
    '20261013100000_point_group_publish_interval',
    '20261014100000_agent_message_content_json',
    '20261014100000_overhead_pages',
    '20261015100000_overhead_page_log_source'
  ];
  applied text[] := '{}';
  missing text[];
BEGIN
  IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
    SELECT coalesce(array_agg(migration_name), '{}') INTO applied
      FROM _prisma_migrations
     WHERE migration_name = ANY (legacy)
       AND finished_at IS NOT NULL
       AND rolled_back_at IS NULL;
  END IF;

  IF cardinality(applied) = 0 THEN
    EXECUTE $baseline$
-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "ActionSource" AS ENUM ('MANUAL', 'SYSTEM');

-- CreateEnum
CREATE TYPE "AgentTriggerKind" AS ENUM ('HOOK_EVENT', 'SCHEDULE');

-- CreateEnum
CREATE TYPE "AgentSessionTrigger" AS ENUM ('CHAT', 'HOOK_EVENT', 'SCHEDULE', 'AGENT');

-- CreateEnum
CREATE TYPE "AgentSessionStatus" AS ENUM ('IDLE', 'QUEUED', 'RUNNING', 'WAITING_APPROVAL', 'FAILED');

-- CreateEnum
CREATE TYPE "AgentInputStatus" AS ENUM ('ADMITTED', 'CONSUMED');

-- CreateEnum
CREATE TYPE "AgentMessageRole" AS ENUM ('USER', 'ASSISTANT');

-- CreateEnum
CREATE TYPE "AgentPermissionStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "AuditAction" AS ENUM ('USER_INVITED', 'INVITE_VERIFIED', 'INVITE_COMPLETED', 'INVITE_FAILED', 'INVITE_EXPIRED', 'INVITE_REVOKED', 'PASSWORD_RESET_REQUESTED', 'PASSWORD_RESET_COMPLETED', 'PASSWORD_RESET_FAILED', 'LOGIN_SUCCESS', 'LOGIN_FAILED', 'LOGIN_LOCKED', 'LOGOUT', 'ACCOUNT_UNLOCKED', 'REFRESH_REUSE_GRACE', 'REFRESH_REUSE_DETECTED', 'PASSWORD_CHANGED', 'PASSWORD_ADMIN_RESET', 'USER_DISABLED', 'USER_ENABLED', 'OPERATOR_LOGON', 'OPERATOR_LOGOFF', 'OPERATOR_LOGON_FAILED', 'OPERATOR_SUPERVISOR_CHALLENGE', 'OPERATOR_SUPERVISOR_CHALLENGE_FAILED', 'API_TOKEN_CREATED', 'API_TOKEN_REVOKED', 'GRAPH_CHANGESET_APPLIED');

-- CreateEnum
CREATE TYPE "AutomationActionRunStatus" AS ENUM ('SUCCESS', 'FAILED', 'SKIPPED', 'SCHEDULED');

-- CreateEnum
CREATE TYPE "AutomationRunStatus" AS ENUM ('SUCCESS', 'FAILED', 'DROPPED');

-- CreateEnum
CREATE TYPE "BucketLevel" AS ENUM ('VIEW', 'MANAGE', 'ADMIN');

-- CreateEnum
CREATE TYPE "BucketKind" AS ENUM ('PLANT', 'WORKCENTER');

-- CreateEnum
CREATE TYPE "CallSeverity" AS ENUM ('INFORMATION', 'ALERT', 'WARNING');

-- CreateEnum
CREATE TYPE "CycleStatus" AS ENUM ('DISCARD', 'BAD', 'GOOD');

-- CreateEnum
CREATE TYPE "CyclePace" AS ENUM ('NORMAL', 'SLOW', 'FAST');

-- CreateEnum
CREATE TYPE "DataSourceType" AS ENUM ('DEVICE', 'KIOSK', 'SERVICE', 'VIRTUAL');

-- CreateEnum
CREATE TYPE "DatasourceStatus" AS ENUM ('DRAFT', 'ACTIVE');

-- CreateEnum
CREATE TYPE "PointValueQuality" AS ENUM ('GOOD', 'BAD', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "PointSourceType" AS ENUM ('DRIVER', 'STATIC');

-- CreateEnum
CREATE TYPE "DisplayStatus" AS ENUM ('UNCLAIMED', 'CLAIMED');

-- CreateEnum
CREATE TYPE "DocumentTargetType" AS ENUM ('SITE', 'WORKCENTER', 'STATION', 'JOB', 'TOOL', 'PRODUCT', 'MATERIAL');

-- CreateEnum
CREATE TYPE "DocumentKind" AS ENUM ('FILE', 'FOLDER');

-- CreateEnum
CREATE TYPE "DocumentStatus" AS ENUM ('PENDING_UPLOAD', 'READY');

-- CreateEnum
CREATE TYPE "EmployeeStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "CommandStatus" AS ENUM ('PENDING', 'ACK', 'COMPLETED', 'FAILED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "GatewayHosting" AS ENUM ('SELF', 'ROCKWARE');

-- CreateEnum
CREATE TYPE "GatewayStatus" AS ENUM ('PROVISIONED', 'ONLINE', 'OFFLINE', 'DISABLED');

-- CreateEnum
CREATE TYPE "GraphChangesetStatus" AS ENUM ('DRAFT', 'APPLIED', 'DISCARDED');

-- CreateEnum
CREATE TYPE "GraphChangesetAuthor" AS ENUM ('USER', 'AGENT');

-- CreateEnum
CREATE TYPE "IntegrationRunStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "StandardCycleUnit" AS ENUM ('SECONDS');

-- CreateEnum
CREATE TYPE "RatePeriod" AS ENUM ('SECOND', 'MINUTE', 'HOUR');

-- CreateEnum
CREATE TYPE "LabelFilterTarget" AS ENUM ('JOB', 'TOOL', 'STATUS_REASON', 'DISPOSITION_REASON');

-- CreateEnum
CREATE TYPE "MaterialLedgerKind" AS ENUM ('RECEIPT', 'ADJUSTMENT', 'WRITE_OFF', 'TRANSFER_IN', 'TRANSFER_OUT', 'OPENING_BALANCE', 'PRODUCTION');

-- CreateEnum
CREATE TYPE "WeightUnit" AS ENUM ('KG', 'LB', 'G', 'OZ', 'MT', 'TON');

-- CreateEnum
CREATE TYPE "BucketEntityType" AS ENUM ('STATION', 'WORKCENTER', 'SITE', 'JOB');

-- CreateEnum
CREATE TYPE "BucketGranularity" AS ENUM ('MINUTE', 'HOUR', 'SHIFT', 'DAY');

-- CreateEnum
CREATE TYPE "NotificationDeliveryStatus" AS ENUM ('SENT', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('EMAIL', 'SMS');

-- CreateEnum
CREATE TYPE "ObjectFieldType" AS ENUM ('TEXT', 'NUMBER', 'BOOLEAN', 'DATE', 'TIMESTAMP', 'SELECT', 'JSON', 'OBJECT');

-- CreateEnum
CREATE TYPE "ObjectSchemaSource" AS ENUM ('RECORD', 'DOCUMENT');

-- CreateEnum
CREATE TYPE "ConsumptionSource" AS ENUM ('MANUAL', 'AUTO', 'BACKFILL');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('OPEN', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "OverheadPageLogStatus" AS ENUM ('SENT', 'PARTIAL', 'FAILED');

-- CreateEnum
CREATE TYPE "OverheadPagePriority" AS ENUM ('NORMAL', 'HIGH', 'EMERGENCY');

-- CreateEnum
CREATE TYPE "StockAdjustmentReason" AS ENUM ('CYCLE_COUNT', 'DAMAGE', 'FOUND', 'INITIAL', 'OTHER');

-- CreateEnum
CREATE TYPE "ReportDeckVisibility" AS ENUM ('SITE', 'PRIVATE');

-- CreateEnum
CREATE TYPE "ReportDeckKind" AS ENUM ('DECK', 'SHIFT_RECAP');

-- CreateEnum
CREATE TYPE "ReportDeckEditionSource" AS ENUM ('MANUAL', 'SCHEDULE');

-- CreateEnum
CREATE TYPE "ShiftAmendmentStatus" AS ENUM ('PENDING_REBUILD', 'APPLIED', 'FAILED');

-- CreateEnum
CREATE TYPE "WeekStart" AS ENUM ('SUNDAY', 'MONDAY');

-- CreateEnum
CREATE TYPE "SmsConsentStatus" AS ENUM ('OPTED_IN', 'OPTED_OUT');

-- CreateEnum
CREATE TYPE "SmsConsentMethod" AS ENUM ('WEB_FORM', 'VERBAL', 'PAPER', 'TEXT_KEYWORD', 'STOP_KEYWORD', 'IMPORTED');

-- CreateEnum
CREATE TYPE "JobHistoryAmendmentStatus" AS ENUM ('PENDING_REBUILD', 'APPLIED', 'FAILED');

-- CreateEnum
CREATE TYPE "StationEventExecutionStatus" AS ENUM ('RUNNING', 'FAILED', 'SUCCEEDED');

-- CreateEnum
CREATE TYPE "ProfileCountedAs" AS ENUM ('OUTPUT', 'CYCLES');

-- CreateEnum
CREATE TYPE "StationState" AS ENUM ('UP', 'DOWN');

-- CreateEnum
CREATE TYPE "StationStatus" AS ENUM ('FAST', 'SLOW', 'UP', 'DOWN');

-- CreateEnum
CREATE TYPE "CycleMode" AS ENUM ('DISCRETE', 'QUANTITY_PER_CYCLE', 'QUANTITY_PER_INTERVAL');

-- CreateEnum
CREATE TYPE "DowntimeDetectUnit" AS ENUM ('SECONDS');

-- CreateEnum
CREATE TYPE "SlowDetectUnit" AS ENUM ('PERCENTAGE');

-- CreateEnum
CREATE TYPE "StockableType" AS ENUM ('PRODUCT', 'MATERIAL');

-- CreateEnum
CREATE TYPE "TrackingMode" AS ENUM ('NONE', 'BATCH', 'SERIAL');

-- CreateEnum
CREATE TYPE "StockMovementKind" AS ENUM ('OUTPUT', 'SCRAP', 'FULFILLMENT', 'ADJUSTMENT', 'RECEIPT', 'USAGE', 'WRITE_OFF', 'TRANSFER_IN', 'TRANSFER_OUT', 'OPENING_BALANCE');

-- CreateEnum
CREATE TYPE "StockSourceType" AS ENUM ('INVENTORY_ITEM', 'ITEM_DISPOSITION_LOG', 'ORDER_CONSUMPTION', 'PRODUCT_STOCK_ADJUSTMENT', 'MATERIAL_LEDGER_ENTRY', 'MATERIAL_SHIFT_USAGE');

-- CreateEnum
CREATE TYPE "SystemRole" AS ENUM ('SUPPORT', 'ENGINEER');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('PENDING', 'ACTIVE', 'DISABLED');

-- CreateTable
CREATE TABLE "AgentDefinition" (
    "id" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "baseKey" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "instructions" TEXT,
    "model" TEXT,
    "effort" TEXT,
    "maxSteps" INTEGER,
    "permissions" JSONB NOT NULL DEFAULT '[]',
    "notificationGroupId" UUID,
    "runAsUserId" UUID,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "AgentDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentTrigger" (
    "id" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "agentKey" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "kind" "AgentTriggerKind" NOT NULL,
    "prompt" JSONB NOT NULL,
    "eventNamespace" TEXT,
    "eventName" TEXT,
    "eventVersion" TEXT,
    "hookId" UUID,
    "schedule" JSONB,
    "cooldownMs" INTEGER NOT NULL DEFAULT 0,
    "maxRunsPerHour" INTEGER NOT NULL DEFAULT 6,
    "lastFiredAt" TIMESTAMPTZ(3),
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "AgentTrigger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentSession" (
    "id" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "agentKey" TEXT NOT NULL,
    "agentVersion" INTEGER NOT NULL DEFAULT 0,
    "parentSessionId" UUID,
    "trigger" "AgentSessionTrigger" NOT NULL DEFAULT 'CHAT',
    "triggerRef" TEXT,
    "actorUserId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "status" "AgentSessionStatus" NOT NULL DEFAULT 'IDLE',
    "leaseOwner" TEXT,
    "leaseExpiresAt" TIMESTAMPTZ(3),
    "lastSeq" INTEGER NOT NULL DEFAULT 0,
    "usage" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "AgentSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentEvent" (
    "id" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentInput" (
    "id" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "text" TEXT NOT NULL,
    "context" JSONB NOT NULL DEFAULT '[]',
    "status" "AgentInputStatus" NOT NULL DEFAULT 'ADMITTED',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentInput_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentMessage" (
    "id" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "role" "AgentMessageRole" NOT NULL,
    "content" JSON NOT NULL,
    "usage" JSONB,
    "model" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentPermissionRequest" (
    "id" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "toolUseId" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "toolInput" JSONB NOT NULL,
    "permission" TEXT NOT NULL,
    "patterns" TEXT[],
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "status" "AgentPermissionStatus" NOT NULL DEFAULT 'PENDING',
    "reply" TEXT,
    "feedback" TEXT,
    "repliedById" UUID,
    "repliedAt" TIMESTAMPTZ(3),
    "notifiedAt" TIMESTAMPTZ(3),
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentPermissionRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentPermissionRule" (
    "id" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "agentKey" TEXT,
    "permission" TEXT NOT NULL,
    "pattern" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentPermissionRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiToken" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "tokenPrefix" TEXT NOT NULL,
    "scopes" TEXT[] DEFAULT ARRAY['graph:read']::TEXT[],
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3),
    "revokedAt" TIMESTAMPTZ(3),
    "lastUsedAt" TIMESTAMPTZ(3),
    "workspaceId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "createdById" UUID,

    CONSTRAINT "ApiToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" UUID NOT NULL,
    "action" "AuditAction" NOT NULL,
    "userId" UUID,
    "actorId" UUID,
    "workspaceId" UUID,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomationActionRun" (
    "id" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "automationId" UUID NOT NULL,
    "actionIdx" INTEGER NOT NULL,
    "actionType" TEXT NOT NULL,
    "actionVersion" TEXT NOT NULL,
    "status" "AutomationActionRunStatus" NOT NULL,
    "error" TEXT,
    "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMPTZ(3),

    CONSTRAINT "AutomationActionRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomationCooldown" (
    "automationId" UUID NOT NULL,
    "scope" TEXT NOT NULL,
    "firedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "AutomationCooldown_pkey" PRIMARY KEY ("automationId","scope")
);

-- CreateTable
CREATE TABLE "AutomationRunMatch" (
    "id" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "automationId" UUID NOT NULL,
    "matchIdx" INTEGER NOT NULL,
    "skipped" TEXT,

    CONSTRAINT "AutomationRunMatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomationRun" (
    "id" UUID NOT NULL,
    "eventType" TEXT NOT NULL,
    "eventVersion" TEXT NOT NULL,
    "eventId" UUID NOT NULL,
    "payload" JSONB NOT NULL,
    "siteId" UUID,
    "correlationId" UUID NOT NULL,
    "causationId" UUID,
    "hop" INTEGER NOT NULL DEFAULT 0,
    "status" "AutomationRunStatus" NOT NULL,
    "error" TEXT,
    "firedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMPTZ(3),

    CONSTRAINT "AutomationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Automation" (
    "id" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "siteId" UUID,
    "event" TEXT NOT NULL,
    "eventVersion" TEXT NOT NULL,
    "conditions" JSONB NOT NULL,
    "actions" JSONB NOT NULL,
    "cooldownMs" INTEGER,
    "schedule" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Automation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BucketAccess" (
    "id" UUID NOT NULL,
    "bucketId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "level" "BucketLevel" NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "BucketAccess_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Bucket" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "siteId" UUID,
    "kind" "BucketKind" NOT NULL,
    "workcenterId" UUID,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Bucket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CallDefinition" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "severity" "CallSeverity" NOT NULL DEFAULT 'INFORMATION',
    "requireOpenMessage" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "archivedAt" TIMESTAMPTZ(3),
    "siteId" UUID NOT NULL,

    CONSTRAINT "CallDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Call" (
    "id" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "stationId" UUID NOT NULL,
    "definitionId" UUID NOT NULL,
    "severity" "CallSeverity" NOT NULL,
    "workcenterId" UUID,
    "jobId" UUID,
    "jobVersionId" UUID,
    "stationVersionId" UUID,
    "toolId" UUID,
    "productId" UUID,
    "toolVersionId" UUID,
    "productVersionId" UUID,
    "businessDate" DATE,
    "openedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMPTZ(3),
    "source" "ActionSource" NOT NULL,
    "sourceType" TEXT,
    "sourceRef" TEXT,
    "message" TEXT,
    "openedByEmployeeId" UUID,
    "openedByEmployeeVersionId" UUID,
    "closedByEmployeeId" UUID,
    "closedByEmployeeVersionId" UUID,
    "closeMessage" TEXT,
    "shiftInstanceId" UUID,
    "isScheduled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "Call_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Cycle" (
    "id" UUID NOT NULL,
    "cycleStatus" "CycleStatus" NOT NULL,
    "pace" "CyclePace",
    "start" TIMESTAMPTZ(3) NOT NULL,
    "end" TIMESTAMPTZ(3),
    "equipmentStart" TIMESTAMPTZ(3),
    "equipmentEnd" TIMESTAMPTZ(3),
    "quantity" DECIMAL(18,4),
    "quantityUnit" TEXT NOT NULL DEFAULT '',
    "standardCycle" DECIMAL(10,2),
    "standardQuantity" DECIMAL(18,4),
    "attrs" JSONB NOT NULL DEFAULT '{}',
    "sourceEventId" UUID,
    "siteId" UUID NOT NULL,
    "stationId" UUID NOT NULL,
    "workcenterId" UUID,
    "jobId" UUID,
    "shiftInstanceId" UUID,
    "isScheduled" BOOLEAN NOT NULL DEFAULT true,
    "businessDate" DATE,
    "stationVersionId" UUID,
    "jobVersionId" UUID NOT NULL,
    "modeId" UUID,
    "amendmentId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "Cycle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Dashboard" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "spec" JSONB NOT NULL DEFAULT '{}',
    "state" JSONB NOT NULL DEFAULT '{}',
    "attrs" JSONB NOT NULL DEFAULT '{}',
    "siteId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "Dashboard_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Datasource" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "type" "DataSourceType" NOT NULL DEFAULT 'DEVICE',
    "status" "DatasourceStatus" NOT NULL DEFAULT 'DRAFT',
    "attrs" JSONB NOT NULL DEFAULT '{}',
    "driver" TEXT NOT NULL,
    "driverVersion" TEXT NOT NULL,
    "connection" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "gatewayId" UUID,
    "siteId" UUID,

    CONSTRAINT "Datasource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Driver" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "manifest" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Driver_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PointGroup" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "pollRateMs" INTEGER NOT NULL DEFAULT 1000,
    "publishIntervalMs" INTEGER,
    "config" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "datasourceId" UUID NOT NULL,

    CONSTRAINT "PointGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PointValue" (
    "id" UUID NOT NULL,
    "previousValueRaw" JSONB,
    "quality" "PointValueQuality" NOT NULL DEFAULT 'UNKNOWN',
    "valueRaw" JSONB NOT NULL,
    "previousValue" DOUBLE PRECISION,
    "value" DOUBLE PRECISION,
    "timestamp" TIMESTAMPTZ(3) NOT NULL,
    "gatewayTimestamp" TIMESTAMPTZ(3) NOT NULL,
    "processorTimestamp" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "pointId" UUID NOT NULL,

    CONSTRAINT "PointValue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Point" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "sourceType" "PointSourceType" NOT NULL DEFAULT 'DRIVER',
    "staticValue" JSONB,
    "address" TEXT NOT NULL,
    "dataType" TEXT NOT NULL,
    "scaleFactor" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "offset" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "config" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "datasourceId" UUID NOT NULL,
    "groupId" UUID,

    CONSTRAINT "Point_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DisplayRefreshToken" (
    "id" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "revokedAt" TIMESTAMPTZ(3),
    "rotatedAt" TIMESTAMPTZ(3),
    "userAgent" TEXT,
    "ipAddress" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "displayId" UUID NOT NULL,

    CONSTRAINT "DisplayRefreshToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Display" (
    "id" UUID NOT NULL,
    "name" TEXT,
    "claimCode" TEXT,
    "status" "DisplayStatus" NOT NULL DEFAULT 'UNCLAIMED',
    "attrs" JSONB NOT NULL DEFAULT '{}',
    "bootstrapSecretHash" TEXT,
    "bootstrapSecretCreatedAt" TIMESTAMPTZ(3),
    "bootstrapSecretLastUsedAt" TIMESTAMPTZ(3),
    "siteId" UUID,
    "dashboardId" UUID,
    "workcenterId" UUID,
    "stationId" UUID,
    "claimedAt" TIMESTAMPTZ(3),
    "lastSeenAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Display_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentLink" (
    "id" UUID NOT NULL,
    "documentId" UUID NOT NULL,
    "targetType" "DocumentTargetType" NOT NULL,
    "targetId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Document" (
    "id" UUID NOT NULL,
    "kind" "DocumentKind" NOT NULL,
    "status" "DocumentStatus" NOT NULL DEFAULT 'READY',
    "name" TEXT NOT NULL,
    "description" TEXT,
    "labels" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "attrs" JSONB NOT NULL DEFAULT '{}',
    "currentFileId" UUID,
    "siteId" UUID,
    "parentId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "Document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentFile" (
    "id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "DocumentStatus" NOT NULL DEFAULT 'PENDING_UPLOAD',
    "filename" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "documentId" UUID NOT NULL,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmployeeRole" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "permissions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "siteId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "EmployeeRole_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmployeeSiteAccess" (
    "id" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "roleId" UUID NOT NULL,
    "status" "EmployeeStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "EmployeeSiteAccess_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmployeeVersion" (
    "id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "employeeNumber" TEXT,
    "pinHash" TEXT,
    "badgeNumber" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "employeeId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmployeeVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Employee" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "status" "EmployeeStatus" NOT NULL DEFAULT 'ACTIVE',
    "versionId" UUID,
    "failedLoginAttempts" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Employee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommandQueue" (
    "id" UUID NOT NULL,
    "command" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "status" "CommandStatus" NOT NULL DEFAULT 'PENDING',
    "result" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ackedAt" TIMESTAMPTZ(3),
    "completedAt" TIMESTAMPTZ(3),
    "expiresAt" TIMESTAMPTZ(3),
    "gatewayId" UUID NOT NULL,

    CONSTRAINT "CommandQueue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GatewayToken" (
    "id" UUID NOT NULL,
    "name" TEXT,
    "tokenHash" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3),
    "revokedAt" TIMESTAMPTZ(3),
    "lastUsed" TIMESTAMPTZ(3),
    "gatewayId" UUID NOT NULL,

    CONSTRAINT "GatewayToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Gateway" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "serialNumber" TEXT NOT NULL,
    "claimCode" TEXT,
    "hosting" "GatewayHosting" NOT NULL DEFAULT 'SELF',
    "status" "GatewayStatus" NOT NULL DEFAULT 'PROVISIONED',
    "lastHeartbeat" TIMESTAMPTZ(3),
    "specVersion" INTEGER NOT NULL DEFAULT 1,
    "specUpdatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "edgeVersion" TEXT,
    "osInfo" TEXT,
    "health" JSONB,
    "metrics" JSONB,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "siteId" UUID,

    CONSTRAINT "Gateway_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GraphChangeset" (
    "id" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "rationale" TEXT,
    "status" "GraphChangesetStatus" NOT NULL DEFAULT 'DRAFT',
    "author" "GraphChangesetAuthor" NOT NULL DEFAULT 'USER',
    "spec" JSONB NOT NULL,
    "planResult" JSONB NOT NULL,
    "graphVersion" JSONB NOT NULL,
    "sessionId" UUID,
    "createdById" UUID,
    "appliedById" UUID,
    "appliedAt" TIMESTAMPTZ(3),
    "appliedResult" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "GraphChangeset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GraphEdge" (
    "id" UUID NOT NULL,
    "fromPropertyId" UUID NOT NULL,
    "toPropertyId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GraphEdge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GraphHook" (
    "id" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "condition" JSONB NOT NULL,
    "eventNamespace" TEXT NOT NULL DEFAULT 'livestore',
    "eventName" TEXT NOT NULL DEFAULT 'hook_triggered',
    "eventVersion" TEXT NOT NULL DEFAULT '1',
    "eventPayload" JSONB NOT NULL DEFAULT '{}',
    "eventContext" JSONB NOT NULL DEFAULT '{}',
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "GraphHook_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GraphNodeTypeFacet" (
    "id" UUID NOT NULL,
    "typeId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT,
    "valueType" TEXT,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "resolverType" TEXT NOT NULL,
    "resolver" JSONB NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "GraphNodeTypeFacet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GraphNodeTypeField" (
    "id" UUID NOT NULL,
    "typeId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT,
    "valueType" TEXT NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "resolverType" TEXT NOT NULL,
    "resolver" JSONB NOT NULL,
    "sampleRateMs" INTEGER,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "GraphNodeTypeField_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GraphNodeTypeInput" (
    "id" UUID NOT NULL,
    "typeId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT,
    "valueType" TEXT NOT NULL,
    "entityKey" TEXT,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "GraphNodeTypeInput_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GraphNodeType" (
    "id" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "GraphNodeType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GraphNode" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "siteId" UUID NOT NULL,
    "typeRef" TEXT,
    "typeContext" JSONB NOT NULL DEFAULT '{}',
    "facets" JSONB NOT NULL DEFAULT '{}',
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "GraphNode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GraphProperty" (
    "id" UUID NOT NULL,
    "nodeId" UUID NOT NULL,
    "typeFieldKey" TEXT,
    "name" TEXT NOT NULL,
    "resolverType" TEXT NOT NULL,
    "resolver" JSONB NOT NULL,
    "sampleRateMs" INTEGER,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "GraphProperty_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntegrationRun" (
    "id" UUID NOT NULL,
    "integrationId" UUID NOT NULL,
    "actionKey" TEXT NOT NULL,
    "actionVersion" TEXT NOT NULL,
    "status" "IntegrationRunStatus" NOT NULL DEFAULT 'PENDING',
    "triggerType" TEXT NOT NULL,
    "triggerId" TEXT,
    "input" JSONB NOT NULL DEFAULT '{}',
    "result" JSONB,
    "error" TEXT,
    "dedupeKey" TEXT,
    "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMPTZ(3),
    "durationMs" INTEGER,

    CONSTRAINT "IntegrationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntegrationTrigger" (
    "id" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "eventNamespace" TEXT NOT NULL,
    "eventName" TEXT NOT NULL,
    "eventVersion" TEXT NOT NULL DEFAULT '1',
    "hookId" UUID,
    "integrationId" UUID NOT NULL,
    "actionKey" TEXT NOT NULL,
    "actionVersion" TEXT NOT NULL DEFAULT '1',
    "input" JSONB NOT NULL DEFAULT '{}',
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "IntegrationTrigger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Integration" (
    "id" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "config" JSONB NOT NULL DEFAULT '{}',
    "secretCipher" BYTEA,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Integration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryItem" (
    "id" UUID NOT NULL,
    "attrs" JSONB NOT NULL DEFAULT '{}',
    "quantity" DECIMAL(18,4) NOT NULL DEFAULT 1,
    "quantityUnit" TEXT NOT NULL DEFAULT '',
    "cycleId" UUID NOT NULL,
    "amendmentId" UUID,
    "siteId" UUID,
    "stationId" UUID,
    "workcenterId" UUID,
    "jobId" UUID,
    "productId" UUID,
    "toolId" UUID,
    "shiftInstanceId" UUID,
    "isScheduled" BOOLEAN NOT NULL DEFAULT true,
    "businessDate" DATE,
    "jobProductVersionId" UUID,
    "productVersionId" UUID NOT NULL,
    "toolVersionId" UUID,
    "toolCavityVersionId" UUID,
    "modeId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "InventoryItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ItemDispositionLog" (
    "id" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),
    "quantity" DECIMAL(18,4) NOT NULL DEFAULT 1,
    "siteId" UUID NOT NULL,
    "stationId" UUID NOT NULL,
    "workcenterId" UUID,
    "cycleId" UUID,
    "shiftInstanceId" UUID,
    "isScheduled" BOOLEAN NOT NULL DEFAULT true,
    "businessDate" DATE,
    "jobId" UUID,
    "productId" UUID,
    "toolId" UUID,
    "itemDispositionId" UUID,
    "dispositionReasonId" UUID,
    "stationVersionId" UUID,
    "jobProductVersionId" UUID,
    "productVersionId" UUID NOT NULL,
    "toolVersionId" UUID,
    "toolCavityVersionId" UUID,
    "modeId" UUID,

    CONSTRAINT "ItemDispositionLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ItemDispositionReason" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "siteId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),
    "archivedAt" TIMESTAMPTZ(3),

    CONSTRAINT "ItemDispositionReason_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ItemDisposition" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "siteId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),
    "archivedAt" TIMESTAMPTZ(3),

    CONSTRAINT "ItemDisposition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobProductVersion" (
    "id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "jobProductId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JobProductVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobProduct" (
    "id" UUID NOT NULL,
    "currentVersionId" UUID,
    "jobId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "toolId" UUID,
    "toolCavityId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "JobProduct_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobTool" (
    "id" UUID NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "jobId" UUID NOT NULL,
    "toolId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "JobTool_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobVersion" (
    "id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "standardCycle" DECIMAL(10,2),
    "standardCycleUnit" "StandardCycleUnit" NOT NULL DEFAULT 'SECONDS',
    "standardRate" DECIMAL(18,4),
    "standardRateUnit" TEXT NOT NULL DEFAULT '',
    "standardRatePeriod" "RatePeriod" NOT NULL DEFAULT 'MINUTE',
    "standardQuantity" DECIMAL(18,4),
    "productsPerCycle" INTEGER NOT NULL DEFAULT 1,
    "attrs" JSONB NOT NULL DEFAULT '{}',
    "profileId" UUID,
    "jobId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JobVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Job" (
    "id" UUID NOT NULL,
    "currentVersionId" UUID,
    "siteId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),
    "archivedAt" TIMESTAMPTZ(3),

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LabelFilter" (
    "id" UUID NOT NULL,
    "stationId" UUID NOT NULL,
    "target" "LabelFilterTarget" NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "LabelFilter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Label" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "siteId" UUID NOT NULL,

    CONSTRAINT "Label_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaterialLedgerEntry" (
    "id" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "materialId" UUID NOT NULL,
    "kind" "MaterialLedgerKind" NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "unit" "WeightUnit" NOT NULL,
    "shiftInstanceId" UUID,
    "isScheduled" BOOLEAN NOT NULL DEFAULT true,
    "businessDate" DATE,
    "unitCost" DECIMAL(14,4),
    "reference" TEXT,
    "note" TEXT,
    "description" TEXT,
    "performedByUserId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MaterialLedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaterialShiftUsage" (
    "id" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "shiftInstanceId" UUID NOT NULL,
    "isScheduled" BOOLEAN NOT NULL DEFAULT true,
    "stationId" UUID NOT NULL,
    "workcenterId" UUID,
    "businessDate" DATE,
    "jobId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "materialId" UUID NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "unit" "WeightUnit" NOT NULL,
    "itemCount" INTEGER NOT NULL DEFAULT 0,
    "flushedAt" TIMESTAMPTZ(3),
    "flushedLedgerEntryId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "MaterialShiftUsage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaterialVersion" (
    "id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "name" TEXT,
    "shortCode" TEXT,
    "materialNumber" TEXT NOT NULL,
    "classification" TEXT,
    "description" TEXT,
    "externalNumber" TEXT,
    "weightUnits" "WeightUnit",
    "unitCost" DECIMAL(14,4),
    "attrs" JSONB NOT NULL DEFAULT '{}',
    "materialId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MaterialVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Material" (
    "id" UUID NOT NULL,
    "currentVersionId" UUID,
    "siteId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),
    "archivedAt" TIMESTAMPTZ(3),

    CONSTRAINT "Material_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MetricBucketLog" (
    "id" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "entityType" "BucketEntityType" NOT NULL,
    "entityId" UUID NOT NULL,
    "entityName" TEXT NOT NULL DEFAULT '',
    "path" TEXT NOT NULL DEFAULT '',
    "granularity" "BucketGranularity" NOT NULL,
    "granularityName" TEXT NOT NULL DEFAULT '',
    "startTime" TIMESTAMPTZ(3) NOT NULL,
    "durationSeconds" INTEGER NOT NULL,
    "shiftInstanceId" UUID,
    "isScheduled" BOOLEAN NOT NULL DEFAULT true,
    "businessDate" DATE,
    "businessShift" TEXT,
    "totalCycles" INTEGER NOT NULL DEFAULT 0,
    "expectedCycles" INTEGER NOT NULL DEFAULT 0,
    "badCycles" INTEGER NOT NULL DEFAULT 0,
    "totalItems" INTEGER NOT NULL DEFAULT 0,
    "badItems" INTEGER NOT NULL DEFAULT 0,
    "expectedItems" INTEGER NOT NULL DEFAULT 0,
    "runSeconds" INTEGER NOT NULL DEFAULT 0,
    "downSeconds" INTEGER NOT NULL DEFAULT 0,
    "plannedDownSeconds" INTEGER NOT NULL DEFAULT 0,
    "unplannedDownSeconds" INTEGER NOT NULL DEFAULT 0,
    "idealCycleSeconds" INTEGER NOT NULL DEFAULT 0,
    "totalCycleSeconds" INTEGER NOT NULL DEFAULT 0,
    "elapsedExpectedCycles" INTEGER NOT NULL DEFAULT 0,
    "elapsedExpectedItems" INTEGER NOT NULL DEFAULT 0,
    "elapsedPlannedProductionSeconds" INTEGER NOT NULL DEFAULT 0,
    "currentStandardCycle" DECIMAL(10,2),
    "currentJobId" UUID,
    "currentJobName" TEXT,
    "goodCycles" INTEGER GENERATED ALWAYS AS (("totalCycles" - "badCycles")) STORED,
    "goodItems" INTEGER GENERATED ALWAYS AS (("totalItems" - "badItems")) STORED,
    "plannedProductionSeconds" INTEGER GENERATED ALWAYS AS (("durationSeconds" - "plannedDownSeconds")) STORED,
    "availability" DECIMAL(10,6) GENERATED ALWAYS AS (
CASE
    WHEN ("elapsedPlannedProductionSeconds" > 0) THEN (("runSeconds")::numeric / ("elapsedPlannedProductionSeconds")::numeric)
    ELSE NULL::numeric
END) STORED,
    "performance" DECIMAL(10,6) GENERATED ALWAYS AS (
CASE
    WHEN ("elapsedPlannedProductionSeconds" = 0) THEN NULL::numeric
    WHEN ("runSeconds" > 0) THEN (("idealCycleSeconds")::numeric / ("runSeconds")::numeric)
    ELSE (0)::numeric
END) STORED,
    "quality" DECIMAL(10,6) GENERATED ALWAYS AS (
CASE
    WHEN ("elapsedPlannedProductionSeconds" = 0) THEN NULL::numeric
    WHEN ("totalItems" > 0) THEN ((("totalItems" - "badItems"))::numeric / ("totalItems")::numeric)
    ELSE (0)::numeric
END) STORED,
    "oee" DECIMAL(10,6) GENERATED ALWAYS AS (
CASE
    WHEN ("elapsedPlannedProductionSeconds" = 0) THEN NULL::numeric
    WHEN ("totalItems" > 0) THEN ((("idealCycleSeconds")::numeric * (("totalItems" - "badItems"))::numeric) / (("elapsedPlannedProductionSeconds")::numeric * ("totalItems")::numeric))
    ELSE (0)::numeric
END) STORED,
    "archivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "MetricBucketLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MetricBucket" (
    "id" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "entityType" "BucketEntityType" NOT NULL,
    "entityId" UUID NOT NULL,
    "entityName" TEXT NOT NULL DEFAULT '',
    "path" TEXT NOT NULL DEFAULT '',
    "granularity" "BucketGranularity" NOT NULL,
    "granularityName" TEXT NOT NULL DEFAULT '',
    "startTime" TIMESTAMPTZ(3) NOT NULL,
    "durationSeconds" INTEGER NOT NULL,
    "shiftInstanceId" UUID,
    "isScheduled" BOOLEAN NOT NULL DEFAULT true,
    "businessDate" DATE,
    "businessShift" TEXT,
    "totalCycles" INTEGER NOT NULL DEFAULT 0,
    "expectedCycles" INTEGER NOT NULL DEFAULT 0,
    "badCycles" INTEGER NOT NULL DEFAULT 0,
    "totalItems" INTEGER NOT NULL DEFAULT 0,
    "badItems" INTEGER NOT NULL DEFAULT 0,
    "expectedItems" INTEGER NOT NULL DEFAULT 0,
    "runSeconds" INTEGER NOT NULL DEFAULT 0,
    "downSeconds" INTEGER NOT NULL DEFAULT 0,
    "plannedDownSeconds" INTEGER NOT NULL DEFAULT 0,
    "unplannedDownSeconds" INTEGER NOT NULL DEFAULT 0,
    "idealCycleSeconds" INTEGER NOT NULL DEFAULT 0,
    "totalCycleSeconds" INTEGER NOT NULL DEFAULT 0,
    "elapsedExpectedCycles" INTEGER NOT NULL DEFAULT 0,
    "elapsedExpectedItems" INTEGER NOT NULL DEFAULT 0,
    "elapsedPlannedProductionSeconds" INTEGER NOT NULL DEFAULT 0,
    "currentStandardCycle" DECIMAL(10,2),
    "currentJobId" UUID,
    "currentJobName" TEXT,
    "goodCycles" INTEGER GENERATED ALWAYS AS (("totalCycles" - "badCycles")) STORED,
    "goodItems" INTEGER GENERATED ALWAYS AS (("totalItems" - "badItems")) STORED,
    "plannedProductionSeconds" INTEGER GENERATED ALWAYS AS (("durationSeconds" - "plannedDownSeconds")) STORED,
    "availability" DECIMAL(10,6) GENERATED ALWAYS AS (
CASE
    WHEN ("elapsedPlannedProductionSeconds" > 0) THEN (("runSeconds")::numeric / ("elapsedPlannedProductionSeconds")::numeric)
    ELSE NULL::numeric
END) STORED,
    "performance" DECIMAL(10,6) GENERATED ALWAYS AS (
CASE
    WHEN ("elapsedPlannedProductionSeconds" = 0) THEN NULL::numeric
    WHEN ("runSeconds" > 0) THEN (("idealCycleSeconds")::numeric / ("runSeconds")::numeric)
    ELSE (0)::numeric
END) STORED,
    "quality" DECIMAL(10,6) GENERATED ALWAYS AS (
CASE
    WHEN ("elapsedPlannedProductionSeconds" = 0) THEN NULL::numeric
    WHEN ("totalItems" > 0) THEN ((("totalItems" - "badItems"))::numeric / ("totalItems")::numeric)
    ELSE (0)::numeric
END) STORED,
    "oee" DECIMAL(10,6) GENERATED ALWAYS AS (
CASE
    WHEN ("elapsedPlannedProductionSeconds" = 0) THEN NULL::numeric
    WHEN ("totalItems" > 0) THEN ((("idealCycleSeconds")::numeric * (("totalItems" - "badItems"))::numeric) / (("elapsedPlannedProductionSeconds")::numeric * ("totalItems")::numeric))
    ELSE (0)::numeric
END) STORED,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "MetricBucket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HubCursor" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "cursor" TEXT NOT NULL DEFAULT '0',
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "HubCursor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationDelivery" (
    "id" UUID NOT NULL,
    "notificationId" UUID NOT NULL,
    "employeeId" UUID,
    "channel" "NotificationChannel" NOT NULL,
    "address" TEXT,
    "status" "NotificationDeliveryStatus" NOT NULL,
    "error" TEXT,
    "providerMessageId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotificationDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationGroup" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "channels" "NotificationChannel"[] DEFAULT ARRAY['EMAIL']::"NotificationChannel"[],
    "siteId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "archivedAt" TIMESTAMPTZ(3),

    CONSTRAINT "NotificationGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "groupId" UUID,
    "groupName" TEXT,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "source" "ActionSource" NOT NULL DEFAULT 'SYSTEM',
    "sourceType" TEXT,
    "sourceRef" TEXT,
    "dedupeKey" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ObjectInstance" (
    "id" UUID NOT NULL,
    "schemaId" UUID NOT NULL,
    "siteId" UUID,
    "name" TEXT NOT NULL,
    "values" JSONB NOT NULL DEFAULT '{}',
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ObjectInstance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ObjectSchemaField" (
    "id" UUID NOT NULL,
    "schemaId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT,
    "type" "ObjectFieldType" NOT NULL,
    "refSchemaId" UUID,
    "isList" BOOLEAN NOT NULL DEFAULT false,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "config" JSONB,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ObjectSchemaField_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ObjectSchema" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "source" "ObjectSchemaSource" NOT NULL DEFAULT 'DOCUMENT',
    "meta" JSONB NOT NULL DEFAULT '{}',
    "displayFieldKey" TEXT,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "workspaceId" UUID,
    "siteId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ObjectSchema_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Customer" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "siteId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderConsumption" (
    "id" UUID NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "source" "ConsumptionSource" NOT NULL,
    "siteId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "orderLineItemId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "shiftInstanceId" UUID,
    "isScheduled" BOOLEAN NOT NULL DEFAULT true,
    "businessDate" DATE,
    "createdByUserId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderConsumption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderLineItem" (
    "id" UUID NOT NULL,
    "targetQuantity" DECIMAL(18,4) NOT NULL,
    "orderId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "OrderLineItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" UUID NOT NULL,
    "orderNumber" TEXT NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'OPEN',
    "sequence" INTEGER,
    "notes" TEXT,
    "poNumber" TEXT,
    "defaultTargetQuantity" DECIMAL(18,4) NOT NULL DEFAULT 1,
    "startDate" TIMESTAMPTZ(3),
    "dueDate" TIMESTAMPTZ(3),
    "openedAt" TIMESTAMPTZ(3),
    "completedAt" TIMESTAMPTZ(3),
    "cancelledAt" TIMESTAMPTZ(3),
    "createdByUserId" UUID,
    "siteId" UUID NOT NULL,
    "customerId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OverheadPageLog" (
    "id" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "pageId" UUID,
    "pageName" TEXT,
    "text" TEXT NOT NULL,
    "gatewayIds" UUID[],
    "priority" "OverheadPagePriority" NOT NULL,
    "chimeBefore" TEXT,
    "chimeAfter" TEXT,
    "repeat" INTEGER NOT NULL,
    "voice" TEXT,
    "speed" DOUBLE PRECISION,
    "status" "OverheadPageLogStatus" NOT NULL,
    "error" TEXT,
    "source" "ActionSource" NOT NULL DEFAULT 'MANUAL',
    "sourceType" TEXT,
    "sourceRef" TEXT,
    "sentByUserId" UUID,
    "sentByName" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OverheadPageLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OverheadPage" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "gatewayIds" UUID[],
    "priority" "OverheadPagePriority" NOT NULL DEFAULT 'NORMAL',
    "chimeBefore" TEXT,
    "chimeAfter" TEXT,
    "repeat" INTEGER NOT NULL DEFAULT 1,
    "voice" TEXT,
    "speed" DOUBLE PRECISION,
    "siteId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "archivedAt" TIMESTAMPTZ(3),

    CONSTRAINT "OverheadPage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductMaterialAltGroup" (
    "id" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "label" TEXT,
    "activeProductMaterialId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ProductMaterialAltGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductMaterialVersion" (
    "id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "weight" DECIMAL(14,4),
    "weightUnits" "WeightUnit",
    "itemCost" DECIMAL(14,4),
    "attrs" JSONB NOT NULL DEFAULT '{}',
    "productMaterialId" UUID NOT NULL,
    "materialVersionId" UUID NOT NULL,
    "productVersionId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductMaterialVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductMaterial" (
    "id" UUID NOT NULL,
    "currentVersionId" UUID,
    "productId" UUID NOT NULL,
    "materialId" UUID NOT NULL,
    "altGroupId" UUID,
    "attrs" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "archivedAt" TIMESTAMPTZ(3),

    CONSTRAINT "ProductMaterial_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductPicture" (
    "id" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductPicture_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductStockAdjustment" (
    "id" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "delta" DECIMAL(18,4) NOT NULL,
    "resultingOnHand" DECIMAL(18,4) NOT NULL,
    "reason" "StockAdjustmentReason" NOT NULL,
    "note" TEXT,
    "shiftInstanceId" UUID,
    "isScheduled" BOOLEAN NOT NULL DEFAULT true,
    "businessDate" DATE,
    "performedByUserId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductStockAdjustment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductStock" (
    "siteId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "produced" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "scrapped" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "consumed" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "adjustment" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ProductStock_pkey" PRIMARY KEY ("siteId","productId")
);

-- CreateTable
CREATE TABLE "ProductVersion" (
    "id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "sku" TEXT NOT NULL,
    "name" TEXT,
    "description" TEXT,
    "externalSku" TEXT,
    "weight" DECIMAL(14,4),
    "weightUnits" "WeightUnit",
    "itemCost" DECIMAL(14,4),
    "attrs" JSONB NOT NULL DEFAULT '{}',
    "productId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Product" (
    "id" UUID NOT NULL,
    "currentVersionId" UUID,
    "siteId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),
    "archivedAt" TIMESTAMPTZ(3),

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductionMode" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "scrapAll" BOOLEAN NOT NULL DEFAULT false,
    "itemDispositionId" UUID,
    "dispositionReasonId" UUID,
    "statusReasonId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "archivedAt" TIMESTAMPTZ(3),
    "siteId" UUID NOT NULL,

    CONSTRAINT "ProductionMode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReportDeck" (
    "id" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "workcenterId" UUID NOT NULL,
    "kind" "ReportDeckKind" NOT NULL DEFAULT 'DECK',
    "name" TEXT NOT NULL,
    "range" TEXT NOT NULL,
    "slides" JSONB NOT NULL DEFAULT '[]',
    "visibility" "ReportDeckVisibility" NOT NULL DEFAULT 'SITE',
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ReportDeck_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReportDeckEdition" (
    "id" UUID NOT NULL,
    "deckId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "asOf" TIMESTAMPTZ(3) NOT NULL,
    "dateFrom" DATE,
    "dateTo" DATE,
    "source" "ReportDeckEditionSource" NOT NULL,
    "automationId" UUID,
    "createdById" UUID,
    "setup" JSONB NOT NULL,
    "pages" JSONB NOT NULL,
    "facts" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReportDeckEdition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReportDeckLink" (
    "id" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3),
    "revokedAt" TIMESTAMPTZ(3),
    "createdById" UUID,
    "automationId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReportDeckLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReportDeckLinkEdition" (
    "linkId" UUID NOT NULL,
    "editionId" UUID NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "ReportDeckLinkEdition_pkey" PRIMARY KEY ("linkId","editionId")
);

-- CreateTable
CREATE TABLE "SavedView" (
    "id" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "page" TEXT NOT NULL,
    "scopeId" UUID,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "visibility" TEXT NOT NULL DEFAULT 'PRIVATE',
    "createdById" UUID,
    "config" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "SavedView_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShiftAmendment" (
    "id" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "workCenterId" UUID,
    "assignmentId" UUID NOT NULL,
    "businessDate" DATE NOT NULL,
    "shiftName" TEXT NOT NULL,
    "previousStartTime" TIMESTAMPTZ(3),
    "previousEndTime" TIMESTAMPTZ(3),
    "previousScheduled" BOOLEAN,
    "previousName" TEXT,
    "startTime" TIMESTAMPTZ(3),
    "endTime" TIMESTAMPTZ(3),
    "isScheduled" BOOLEAN,
    "note" TEXT,
    "windowStart" TIMESTAMPTZ(3) NOT NULL,
    "windowEnd" TIMESTAMPTZ(3) NOT NULL,
    "undoOfId" UUID,
    "status" "ShiftAmendmentStatus" NOT NULL DEFAULT 'PENDING_REBUILD',
    "rebuildError" TEXT,
    "rebuiltAt" TIMESTAMPTZ(3),
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ShiftAmendment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShiftAssignment" (
    "id" UUID NOT NULL,
    "patternId" UUID NOT NULL,
    "rotationStartDate" TIMESTAMPTZ(3) NOT NULL,
    "rotationEndDate" TIMESTAMPTZ(3),
    "rotationStartDefinitionId" UUID,
    "siteId" UUID NOT NULL,
    "workCenterId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ShiftAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShiftComment" (
    "id" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "shiftInstanceId" UUID NOT NULL,
    "workcenterId" UUID NOT NULL,
    "stationId" UUID,
    "text" TEXT NOT NULL,
    "createdById" UUID,
    "createdByEmployeeId" UUID,
    "createdByEmployeeVersionId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "ShiftComment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShiftDefinition" (
    "id" UUID NOT NULL,
    "dayOfRotation" INTEGER NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "startDayOffset" INTEGER NOT NULL DEFAULT 0,
    "startTime" TEXT NOT NULL,
    "durationHrs" DOUBLE PRECISION NOT NULL,
    "shiftName" TEXT NOT NULL,
    "isScheduled" BOOLEAN NOT NULL DEFAULT true,
    "patternId" UUID NOT NULL,

    CONSTRAINT "ShiftDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShiftInstance" (
    "id" UUID NOT NULL,
    "assignmentId" UUID NOT NULL,
    "definitionId" UUID,
    "siteId" UUID NOT NULL,
    "workCenterId" UUID,
    "shiftName" TEXT NOT NULL,
    "isScheduled" BOOLEAN NOT NULL DEFAULT true,
    "businessDate" DATE NOT NULL,
    "startTime" TIMESTAMPTZ(3) NOT NULL,
    "endTime" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShiftInstance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShiftOverride" (
    "id" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "workCenterId" UUID,
    "businessDate" DATE NOT NULL,
    "shiftName" TEXT,
    "startTime" TIMESTAMPTZ(3),
    "endTime" TIMESTAMPTZ(3),
    "isScheduled" BOOLEAN,
    "note" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ShiftOverride_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShiftPattern" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "useEndDateForBusinessDate" BOOLEAN NOT NULL DEFAULT true,
    "totalDaysInRotation" INTEGER NOT NULL DEFAULT 8,
    "startOnDayOfWeek" TEXT,
    "clonedFromId" UUID,
    "siteId" UUID NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ShiftPattern_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShiftSignoff" (
    "id" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "shiftInstanceId" UUID NOT NULL,
    "workcenterId" UUID NOT NULL,
    "postedById" UUID,
    "postedAt" TIMESTAMPTZ(3) NOT NULL,
    "reopenedById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "ShiftSignoff_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SiteAndonRule" (
    "id" UUID NOT NULL,
    "name" TEXT,
    "expression" TEXT NOT NULL,
    "referencedVariables" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "colorHex" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "siteId" UUID NOT NULL,

    CONSTRAINT "SiteAndonRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Site" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "weekStart" "WeekStart" NOT NULL DEFAULT 'MONDAY',
    "attrs" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "workspaceId" UUID NOT NULL,

    CONSTRAINT "Site_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SmsConsentEvent" (
    "id" UUID NOT NULL,
    "consentId" UUID NOT NULL,
    "status" "SmsConsentStatus" NOT NULL,
    "method" "SmsConsentMethod" NOT NULL,
    "source" "ActionSource" NOT NULL DEFAULT 'MANUAL',
    "actorUserId" UUID,
    "note" TEXT,
    "relayEventId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SmsConsentEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SmsConsent" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "phone" TEXT NOT NULL,
    "status" "SmsConsentStatus" NOT NULL,
    "method" "SmsConsentMethod" NOT NULL,
    "statusAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "SmsConsent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobHistoryAmendment" (
    "id" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "stationId" UUID NOT NULL,
    "jobId" UUID,
    "jobVersionId" UUID,
    "fromTime" TIMESTAMPTZ(3) NOT NULL,
    "toTime" TIMESTAMPTZ(3),
    "previousTimeline" JSONB NOT NULL,
    "summary" JSONB NOT NULL DEFAULT '{}',
    "status" "JobHistoryAmendmentStatus" NOT NULL DEFAULT 'PENDING_REBUILD',
    "rebuildError" TEXT,
    "rebuiltAt" TIMESTAMPTZ(3),
    "source" "ActionSource" NOT NULL DEFAULT 'MANUAL',
    "actorEmployeeId" UUID,
    "actorUserId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "JobHistoryAmendment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StationDatasource" (
    "id" UUID NOT NULL,
    "stationId" UUID NOT NULL,
    "datasourceId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StationDatasource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StationEventExecution" (
    "id" UUID NOT NULL,
    "status" "StationEventExecutionStatus" NOT NULL DEFAULT 'RUNNING',
    "payload" JSONB NOT NULL DEFAULT '{}',
    "completedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "stationEventId" UUID NOT NULL,

    CONSTRAINT "StationEventExecution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StationEvent" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "trigger" JSONB NOT NULL,
    "actions" JSONB NOT NULL,
    "lastRunAt" TIMESTAMPTZ(3),
    "runCount" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "stationId" UUID NOT NULL,

    CONSTRAINT "StationEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StationJobLog" (
    "id" UUID NOT NULL,
    "stationId" UUID NOT NULL,
    "blockId" TEXT NOT NULL,
    "siteId" UUID,
    "workcenterId" UUID,
    "shiftInstanceId" UUID,
    "isScheduled" BOOLEAN NOT NULL DEFAULT true,
    "businessDate" DATE,
    "jobId" UUID NOT NULL,
    "jobVersionId" UUID NOT NULL,
    "startTime" TIMESTAMPTZ(3) NOT NULL,
    "endTime" TIMESTAMPTZ(3),
    "standardCycle" DECIMAL(10,2),
    "standardQuantity" DECIMAL(18,4),
    "quantityUnit" TEXT NOT NULL DEFAULT '',
    "lastAccumulatedAt" TIMESTAMPTZ(3),
    "amendmentId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "StationJobLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StationLogonSession" (
    "id" UUID NOT NULL,
    "employeeId" UUID,
    "versionId" UUID,
    "stationId" UUID NOT NULL,
    "siteId" UUID,
    "workcenterId" UUID,
    "businessDate" DATE,
    "displayId" UUID NOT NULL,
    "genericName" TEXT,
    "logonMethod" TEXT NOT NULL,
    "logonTime" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "logoffTime" TIMESTAMPTZ(3),
    "shiftInstanceId" UUID,
    "isScheduled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "StationLogonSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StationModeLog" (
    "id" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "stationId" UUID NOT NULL,
    "modeId" UUID NOT NULL,
    "startTime" TIMESTAMPTZ(3) NOT NULL,
    "endTime" TIMESTAMPTZ(3),
    "workcenterId" UUID,
    "jobId" UUID,
    "jobVersionId" UUID,
    "stationVersionId" UUID,
    "toolId" UUID,
    "productId" UUID,
    "toolVersionId" UUID,
    "productVersionId" UUID,
    "shiftInstanceId" UUID,
    "isScheduled" BOOLEAN NOT NULL DEFAULT true,
    "businessDate" DATE,
    "source" "ActionSource" NOT NULL DEFAULT 'MANUAL',
    "sourceType" TEXT,
    "sourceRef" TEXT,
    "startedByEmployeeId" UUID,
    "startedByEmployeeVersionId" UUID,
    "endedByEmployeeId" UUID,
    "endedByEmployeeVersionId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "StationModeLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StationProfileVariation" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "description" TEXT,
    "signalAmount" DECIMAL(18,4),
    "signalInterval" DECIMAL(10,2),
    "position" INTEGER NOT NULL DEFAULT 0,
    "profileId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "archivedAt" TIMESTAMPTZ(3),

    CONSTRAINT "StationProfileVariation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StationProfile" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "cycleMode" "CycleMode" NOT NULL,
    "quantityUnit" TEXT NOT NULL DEFAULT '',
    "countedAs" "ProfileCountedAs" NOT NULL DEFAULT 'CYCLES',
    "standardCycle" DECIMAL(10,2),
    "standardRate" DECIMAL(18,4),
    "standardRateUnit" TEXT NOT NULL DEFAULT '',
    "standardRatePeriod" "RatePeriod" NOT NULL DEFAULT 'MINUTE',
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "archivedAt" TIMESTAMPTZ(3),
    "siteId" UUID NOT NULL,

    CONSTRAINT "StationProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StationStateLog" (
    "id" UUID NOT NULL,
    "startTime" TIMESTAMPTZ(3) NOT NULL,
    "endTime" TIMESTAMPTZ(3),
    "state" "StationState" NOT NULL,
    "blockId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),
    "stationId" UUID NOT NULL,
    "siteId" UUID,
    "workcenterId" UUID,
    "jobId" UUID,
    "shiftInstanceId" UUID,
    "isScheduled" BOOLEAN NOT NULL DEFAULT true,
    "businessDate" DATE,
    "stationVersionId" UUID,
    "jobVersionId" UUID,
    "status" "StationStatus",
    "statusReasonId" UUID,
    "isPlannedDown" BOOLEAN NOT NULL DEFAULT false,
    "modeId" UUID,

    CONSTRAINT "StationStateLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StationVersion" (
    "id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "standardCycle" DECIMAL(10,2),
    "cycleMode" "CycleMode" NOT NULL DEFAULT 'DISCRETE',
    "standardQuantity" DECIMAL(18,4),
    "quantityUnit" TEXT NOT NULL DEFAULT '',
    "standardRate" DECIMAL(18,4),
    "standardRateUnit" TEXT NOT NULL DEFAULT '',
    "standardRatePeriod" "RatePeriod" NOT NULL DEFAULT 'MINUTE',
    "inLineCalculations" BOOLEAN NOT NULL DEFAULT false,
    "inStationCalculations" BOOLEAN NOT NULL DEFAULT false,
    "downtimeDetect" DECIMAL(10,2),
    "downtimeDetectUnit" "DowntimeDetectUnit" NOT NULL DEFAULT 'SECONDS',
    "slowDetect" DECIMAL(10,2),
    "slowDetectUnit" "SlowDetectUnit" NOT NULL DEFAULT 'PERCENTAGE',
    "fastDetect" DECIMAL(10,2),
    "profileId" UUID,
    "speedFromProfile" BOOLEAN NOT NULL DEFAULT false,
    "variationId" UUID,
    "stationId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StationVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Station" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "attrs" JSONB NOT NULL DEFAULT '{}',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),
    "archivedAt" TIMESTAMPTZ(3),
    "siteId" UUID NOT NULL,
    "workcenterId" UUID,
    "currentJobId" UUID,
    "currentVersionId" UUID,

    CONSTRAINT "Station_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StatusCategory" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archivedAt" TIMESTAMPTZ(3),
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),
    "siteId" UUID NOT NULL,

    CONSTRAINT "StatusCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StatusReason" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "isPlannedDown" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "archivedAt" TIMESTAMPTZ(3),
    "siteId" UUID NOT NULL,
    "categoryId" UUID,

    CONSTRAINT "StatusReason_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockBalance" (
    "stockItemId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "onHand" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "produced" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "scrapped" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "consumed" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "adjusted" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "received" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "issued" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "StockBalance_pkey" PRIMARY KEY ("stockItemId")
);

-- CreateTable
CREATE TABLE "StockItem" (
    "id" UUID NOT NULL,
    "stockableType" "StockableType" NOT NULL,
    "stockableId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "baseUnit" TEXT NOT NULL DEFAULT '',
    "trackingMode" "TrackingMode" NOT NULL DEFAULT 'NONE',
    "reorderPoint" DECIMAL(18,4),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "StockItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockMovement" (
    "id" UUID NOT NULL,
    "seq" BIGSERIAL NOT NULL,
    "stockItemId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "kind" "StockMovementKind" NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "unit" TEXT NOT NULL DEFAULT '',
    "sourceType" "StockSourceType" NOT NULL,
    "sourceId" UUID NOT NULL,
    "idempotencyKey" TEXT,
    "reversesMovementId" UUID,
    "lotId" UUID,
    "stationId" UUID,
    "shiftInstanceId" UUID,
    "isScheduled" BOOLEAN NOT NULL DEFAULT true,
    "businessDate" DATE,
    "performedByUserId" UUID,
    "note" TEXT,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockMovement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ToolCavityVersion" (
    "id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "position" INTEGER,
    "toolCavityId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ToolCavityVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ToolCavity" (
    "id" UUID NOT NULL,
    "currentVersionId" UUID,
    "toolId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "ToolCavity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ToolVersion" (
    "id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "pmLimit" INTEGER,
    "pmWarn" INTEGER,
    "cavityCount" INTEGER,
    "toolId" UUID NOT NULL,
    "attrs" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ToolVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Tool" (
    "id" UUID NOT NULL,
    "currentVersionId" UUID,
    "pmCount" INTEGER DEFAULT 0,
    "lifeCount" INTEGER DEFAULT 0,
    "siteId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),
    "archivedAt" TIMESTAMPTZ(3),

    CONSTRAINT "Tool_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefreshToken" (
    "id" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "revokedAt" TIMESTAMPTZ(3),
    "rotatedAt" TIMESTAMPTZ(3),
    "userAgent" TEXT,
    "ipAddress" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" UUID NOT NULL,

    CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT,
    "firstName" TEXT,
    "lastName" TEXT,
    "avatarKey" TEXT,
    "status" "UserStatus" NOT NULL DEFAULT 'PENDING',
    "inviteTokenExpiry" TIMESTAMPTZ(3),
    "invitedBy" UUID,
    "invitedAt" TIMESTAMPTZ(3),
    "resetTokenHash" TEXT,
    "resetTokenExpiry" TIMESTAMPTZ(3),
    "resetAttempts" INTEGER NOT NULL DEFAULT 0,
    "failedLoginAttempts" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMPTZ(3),
    "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
    "systemRole" "SystemRole",
    "isAccountAdmin" BOOLEAN NOT NULL DEFAULT false,
    "employeeId" UUID,
    "lastLoginAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Workcenter" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "attrs" JSONB NOT NULL DEFAULT '{}',
    "slowDetect" DECIMAL(10,2),
    "fastDetect" DECIMAL(10,2),
    "downtimeDetect" DECIMAL(10,2),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "siteId" UUID NOT NULL,
    "parentId" UUID,

    CONSTRAINT "Workcenter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Workspace" (
    "id" UUID NOT NULL,
    "singletonGuard" INTEGER NOT NULL DEFAULT 0,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Workspace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_CallDefinitionOpenRoles" (
    "A" UUID NOT NULL,
    "B" UUID NOT NULL,

    CONSTRAINT "_CallDefinitionOpenRoles_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "_CallDefinitionAnswerRoles" (
    "A" UUID NOT NULL,
    "B" UUID NOT NULL,

    CONSTRAINT "_CallDefinitionAnswerRoles_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "_CycleToToolVersion" (
    "A" UUID NOT NULL,
    "B" UUID NOT NULL,

    CONSTRAINT "_CycleToToolVersion_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "_CycleToJobTool" (
    "A" UUID NOT NULL,
    "B" UUID NOT NULL,

    CONSTRAINT "_CycleToJobTool_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "_ProductionModeRoles" (
    "A" UUID NOT NULL,
    "B" UUID NOT NULL,

    CONSTRAINT "_ProductionModeRoles_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "_NotificationGroupMembers" (
    "A" UUID NOT NULL,
    "B" UUID NOT NULL,

    CONSTRAINT "_NotificationGroupMembers_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "_InventoryItemToProductMaterialVersion" (
    "A" UUID NOT NULL,
    "B" UUID NOT NULL,

    CONSTRAINT "_InventoryItemToProductMaterialVersion_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "_ItemDispositionLogToProductMaterialVersion" (
    "A" UUID NOT NULL,
    "B" UUID NOT NULL,

    CONSTRAINT "_ItemDispositionLogToProductMaterialVersion_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "_ItemDispositionReasonToLabel" (
    "A" UUID NOT NULL,
    "B" UUID NOT NULL,

    CONSTRAINT "_ItemDispositionReasonToLabel_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "_DispositionReasonDispositions" (
    "A" UUID NOT NULL,
    "B" UUID NOT NULL,

    CONSTRAINT "_DispositionReasonDispositions_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "_JobToLabel" (
    "A" UUID NOT NULL,
    "B" UUID NOT NULL,

    CONSTRAINT "_JobToLabel_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "_LabelToTool" (
    "A" UUID NOT NULL,
    "B" UUID NOT NULL,

    CONSTRAINT "_LabelToTool_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "_LabelToProduct" (
    "A" UUID NOT NULL,
    "B" UUID NOT NULL,

    CONSTRAINT "_LabelToProduct_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "_LabelToMaterial" (
    "A" UUID NOT NULL,
    "B" UUID NOT NULL,

    CONSTRAINT "_LabelToMaterial_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "_LabelToStation" (
    "A" UUID NOT NULL,
    "B" UUID NOT NULL,

    CONSTRAINT "_LabelToStation_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "_LabelToStatusReason" (
    "A" UUID NOT NULL,
    "B" UUID NOT NULL,

    CONSTRAINT "_LabelToStatusReason_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "_LabelToLabelFilter" (
    "A" UUID NOT NULL,
    "B" UUID NOT NULL,

    CONSTRAINT "_LabelToLabelFilter_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "_StationToStatusReason" (
    "A" UUID NOT NULL,
    "B" UUID NOT NULL,

    CONSTRAINT "_StationToStatusReason_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "_StatusReasonToWorkcenter" (
    "A" UUID NOT NULL,
    "B" UUID NOT NULL,

    CONSTRAINT "_StatusReasonToWorkcenter_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE UNIQUE INDEX "AgentDefinition_siteId_key_key" ON "AgentDefinition"("siteId", "key");

-- CreateIndex
CREATE INDEX "AgentTrigger_siteId_kind_enabled_idx" ON "AgentTrigger"("siteId", "kind", "enabled");

-- CreateIndex
CREATE INDEX "AgentTrigger_siteId_eventNamespace_eventName_eventVersion_e_idx" ON "AgentTrigger"("siteId", "eventNamespace", "eventName", "eventVersion", "enabled");

-- CreateIndex
CREATE INDEX "AgentSession_siteId_actorUserId_updatedAt_idx" ON "AgentSession"("siteId", "actorUserId", "updatedAt");

-- CreateIndex
CREATE INDEX "AgentSession_siteId_status_idx" ON "AgentSession"("siteId", "status");

-- CreateIndex
CREATE INDEX "AgentSession_parentSessionId_idx" ON "AgentSession"("parentSessionId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentSession_siteId_triggerRef_key" ON "AgentSession"("siteId", "triggerRef");

-- CreateIndex
CREATE UNIQUE INDEX "AgentEvent_sessionId_seq_key" ON "AgentEvent"("sessionId", "seq");

-- CreateIndex
CREATE INDEX "AgentInput_sessionId_status_createdAt_idx" ON "AgentInput"("sessionId", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AgentMessage_sessionId_seq_key" ON "AgentMessage"("sessionId", "seq");

-- CreateIndex
CREATE INDEX "AgentPermissionRequest_siteId_status_createdAt_idx" ON "AgentPermissionRequest"("siteId", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AgentPermissionRequest_sessionId_toolUseId_key" ON "AgentPermissionRequest"("sessionId", "toolUseId");

-- CreateIndex
CREATE INDEX "AgentPermissionRule_siteId_permission_idx" ON "AgentPermissionRule"("siteId", "permission");

-- CreateIndex
CREATE UNIQUE INDEX "ApiToken_tokenHash_key" ON "ApiToken"("tokenHash");

-- CreateIndex
CREATE INDEX "ApiToken_workspaceId_idx" ON "ApiToken"("workspaceId");

-- CreateIndex
CREATE INDEX "ApiToken_siteId_idx" ON "ApiToken"("siteId");

-- CreateIndex
CREATE INDEX "AuditLog_userId_idx" ON "AuditLog"("userId");

-- CreateIndex
CREATE INDEX "AuditLog_actorId_idx" ON "AuditLog"("actorId");

-- CreateIndex
CREATE INDEX "AuditLog_action_idx" ON "AuditLog"("action");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "AutomationActionRun_runId_idx" ON "AutomationActionRun"("runId");

-- CreateIndex
CREATE INDEX "AutomationActionRun_automationId_idx" ON "AutomationActionRun"("automationId");

-- CreateIndex
CREATE INDEX "AutomationActionRun_actionType_idx" ON "AutomationActionRun"("actionType");

-- CreateIndex
CREATE INDEX "AutomationRunMatch_automationId_idx" ON "AutomationRunMatch"("automationId");

-- CreateIndex
CREATE UNIQUE INDEX "AutomationRunMatch_runId_automationId_key" ON "AutomationRunMatch"("runId", "automationId");

-- CreateIndex
CREATE INDEX "AutomationRun_firedAt_idx" ON "AutomationRun"("firedAt" DESC);

-- CreateIndex
CREATE INDEX "AutomationRun_eventType_idx" ON "AutomationRun"("eventType");

-- CreateIndex
CREATE INDEX "AutomationRun_status_idx" ON "AutomationRun"("status");

-- CreateIndex
CREATE INDEX "AutomationRun_siteId_firedAt_idx" ON "AutomationRun"("siteId", "firedAt" DESC);

-- CreateIndex
CREATE INDEX "AutomationRun_correlationId_idx" ON "AutomationRun"("correlationId");

-- CreateIndex
CREATE INDEX "Automation_enabled_event_idx" ON "Automation"("enabled", "event");

-- CreateIndex
CREATE INDEX "Automation_siteId_idx" ON "Automation"("siteId");

-- CreateIndex
CREATE UNIQUE INDEX "Automation_siteId_label_key" ON "Automation"("siteId", "label");

-- CreateIndex
CREATE INDEX "BucketAccess_userId_idx" ON "BucketAccess"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "BucketAccess_bucketId_userId_key" ON "BucketAccess"("bucketId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "Bucket_workcenterId_key" ON "Bucket"("workcenterId");

-- CreateIndex
CREATE INDEX "Bucket_siteId_kind_idx" ON "Bucket"("siteId", "kind");

-- CreateIndex
CREATE INDEX "Bucket_workspaceId_idx" ON "Bucket"("workspaceId");

-- CreateIndex
CREATE INDEX "CallDefinition_siteId_idx" ON "CallDefinition"("siteId");

-- CreateIndex
CREATE UNIQUE INDEX "CallDefinition_siteId_name_key" ON "CallDefinition"("siteId", "name");

-- CreateIndex
CREATE INDEX "Call_siteId_closedAt_idx" ON "Call"("siteId", "closedAt");

-- CreateIndex
CREATE INDEX "Call_siteId_businessDate_idx" ON "Call"("siteId", "businessDate");

-- CreateIndex
CREATE INDEX "Call_stationId_closedAt_idx" ON "Call"("stationId", "closedAt");

-- CreateIndex
CREATE INDEX "Call_stationId_openedAt_idx" ON "Call"("stationId", "openedAt");

-- CreateIndex
CREATE INDEX "Call_definitionId_idx" ON "Call"("definitionId");

-- CreateIndex
CREATE INDEX "Call_shiftInstanceId_idx" ON "Call"("shiftInstanceId");

-- CreateIndex
CREATE INDEX "Call_workcenterId_idx" ON "Call"("workcenterId");

-- CreateIndex
CREATE INDEX "Call_jobId_idx" ON "Call"("jobId");

-- CreateIndex
CREATE INDEX "Call_toolId_idx" ON "Call"("toolId");

-- CreateIndex
CREATE INDEX "Call_productId_idx" ON "Call"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "Cycle_sourceEventId_key" ON "Cycle"("sourceEventId");

-- CreateIndex
CREATE INDEX "Cycle_stationId_end_idx" ON "Cycle"("stationId", "end");

-- CreateIndex
CREATE INDEX "Cycle_siteId_end_idx" ON "Cycle"("siteId", "end");

-- CreateIndex
CREATE INDEX "Cycle_siteId_deletedAt_end_idx" ON "Cycle"("siteId", "deletedAt", "end");

-- CreateIndex
CREATE INDEX "Cycle_stationId_deletedAt_end_idx" ON "Cycle"("stationId", "deletedAt", "end");

-- CreateIndex
CREATE INDEX "Cycle_jobVersionId_idx" ON "Cycle"("jobVersionId");

-- CreateIndex
CREATE INDEX "Cycle_modeId_idx" ON "Cycle"("modeId");

-- CreateIndex
CREATE INDEX "Cycle_amendmentId_idx" ON "Cycle"("amendmentId");

-- CreateIndex
CREATE INDEX "Cycle_siteId_businessDate_idx" ON "Cycle"("siteId", "businessDate");

-- CreateIndex
CREATE INDEX "Cycle_shiftInstanceId_idx" ON "Cycle"("shiftInstanceId");

-- CreateIndex
CREATE INDEX "Cycle_workcenterId_idx" ON "Cycle"("workcenterId");

-- CreateIndex
CREATE INDEX "Dashboard_siteId_idx" ON "Dashboard"("siteId");

-- CreateIndex
CREATE INDEX "Datasource_siteId_idx" ON "Datasource"("siteId");

-- CreateIndex
CREATE UNIQUE INDEX "Driver_name_version_key" ON "Driver"("name", "version");

-- CreateIndex
CREATE INDEX "PointValue_pointId_timestamp_idx" ON "PointValue"("pointId", "timestamp");

-- CreateIndex
CREATE INDEX "PointValue_timestamp_idx" ON "PointValue"("timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "DisplayRefreshToken_tokenHash_key" ON "DisplayRefreshToken"("tokenHash");

-- CreateIndex
CREATE INDEX "DisplayRefreshToken_displayId_idx" ON "DisplayRefreshToken"("displayId");

-- CreateIndex
CREATE UNIQUE INDEX "Display_claimCode_key" ON "Display"("claimCode");

-- CreateIndex
CREATE INDEX "Display_siteId_idx" ON "Display"("siteId");

-- CreateIndex
CREATE INDEX "Display_claimCode_idx" ON "Display"("claimCode");

-- CreateIndex
CREATE INDEX "Display_dashboardId_idx" ON "Display"("dashboardId");

-- CreateIndex
CREATE INDEX "Display_workcenterId_idx" ON "Display"("workcenterId");

-- CreateIndex
CREATE INDEX "Display_stationId_idx" ON "Display"("stationId");

-- CreateIndex
CREATE INDEX "DocumentLink_targetType_targetId_idx" ON "DocumentLink"("targetType", "targetId");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentLink_documentId_targetType_targetId_key" ON "DocumentLink"("documentId", "targetType", "targetId");

-- CreateIndex
CREATE UNIQUE INDEX "Document_currentFileId_key" ON "Document"("currentFileId");

-- CreateIndex
CREATE INDEX "Document_siteId_idx" ON "Document"("siteId");

-- CreateIndex
CREATE INDEX "Document_parentId_idx" ON "Document"("parentId");

-- CreateIndex
CREATE INDEX "Document_kind_status_idx" ON "Document"("kind", "status");

-- CreateIndex
CREATE INDEX "Document_labels_idx" ON "Document" USING GIN ("labels" array_ops);

-- CreateIndex
CREATE INDEX "Document_deletedAt_idx" ON "Document"("deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentFile_storageKey_key" ON "DocumentFile"("storageKey");

-- CreateIndex
CREATE INDEX "DocumentFile_documentId_idx" ON "DocumentFile"("documentId");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentFile_documentId_version_key" ON "DocumentFile"("documentId", "version");

-- CreateIndex
CREATE INDEX "EmployeeRole_siteId_idx" ON "EmployeeRole"("siteId");

-- CreateIndex
CREATE UNIQUE INDEX "EmployeeRole_siteId_name_key" ON "EmployeeRole"("siteId", "name");

-- CreateIndex
CREATE INDEX "EmployeeSiteAccess_siteId_status_idx" ON "EmployeeSiteAccess"("siteId", "status");

-- CreateIndex
CREATE INDEX "EmployeeSiteAccess_roleId_idx" ON "EmployeeSiteAccess"("roleId");

-- CreateIndex
CREATE UNIQUE INDEX "EmployeeSiteAccess_employeeId_siteId_key" ON "EmployeeSiteAccess"("employeeId", "siteId");

-- CreateIndex
CREATE INDEX "EmployeeVersion_employeeId_idx" ON "EmployeeVersion"("employeeId");

-- CreateIndex
CREATE INDEX "EmployeeVersion_badgeNumber_idx" ON "EmployeeVersion"("badgeNumber");

-- CreateIndex
CREATE UNIQUE INDEX "EmployeeVersion_employeeId_version_key" ON "EmployeeVersion"("employeeId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "Employee_versionId_key" ON "Employee"("versionId");

-- CreateIndex
CREATE INDEX "Employee_workspaceId_status_idx" ON "Employee"("workspaceId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "GatewayToken_tokenHash_key" ON "GatewayToken"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "Gateway_serialNumber_key" ON "Gateway"("serialNumber");

-- CreateIndex
CREATE INDEX "Gateway_siteId_idx" ON "Gateway"("siteId");

-- CreateIndex
CREATE INDEX "GraphChangeset_siteId_status_createdAt_idx" ON "GraphChangeset"("siteId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "GraphChangeset_sessionId_idx" ON "GraphChangeset"("sessionId");

-- CreateIndex
CREATE INDEX "GraphEdge_fromPropertyId_idx" ON "GraphEdge"("fromPropertyId");

-- CreateIndex
CREATE INDEX "GraphEdge_toPropertyId_idx" ON "GraphEdge"("toPropertyId");

-- CreateIndex
CREATE UNIQUE INDEX "GraphEdge_fromPropertyId_toPropertyId_key" ON "GraphEdge"("fromPropertyId", "toPropertyId");

-- CreateIndex
CREATE INDEX "GraphHook_siteId_enabled_idx" ON "GraphHook"("siteId", "enabled");

-- CreateIndex
CREATE INDEX "GraphHook_isDeleted_idx" ON "GraphHook"("isDeleted");

-- CreateIndex
CREATE INDEX "GraphHook_eventNamespace_eventName_idx" ON "GraphHook"("eventNamespace", "eventName");

-- CreateIndex
CREATE INDEX "GraphHook_updatedAt_idx" ON "GraphHook"("updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "GraphHook_siteId_name_key" ON "GraphHook"("siteId", "name");

-- CreateIndex
CREATE INDEX "GraphNodeTypeFacet_typeId_idx" ON "GraphNodeTypeFacet"("typeId");

-- CreateIndex
CREATE INDEX "GraphNodeTypeFacet_resolverType_idx" ON "GraphNodeTypeFacet"("resolverType");

-- CreateIndex
CREATE INDEX "GraphNodeTypeFacet_isDeleted_idx" ON "GraphNodeTypeFacet"("isDeleted");

-- CreateIndex
CREATE UNIQUE INDEX "GraphNodeTypeFacet_typeId_key_key" ON "GraphNodeTypeFacet"("typeId", "key");

-- CreateIndex
CREATE INDEX "GraphNodeTypeField_typeId_idx" ON "GraphNodeTypeField"("typeId");

-- CreateIndex
CREATE INDEX "GraphNodeTypeField_isDeleted_idx" ON "GraphNodeTypeField"("isDeleted");

-- CreateIndex
CREATE UNIQUE INDEX "GraphNodeTypeField_typeId_key_key" ON "GraphNodeTypeField"("typeId", "key");

-- CreateIndex
CREATE INDEX "GraphNodeTypeInput_typeId_idx" ON "GraphNodeTypeInput"("typeId");

-- CreateIndex
CREATE INDEX "GraphNodeTypeInput_isDeleted_idx" ON "GraphNodeTypeInput"("isDeleted");

-- CreateIndex
CREATE UNIQUE INDEX "GraphNodeTypeInput_typeId_key_key" ON "GraphNodeTypeInput"("typeId", "key");

-- CreateIndex
CREATE INDEX "GraphNodeType_siteId_idx" ON "GraphNodeType"("siteId");

-- CreateIndex
CREATE INDEX "GraphNodeType_isDeleted_idx" ON "GraphNodeType"("isDeleted");

-- CreateIndex
CREATE UNIQUE INDEX "GraphNodeType_siteId_key_key" ON "GraphNodeType"("siteId", "key");

-- CreateIndex
CREATE INDEX "GraphNode_siteId_idx" ON "GraphNode"("siteId");

-- CreateIndex
CREATE INDEX "GraphNode_siteId_typeRef_idx" ON "GraphNode"("siteId", "typeRef");

-- CreateIndex
CREATE INDEX "GraphNode_facets_idx" ON "GraphNode" USING GIN ("facets");

-- CreateIndex
CREATE INDEX "GraphNode_isDeleted_idx" ON "GraphNode"("isDeleted");

-- CreateIndex
CREATE INDEX "GraphNode_updatedAt_idx" ON "GraphNode"("updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "GraphNode_siteId_name_key" ON "GraphNode"("siteId", "name");

-- CreateIndex
CREATE INDEX "GraphProperty_nodeId_typeFieldKey_idx" ON "GraphProperty"("nodeId", "typeFieldKey");

-- CreateIndex
CREATE INDEX "GraphProperty_resolverType_idx" ON "GraphProperty"("resolverType");

-- CreateIndex
CREATE INDEX "GraphProperty_isDeleted_idx" ON "GraphProperty"("isDeleted");

-- CreateIndex
CREATE INDEX "GraphProperty_updatedAt_idx" ON "GraphProperty"("updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "GraphProperty_nodeId_name_key" ON "GraphProperty"("nodeId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "IntegrationRun_dedupeKey_key" ON "IntegrationRun"("dedupeKey");

-- CreateIndex
CREATE INDEX "IntegrationRun_integrationId_startedAt_idx" ON "IntegrationRun"("integrationId", "startedAt");

-- CreateIndex
CREATE INDEX "IntegrationRun_status_idx" ON "IntegrationRun"("status");

-- CreateIndex
CREATE INDEX "IntegrationRun_triggerType_triggerId_idx" ON "IntegrationRun"("triggerType", "triggerId");

-- CreateIndex
CREATE INDEX "IntegrationTrigger_siteId_eventNamespace_eventName_eventVer_idx" ON "IntegrationTrigger"("siteId", "eventNamespace", "eventName", "eventVersion", "enabled");

-- CreateIndex
CREATE INDEX "IntegrationTrigger_integrationId_idx" ON "IntegrationTrigger"("integrationId");

-- CreateIndex
CREATE INDEX "IntegrationTrigger_hookId_idx" ON "IntegrationTrigger"("hookId");

-- CreateIndex
CREATE INDEX "IntegrationTrigger_isDeleted_idx" ON "IntegrationTrigger"("isDeleted");

-- CreateIndex
CREATE UNIQUE INDEX "IntegrationTrigger_siteId_name_key" ON "IntegrationTrigger"("siteId", "name");

-- CreateIndex
CREATE INDEX "Integration_siteId_enabled_idx" ON "Integration"("siteId", "enabled");

-- CreateIndex
CREATE INDEX "Integration_isDeleted_idx" ON "Integration"("isDeleted");

-- CreateIndex
CREATE INDEX "Integration_updatedAt_idx" ON "Integration"("updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Integration_siteId_name_key" ON "Integration"("siteId", "name");

-- CreateIndex
CREATE INDEX "InventoryItem_cycleId_idx" ON "InventoryItem"("cycleId");

-- CreateIndex
CREATE INDEX "InventoryItem_cycleId_deletedAt_idx" ON "InventoryItem"("cycleId", "deletedAt");

-- CreateIndex
CREATE INDEX "InventoryItem_amendmentId_idx" ON "InventoryItem"("amendmentId");

-- CreateIndex
CREATE INDEX "InventoryItem_jobProductVersionId_idx" ON "InventoryItem"("jobProductVersionId");

-- CreateIndex
CREATE INDEX "InventoryItem_productVersionId_idx" ON "InventoryItem"("productVersionId");

-- CreateIndex
CREATE INDEX "InventoryItem_toolVersionId_idx" ON "InventoryItem"("toolVersionId");

-- CreateIndex
CREATE INDEX "InventoryItem_toolCavityVersionId_idx" ON "InventoryItem"("toolCavityVersionId");

-- CreateIndex
CREATE INDEX "InventoryItem_siteId_businessDate_idx" ON "InventoryItem"("siteId", "businessDate");

-- CreateIndex
CREATE INDEX "InventoryItem_shiftInstanceId_idx" ON "InventoryItem"("shiftInstanceId");

-- CreateIndex
CREATE INDEX "InventoryItem_workcenterId_idx" ON "InventoryItem"("workcenterId");

-- CreateIndex
CREATE INDEX "ItemDispositionLog_stationId_createdAt_idx" ON "ItemDispositionLog"("stationId", "createdAt");

-- CreateIndex
CREATE INDEX "ItemDispositionLog_siteId_productVersionId_idx" ON "ItemDispositionLog"("siteId", "productVersionId");

-- CreateIndex
CREATE INDEX "ItemDispositionLog_modeId_idx" ON "ItemDispositionLog"("modeId");

-- CreateIndex
CREATE INDEX "ItemDispositionLog_siteId_businessDate_idx" ON "ItemDispositionLog"("siteId", "businessDate");

-- CreateIndex
CREATE INDEX "ItemDispositionReason_siteId_idx" ON "ItemDispositionReason"("siteId");

-- CreateIndex
CREATE UNIQUE INDEX "ItemDispositionReason_siteId_name_key" ON "ItemDispositionReason"("siteId", "name");

-- CreateIndex
CREATE INDEX "ItemDisposition_siteId_idx" ON "ItemDisposition"("siteId");

-- CreateIndex
CREATE UNIQUE INDEX "ItemDisposition_siteId_name_key" ON "ItemDisposition"("siteId", "name");

-- CreateIndex
CREATE INDEX "JobProductVersion_jobProductId_idx" ON "JobProductVersion"("jobProductId");

-- CreateIndex
CREATE UNIQUE INDEX "JobProductVersion_jobProductId_version_key" ON "JobProductVersion"("jobProductId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "JobProduct_currentVersionId_key" ON "JobProduct"("currentVersionId");

-- CreateIndex
CREATE INDEX "JobProduct_jobId_idx" ON "JobProduct"("jobId");

-- CreateIndex
CREATE INDEX "JobProduct_productId_idx" ON "JobProduct"("productId");

-- CreateIndex
CREATE INDEX "JobProduct_toolId_idx" ON "JobProduct"("toolId");

-- CreateIndex
CREATE INDEX "JobProduct_toolCavityId_idx" ON "JobProduct"("toolCavityId");

-- CreateIndex
CREATE INDEX "JobTool_toolId_idx" ON "JobTool"("toolId");

-- CreateIndex
CREATE UNIQUE INDEX "JobTool_jobId_toolId_key" ON "JobTool"("jobId", "toolId");

-- CreateIndex
CREATE INDEX "JobVersion_jobId_idx" ON "JobVersion"("jobId");

-- CreateIndex
CREATE INDEX "JobVersion_profileId_idx" ON "JobVersion"("profileId");

-- CreateIndex
CREATE UNIQUE INDEX "JobVersion_jobId_version_key" ON "JobVersion"("jobId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "Job_currentVersionId_key" ON "Job"("currentVersionId");

-- CreateIndex
CREATE INDEX "LabelFilter_stationId_idx" ON "LabelFilter"("stationId");

-- CreateIndex
CREATE UNIQUE INDEX "LabelFilter_stationId_target_key" ON "LabelFilter"("stationId", "target");

-- CreateIndex
CREATE INDEX "Label_siteId_idx" ON "Label"("siteId");

-- CreateIndex
CREATE UNIQUE INDEX "Label_siteId_name_key" ON "Label"("siteId", "name");

-- CreateIndex
CREATE INDEX "MaterialLedgerEntry_materialId_createdAt_idx" ON "MaterialLedgerEntry"("materialId", "createdAt");

-- CreateIndex
CREATE INDEX "MaterialLedgerEntry_siteId_createdAt_idx" ON "MaterialLedgerEntry"("siteId", "createdAt");

-- CreateIndex
CREATE INDEX "MaterialLedgerEntry_siteId_businessDate_idx" ON "MaterialLedgerEntry"("siteId", "businessDate");

-- CreateIndex
CREATE INDEX "MaterialLedgerEntry_shiftInstanceId_idx" ON "MaterialLedgerEntry"("shiftInstanceId");

-- CreateIndex
CREATE INDEX "MaterialShiftUsage_materialId_flushedAt_idx" ON "MaterialShiftUsage"("materialId", "flushedAt");

-- CreateIndex
CREATE INDEX "MaterialShiftUsage_siteId_shiftInstanceId_idx" ON "MaterialShiftUsage"("siteId", "shiftInstanceId");

-- CreateIndex
CREATE INDEX "MaterialShiftUsage_siteId_businessDate_idx" ON "MaterialShiftUsage"("siteId", "businessDate");

-- CreateIndex
CREATE INDEX "MaterialShiftUsage_stationId_idx" ON "MaterialShiftUsage"("stationId");

-- CreateIndex
CREATE INDEX "MaterialShiftUsage_jobId_idx" ON "MaterialShiftUsage"("jobId");

-- CreateIndex
CREATE INDEX "MaterialShiftUsage_flushedLedgerEntryId_idx" ON "MaterialShiftUsage"("flushedLedgerEntryId");

-- CreateIndex
CREATE UNIQUE INDEX "MaterialShiftUsage_shiftInstanceId_stationId_jobId_productI_key" ON "MaterialShiftUsage"("shiftInstanceId", "stationId", "jobId", "productId", "materialId");

-- CreateIndex
CREATE INDEX "MaterialVersion_materialId_idx" ON "MaterialVersion"("materialId");

-- CreateIndex
CREATE UNIQUE INDEX "MaterialVersion_materialId_version_key" ON "MaterialVersion"("materialId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "Material_currentVersionId_key" ON "Material"("currentVersionId");

-- CreateIndex
CREATE INDEX "MetricBucketLog_siteId_granularity_startTime_idx" ON "MetricBucketLog"("siteId", "granularity", "startTime");

-- CreateIndex
CREATE INDEX "MetricBucketLog_siteId_businessDate_idx" ON "MetricBucketLog"("siteId", "businessDate");

-- CreateIndex
CREATE INDEX "MetricBucketLog_siteId_archivedAt_idx" ON "MetricBucketLog"("siteId", "archivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "MetricBucketLog_entityType_entityId_granularity_startTime_key" ON "MetricBucketLog"("entityType", "entityId", "granularity", "startTime");

-- CreateIndex
CREATE INDEX "MetricBucket_siteId_granularity_startTime_idx" ON "MetricBucket"("siteId", "granularity", "startTime");

-- CreateIndex
CREATE INDEX "MetricBucket_siteId_businessDate_idx" ON "MetricBucket"("siteId", "businessDate");

-- CreateIndex
CREATE UNIQUE INDEX "MetricBucket_entityType_entityId_granularity_startTime_key" ON "MetricBucket"("entityType", "entityId", "granularity", "startTime");

-- CreateIndex
CREATE INDEX "NotificationDelivery_notificationId_idx" ON "NotificationDelivery"("notificationId");

-- CreateIndex
CREATE INDEX "NotificationDelivery_employeeId_idx" ON "NotificationDelivery"("employeeId");

-- CreateIndex
CREATE INDEX "NotificationGroup_siteId_idx" ON "NotificationGroup"("siteId");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationGroup_siteId_name_key" ON "NotificationGroup"("siteId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Notification_dedupeKey_key" ON "Notification"("dedupeKey");

-- CreateIndex
CREATE INDEX "Notification_siteId_createdAt_idx" ON "Notification"("siteId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Notification_groupId_idx" ON "Notification"("groupId");

-- CreateIndex
CREATE INDEX "ObjectInstance_schemaId_idx" ON "ObjectInstance"("schemaId");

-- CreateIndex
CREATE INDEX "ObjectInstance_siteId_idx" ON "ObjectInstance"("siteId");

-- CreateIndex
CREATE INDEX "ObjectInstance_siteId_schemaId_isDeleted_idx" ON "ObjectInstance"("siteId", "schemaId", "isDeleted");

-- CreateIndex
CREATE INDEX "ObjectInstance_schemaId_isDeleted_idx" ON "ObjectInstance"("schemaId", "isDeleted");

-- CreateIndex
CREATE INDEX "ObjectInstance_values_idx" ON "ObjectInstance" USING GIN ("values");

-- CreateIndex
CREATE INDEX "ObjectSchemaField_schemaId_idx" ON "ObjectSchemaField"("schemaId");

-- CreateIndex
CREATE INDEX "ObjectSchemaField_refSchemaId_idx" ON "ObjectSchemaField"("refSchemaId");

-- CreateIndex
CREATE INDEX "ObjectSchemaField_type_idx" ON "ObjectSchemaField"("type");

-- CreateIndex
CREATE INDEX "ObjectSchemaField_isDeleted_idx" ON "ObjectSchemaField"("isDeleted");

-- CreateIndex
CREATE UNIQUE INDEX "ObjectSchemaField_schemaId_key_key" ON "ObjectSchemaField"("schemaId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "ObjectSchemaField_schemaId_name_key" ON "ObjectSchemaField"("schemaId", "name");

-- CreateIndex
CREATE INDEX "ObjectSchema_workspaceId_idx" ON "ObjectSchema"("workspaceId");

-- CreateIndex
CREATE INDEX "ObjectSchema_siteId_idx" ON "ObjectSchema"("siteId");

-- CreateIndex
CREATE INDEX "ObjectSchema_source_idx" ON "ObjectSchema"("source");

-- CreateIndex
CREATE INDEX "ObjectSchema_isSystem_idx" ON "ObjectSchema"("isSystem");

-- CreateIndex
CREATE INDEX "ObjectSchema_isDeleted_idx" ON "ObjectSchema"("isDeleted");

-- CreateIndex
CREATE UNIQUE INDEX "ObjectSchema_siteId_key_key" ON "ObjectSchema"("siteId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "ObjectSchema_workspaceId_name_key" ON "ObjectSchema"("workspaceId", "name");

-- CreateIndex
CREATE INDEX "Customer_siteId_idx" ON "Customer"("siteId");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_siteId_name_key" ON "Customer"("siteId", "name");

-- CreateIndex
CREATE INDEX "OrderConsumption_orderId_idx" ON "OrderConsumption"("orderId");

-- CreateIndex
CREATE INDEX "OrderConsumption_siteId_productId_idx" ON "OrderConsumption"("siteId", "productId");

-- CreateIndex
CREATE INDEX "OrderConsumption_siteId_businessDate_idx" ON "OrderConsumption"("siteId", "businessDate");

-- CreateIndex
CREATE INDEX "OrderConsumption_shiftInstanceId_idx" ON "OrderConsumption"("shiftInstanceId");

-- CreateIndex
CREATE INDEX "OrderLineItem_productId_idx" ON "OrderLineItem"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "OrderLineItem_orderId_productId_key" ON "OrderLineItem"("orderId", "productId");

-- CreateIndex
CREATE INDEX "Order_siteId_status_idx" ON "Order"("siteId", "status");

-- CreateIndex
CREATE INDEX "Order_siteId_sequence_idx" ON "Order"("siteId", "sequence");

-- CreateIndex
CREATE INDEX "Order_siteId_completedAt_idx" ON "Order"("siteId", "completedAt");

-- CreateIndex
CREATE INDEX "Order_customerId_idx" ON "Order"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "Order_siteId_orderNumber_key" ON "Order"("siteId", "orderNumber");

-- CreateIndex
CREATE INDEX "OverheadPageLog_siteId_createdAt_idx" ON "OverheadPageLog"("siteId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "OverheadPageLog_pageId_idx" ON "OverheadPageLog"("pageId");

-- CreateIndex
CREATE INDEX "OverheadPage_siteId_idx" ON "OverheadPage"("siteId");

-- CreateIndex
CREATE UNIQUE INDEX "OverheadPage_siteId_name_key" ON "OverheadPage"("siteId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "ProductMaterialAltGroup_activeProductMaterialId_key" ON "ProductMaterialAltGroup"("activeProductMaterialId");

-- CreateIndex
CREATE INDEX "ProductMaterialAltGroup_productId_idx" ON "ProductMaterialAltGroup"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductMaterialAltGroup_productId_label_key" ON "ProductMaterialAltGroup"("productId", "label");

-- CreateIndex
CREATE INDEX "ProductMaterialVersion_productMaterialId_idx" ON "ProductMaterialVersion"("productMaterialId");

-- CreateIndex
CREATE INDEX "ProductMaterialVersion_materialVersionId_idx" ON "ProductMaterialVersion"("materialVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductMaterialVersion_productMaterialId_version_key" ON "ProductMaterialVersion"("productMaterialId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "ProductMaterial_currentVersionId_key" ON "ProductMaterial"("currentVersionId");

-- CreateIndex
CREATE INDEX "ProductMaterial_materialId_idx" ON "ProductMaterial"("materialId");

-- CreateIndex
CREATE INDEX "ProductMaterial_altGroupId_idx" ON "ProductMaterial"("altGroupId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductMaterial_productId_materialId_key" ON "ProductMaterial"("productId", "materialId");

-- CreateIndex
CREATE INDEX "ProductPicture_productId_idx" ON "ProductPicture"("productId");

-- CreateIndex
CREATE INDEX "ProductStockAdjustment_siteId_productId_createdAt_idx" ON "ProductStockAdjustment"("siteId", "productId", "createdAt");

-- CreateIndex
CREATE INDEX "ProductStockAdjustment_siteId_createdAt_idx" ON "ProductStockAdjustment"("siteId", "createdAt");

-- CreateIndex
CREATE INDEX "ProductStockAdjustment_siteId_businessDate_idx" ON "ProductStockAdjustment"("siteId", "businessDate");

-- CreateIndex
CREATE INDEX "ProductStockAdjustment_shiftInstanceId_idx" ON "ProductStockAdjustment"("shiftInstanceId");

-- CreateIndex
CREATE INDEX "ProductVersion_productId_idx" ON "ProductVersion"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductVersion_productId_version_key" ON "ProductVersion"("productId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "Product_currentVersionId_key" ON "Product"("currentVersionId");

-- CreateIndex
CREATE INDEX "ProductionMode_siteId_idx" ON "ProductionMode"("siteId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductionMode_siteId_name_key" ON "ProductionMode"("siteId", "name");

-- CreateIndex
CREATE INDEX "ReportDeck_siteId_kind_idx" ON "ReportDeck"("siteId", "kind");

-- CreateIndex
CREATE INDEX "ReportDeck_workcenterId_idx" ON "ReportDeck"("workcenterId");

-- CreateIndex
CREATE INDEX "ReportDeckEdition_deckId_asOf_idx" ON "ReportDeckEdition"("deckId", "asOf");

-- CreateIndex
CREATE INDEX "ReportDeckEdition_siteId_idx" ON "ReportDeckEdition"("siteId");

-- CreateIndex
CREATE UNIQUE INDEX "ReportDeckLink_tokenHash_key" ON "ReportDeckLink"("tokenHash");

-- CreateIndex
CREATE INDEX "ReportDeckLink_siteId_idx" ON "ReportDeckLink"("siteId");

-- CreateIndex
CREATE INDEX "ReportDeckLinkEdition_editionId_idx" ON "ReportDeckLinkEdition"("editionId");

-- CreateIndex
CREATE INDEX "SavedView_siteId_page_scopeId_idx" ON "SavedView"("siteId", "page", "scopeId");

-- CreateIndex
CREATE INDEX "SavedView_createdById_idx" ON "SavedView"("createdById");

-- CreateIndex
CREATE INDEX "ShiftAmendment_siteId_businessDate_idx" ON "ShiftAmendment"("siteId", "businessDate");

-- CreateIndex
CREATE INDEX "ShiftAmendment_workCenterId_businessDate_idx" ON "ShiftAmendment"("workCenterId", "businessDate");

-- CreateIndex
CREATE INDEX "ShiftAmendment_siteId_status_idx" ON "ShiftAmendment"("siteId", "status");

-- CreateIndex
CREATE INDEX "ShiftAmendment_undoOfId_idx" ON "ShiftAmendment"("undoOfId");

-- CreateIndex
CREATE INDEX "ShiftAssignment_siteId_idx" ON "ShiftAssignment"("siteId");

-- CreateIndex
CREATE INDEX "ShiftAssignment_workCenterId_idx" ON "ShiftAssignment"("workCenterId");

-- CreateIndex
CREATE UNIQUE INDEX "ShiftAssignment_patternId_key" ON "ShiftAssignment"("patternId");

-- CreateIndex
CREATE INDEX "ShiftComment_shiftInstanceId_idx" ON "ShiftComment"("shiftInstanceId");

-- CreateIndex
CREATE INDEX "ShiftComment_shiftInstanceId_stationId_idx" ON "ShiftComment"("shiftInstanceId", "stationId");

-- CreateIndex
CREATE INDEX "ShiftComment_stationId_idx" ON "ShiftComment"("stationId");

-- CreateIndex
CREATE INDEX "ShiftDefinition_patternId_dayOfRotation_idx" ON "ShiftDefinition"("patternId", "dayOfRotation");

-- CreateIndex
CREATE UNIQUE INDEX "ShiftDefinition_patternId_dayOfRotation_sortOrder_key" ON "ShiftDefinition"("patternId", "dayOfRotation", "sortOrder");

-- CreateIndex
CREATE INDEX "ShiftInstance_workCenterId_startTime_endTime_idx" ON "ShiftInstance"("workCenterId", "startTime", "endTime");

-- CreateIndex
CREATE INDEX "ShiftInstance_siteId_startTime_endTime_idx" ON "ShiftInstance"("siteId", "startTime", "endTime");

-- CreateIndex
CREATE INDEX "ShiftInstance_siteId_businessDate_idx" ON "ShiftInstance"("siteId", "businessDate");

-- CreateIndex
CREATE INDEX "ShiftInstance_workCenterId_businessDate_idx" ON "ShiftInstance"("workCenterId", "businessDate");

-- CreateIndex
CREATE UNIQUE INDEX "ShiftInstance_assignmentId_startTime_key" ON "ShiftInstance"("assignmentId", "startTime");

-- CreateIndex
CREATE INDEX "ShiftOverride_siteId_businessDate_idx" ON "ShiftOverride"("siteId", "businessDate");

-- CreateIndex
CREATE INDEX "ShiftOverride_workCenterId_businessDate_idx" ON "ShiftOverride"("workCenterId", "businessDate");

-- CreateIndex
CREATE INDEX "ShiftSignoff_workcenterId_idx" ON "ShiftSignoff"("workcenterId");

-- CreateIndex
CREATE UNIQUE INDEX "ShiftSignoff_shiftInstanceId_workcenterId_key" ON "ShiftSignoff"("shiftInstanceId", "workcenterId");

-- CreateIndex
CREATE INDEX "SiteAndonRule_siteId_idx" ON "SiteAndonRule"("siteId");

-- CreateIndex
CREATE INDEX "SiteAndonRule_siteId_sortOrder_idx" ON "SiteAndonRule"("siteId", "sortOrder");

-- CreateIndex
CREATE INDEX "Site_workspaceId_idx" ON "Site"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "Site_workspaceId_name_key" ON "Site"("workspaceId", "name");

-- CreateIndex
CREATE INDEX "SmsConsentEvent_consentId_createdAt_idx" ON "SmsConsentEvent"("consentId", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "SmsConsentEvent_consentId_relayEventId_key" ON "SmsConsentEvent"("consentId", "relayEventId");

-- CreateIndex
CREATE INDEX "SmsConsent_workspaceId_status_idx" ON "SmsConsent"("workspaceId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "SmsConsent_workspaceId_phone_key" ON "SmsConsent"("workspaceId", "phone");

-- CreateIndex
CREATE INDEX "JobHistoryAmendment_stationId_createdAt_idx" ON "JobHistoryAmendment"("stationId", "createdAt");

-- CreateIndex
CREATE INDEX "JobHistoryAmendment_siteId_status_idx" ON "JobHistoryAmendment"("siteId", "status");

-- CreateIndex
CREATE INDEX "StationDatasource_stationId_idx" ON "StationDatasource"("stationId");

-- CreateIndex
CREATE INDEX "StationDatasource_datasourceId_idx" ON "StationDatasource"("datasourceId");

-- CreateIndex
CREATE UNIQUE INDEX "StationDatasource_stationId_datasourceId_key" ON "StationDatasource"("stationId", "datasourceId");

-- CreateIndex
CREATE INDEX "StationEventExecution_stationEventId_createdAt_idx" ON "StationEventExecution"("stationEventId", "createdAt");

-- CreateIndex
CREATE INDEX "StationEventExecution_stationEventId_status_idx" ON "StationEventExecution"("stationEventId", "status");

-- CreateIndex
CREATE INDEX "StationEvent_stationId_enabled_idx" ON "StationEvent"("stationId", "enabled");

-- CreateIndex
CREATE INDEX "StationEvent_stationId_createdAt_idx" ON "StationEvent"("stationId", "createdAt");

-- CreateIndex
CREATE INDEX "StationJobLog_stationId_idx" ON "StationJobLog"("stationId");

-- CreateIndex
CREATE INDEX "StationJobLog_stationId_endTime_idx" ON "StationJobLog"("stationId", "endTime");

-- CreateIndex
CREATE INDEX "StationJobLog_stationId_startTime_idx" ON "StationJobLog"("stationId", "startTime");

-- CreateIndex
CREATE INDEX "StationJobLog_jobId_idx" ON "StationJobLog"("jobId");

-- CreateIndex
CREATE INDEX "StationJobLog_blockId_idx" ON "StationJobLog"("blockId");

-- CreateIndex
CREATE INDEX "StationJobLog_siteId_businessDate_idx" ON "StationJobLog"("siteId", "businessDate");

-- CreateIndex
CREATE INDEX "StationJobLog_shiftInstanceId_idx" ON "StationJobLog"("shiftInstanceId");

-- CreateIndex
CREATE INDEX "StationJobLog_amendmentId_idx" ON "StationJobLog"("amendmentId");

-- CreateIndex
CREATE INDEX "StationLogonSession_stationId_logoffTime_idx" ON "StationLogonSession"("stationId", "logoffTime");

-- CreateIndex
CREATE INDEX "StationLogonSession_employeeId_idx" ON "StationLogonSession"("employeeId");

-- CreateIndex
CREATE INDEX "StationLogonSession_displayId_idx" ON "StationLogonSession"("displayId");

-- CreateIndex
CREATE INDEX "StationLogonSession_siteId_businessDate_idx" ON "StationLogonSession"("siteId", "businessDate");

-- CreateIndex
CREATE INDEX "StationModeLog_stationId_startTime_idx" ON "StationModeLog"("stationId", "startTime");

-- CreateIndex
CREATE INDEX "StationModeLog_stationId_endTime_idx" ON "StationModeLog"("stationId", "endTime");

-- CreateIndex
CREATE INDEX "StationModeLog_siteId_idx" ON "StationModeLog"("siteId");

-- CreateIndex
CREATE INDEX "StationModeLog_siteId_businessDate_idx" ON "StationModeLog"("siteId", "businessDate");

-- CreateIndex
CREATE INDEX "StationModeLog_modeId_idx" ON "StationModeLog"("modeId");

-- CreateIndex
CREATE INDEX "StationModeLog_shiftInstanceId_idx" ON "StationModeLog"("shiftInstanceId");

-- CreateIndex
CREATE INDEX "StationModeLog_workcenterId_idx" ON "StationModeLog"("workcenterId");

-- CreateIndex
CREATE INDEX "StationModeLog_jobId_idx" ON "StationModeLog"("jobId");

-- CreateIndex
CREATE INDEX "StationModeLog_toolId_idx" ON "StationModeLog"("toolId");

-- CreateIndex
CREATE INDEX "StationModeLog_productId_idx" ON "StationModeLog"("productId");

-- CreateIndex
CREATE INDEX "StationProfileVariation_profileId_idx" ON "StationProfileVariation"("profileId");

-- CreateIndex
CREATE INDEX "StationProfile_siteId_idx" ON "StationProfile"("siteId");

-- CreateIndex
CREATE UNIQUE INDEX "StationProfile_siteId_name_key" ON "StationProfile"("siteId", "name");

-- CreateIndex
CREATE INDEX "StationStateLog_stationId_idx" ON "StationStateLog"("stationId");

-- CreateIndex
CREATE INDEX "StationStateLog_stationId_endTime_idx" ON "StationStateLog"("stationId", "endTime");

-- CreateIndex
CREATE INDEX "StationStateLog_stationId_startTime_idx" ON "StationStateLog"("stationId", "startTime");

-- CreateIndex
CREATE INDEX "StationStateLog_stationId_updatedAt_idx" ON "StationStateLog"("stationId", "updatedAt");

-- CreateIndex
CREATE INDEX "StationStateLog_statusReasonId_idx" ON "StationStateLog"("statusReasonId");

-- CreateIndex
CREATE INDEX "StationStateLog_jobVersionId_idx" ON "StationStateLog"("jobVersionId");

-- CreateIndex
CREATE INDEX "StationStateLog_siteId_businessDate_idx" ON "StationStateLog"("siteId", "businessDate");

-- CreateIndex
CREATE INDEX "StationStateLog_shiftInstanceId_idx" ON "StationStateLog"("shiftInstanceId");

-- CreateIndex
CREATE INDEX "StationStateLog_workcenterId_idx" ON "StationStateLog"("workcenterId");

-- CreateIndex
CREATE INDEX "StationVersion_stationId_idx" ON "StationVersion"("stationId");

-- CreateIndex
CREATE INDEX "StationVersion_profileId_idx" ON "StationVersion"("profileId");

-- CreateIndex
CREATE INDEX "StationVersion_variationId_idx" ON "StationVersion"("variationId");

-- CreateIndex
CREATE UNIQUE INDEX "StationVersion_stationId_version_key" ON "StationVersion"("stationId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "Station_currentVersionId_key" ON "Station"("currentVersionId");

-- CreateIndex
CREATE INDEX "Station_siteId_idx" ON "Station"("siteId");

-- CreateIndex
CREATE INDEX "Station_workcenterId_idx" ON "Station"("workcenterId");

-- CreateIndex
CREATE INDEX "Station_currentJobId_idx" ON "Station"("currentJobId");

-- CreateIndex
CREATE UNIQUE INDEX "Station_siteId_name_key" ON "Station"("siteId", "name");

-- CreateIndex
CREATE INDEX "StatusCategory_siteId_idx" ON "StatusCategory"("siteId");

-- CreateIndex
CREATE UNIQUE INDEX "StatusCategory_siteId_name_key" ON "StatusCategory"("siteId", "name");

-- CreateIndex
CREATE INDEX "StatusReason_siteId_idx" ON "StatusReason"("siteId");

-- CreateIndex
CREATE INDEX "StatusReason_categoryId_idx" ON "StatusReason"("categoryId");

-- CreateIndex
CREATE UNIQUE INDEX "StatusReason_siteId_name_key" ON "StatusReason"("siteId", "name");

-- CreateIndex
CREATE INDEX "StockBalance_siteId_idx" ON "StockBalance"("siteId");

-- CreateIndex
CREATE INDEX "StockItem_siteId_stockableType_idx" ON "StockItem"("siteId", "stockableType");

-- CreateIndex
CREATE UNIQUE INDEX "StockItem_stockableType_stockableId_key" ON "StockItem"("stockableType", "stockableId");

-- CreateIndex
CREATE UNIQUE INDEX "StockMovement_seq_key" ON "StockMovement"("seq");

-- CreateIndex
CREATE UNIQUE INDEX "StockMovement_idempotencyKey_key" ON "StockMovement"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "StockMovement_reversesMovementId_key" ON "StockMovement"("reversesMovementId");

-- CreateIndex
CREATE INDEX "StockMovement_stockItemId_occurredAt_idx" ON "StockMovement"("stockItemId", "occurredAt");

-- CreateIndex
CREATE INDEX "StockMovement_sourceType_sourceId_idx" ON "StockMovement"("sourceType", "sourceId");

-- CreateIndex
CREATE INDEX "StockMovement_siteId_occurredAt_idx" ON "StockMovement"("siteId", "occurredAt");

-- CreateIndex
CREATE INDEX "StockMovement_siteId_businessDate_idx" ON "StockMovement"("siteId", "businessDate");

-- CreateIndex
CREATE INDEX "StockMovement_shiftInstanceId_idx" ON "StockMovement"("shiftInstanceId");

-- CreateIndex
CREATE INDEX "StockMovement_stationId_idx" ON "StockMovement"("stationId");

-- CreateIndex
CREATE INDEX "ToolCavityVersion_toolCavityId_idx" ON "ToolCavityVersion"("toolCavityId");

-- CreateIndex
CREATE UNIQUE INDEX "ToolCavityVersion_toolCavityId_version_key" ON "ToolCavityVersion"("toolCavityId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "ToolCavity_currentVersionId_key" ON "ToolCavity"("currentVersionId");

-- CreateIndex
CREATE INDEX "ToolCavity_toolId_idx" ON "ToolCavity"("toolId");

-- CreateIndex
CREATE INDEX "ToolVersion_toolId_idx" ON "ToolVersion"("toolId");

-- CreateIndex
CREATE UNIQUE INDEX "ToolVersion_toolId_version_key" ON "ToolVersion"("toolId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "Tool_currentVersionId_key" ON "Tool"("currentVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "RefreshToken_tokenHash_key" ON "RefreshToken"("tokenHash");

-- CreateIndex
CREATE INDEX "RefreshToken_userId_idx" ON "RefreshToken"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_employeeId_key" ON "User"("employeeId");

-- CreateIndex
CREATE INDEX "Workcenter_siteId_idx" ON "Workcenter"("siteId");

-- CreateIndex
CREATE INDEX "Workcenter_parentId_idx" ON "Workcenter"("parentId");

-- CreateIndex
CREATE UNIQUE INDEX "Workcenter_siteId_parentId_name_key" ON "Workcenter"("siteId", "parentId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Workspace_singletonGuard_key" ON "Workspace"("singletonGuard");

-- CreateIndex
CREATE UNIQUE INDEX "Workspace_name_key" ON "Workspace"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Workspace_slug_key" ON "Workspace"("slug");

-- CreateIndex
CREATE INDEX "_CallDefinitionOpenRoles_B_index" ON "_CallDefinitionOpenRoles"("B");

-- CreateIndex
CREATE INDEX "_CallDefinitionAnswerRoles_B_index" ON "_CallDefinitionAnswerRoles"("B");

-- CreateIndex
CREATE INDEX "_CycleToToolVersion_B_index" ON "_CycleToToolVersion"("B");

-- CreateIndex
CREATE INDEX "_CycleToJobTool_B_index" ON "_CycleToJobTool"("B");

-- CreateIndex
CREATE INDEX "_ProductionModeRoles_B_index" ON "_ProductionModeRoles"("B");

-- CreateIndex
CREATE INDEX "_NotificationGroupMembers_B_index" ON "_NotificationGroupMembers"("B");

-- CreateIndex
CREATE INDEX "_InventoryItemToProductMaterialVersion_B_index" ON "_InventoryItemToProductMaterialVersion"("B");

-- CreateIndex
CREATE INDEX "_ItemDispositionLogToProductMaterialVersion_B_index" ON "_ItemDispositionLogToProductMaterialVersion"("B");

-- CreateIndex
CREATE INDEX "_ItemDispositionReasonToLabel_B_index" ON "_ItemDispositionReasonToLabel"("B");

-- CreateIndex
CREATE INDEX "_DispositionReasonDispositions_B_index" ON "_DispositionReasonDispositions"("B");

-- CreateIndex
CREATE INDEX "_JobToLabel_B_index" ON "_JobToLabel"("B");

-- CreateIndex
CREATE INDEX "_LabelToTool_B_index" ON "_LabelToTool"("B");

-- CreateIndex
CREATE INDEX "_LabelToProduct_B_index" ON "_LabelToProduct"("B");

-- CreateIndex
CREATE INDEX "_LabelToMaterial_B_index" ON "_LabelToMaterial"("B");

-- CreateIndex
CREATE INDEX "_LabelToStation_B_index" ON "_LabelToStation"("B");

-- CreateIndex
CREATE INDEX "_LabelToStatusReason_B_index" ON "_LabelToStatusReason"("B");

-- CreateIndex
CREATE INDEX "_LabelToLabelFilter_B_index" ON "_LabelToLabelFilter"("B");

-- CreateIndex
CREATE INDEX "_StationToStatusReason_B_index" ON "_StationToStatusReason"("B");

-- CreateIndex
CREATE INDEX "_StatusReasonToWorkcenter_B_index" ON "_StatusReasonToWorkcenter"("B");

-- AddForeignKey
ALTER TABLE "AgentDefinition" ADD CONSTRAINT "AgentDefinition_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentTrigger" ADD CONSTRAINT "AgentTrigger_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentSession" ADD CONSTRAINT "AgentSession_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentSession" ADD CONSTRAINT "AgentSession_parentSessionId_fkey" FOREIGN KEY ("parentSessionId") REFERENCES "AgentSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentEvent" ADD CONSTRAINT "AgentEvent_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AgentSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentInput" ADD CONSTRAINT "AgentInput_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AgentSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentMessage" ADD CONSTRAINT "AgentMessage_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AgentSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentPermissionRequest" ADD CONSTRAINT "AgentPermissionRequest_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AgentSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentPermissionRule" ADD CONSTRAINT "AgentPermissionRule_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiToken" ADD CONSTRAINT "ApiToken_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiToken" ADD CONSTRAINT "ApiToken_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiToken" ADD CONSTRAINT "ApiToken_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationActionRun" ADD CONSTRAINT "AutomationActionRun_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AutomationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationCooldown" ADD CONSTRAINT "AutomationCooldown_automationId_fkey" FOREIGN KEY ("automationId") REFERENCES "Automation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationRunMatch" ADD CONSTRAINT "AutomationRunMatch_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AutomationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Automation" ADD CONSTRAINT "Automation_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BucketAccess" ADD CONSTRAINT "BucketAccess_bucketId_fkey" FOREIGN KEY ("bucketId") REFERENCES "Bucket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BucketAccess" ADD CONSTRAINT "BucketAccess_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Bucket" ADD CONSTRAINT "Bucket_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Bucket" ADD CONSTRAINT "Bucket_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Bucket" ADD CONSTRAINT "Bucket_workcenterId_fkey" FOREIGN KEY ("workcenterId") REFERENCES "Workcenter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallDefinition" ADD CONSTRAINT "CallDefinition_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Call" ADD CONSTRAINT "Call_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Call" ADD CONSTRAINT "Call_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "Station"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Call" ADD CONSTRAINT "Call_definitionId_fkey" FOREIGN KEY ("definitionId") REFERENCES "CallDefinition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Call" ADD CONSTRAINT "Call_workcenterId_fkey" FOREIGN KEY ("workcenterId") REFERENCES "Workcenter"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Call" ADD CONSTRAINT "Call_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Call" ADD CONSTRAINT "Call_jobVersionId_fkey" FOREIGN KEY ("jobVersionId") REFERENCES "JobVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Call" ADD CONSTRAINT "Call_stationVersionId_fkey" FOREIGN KEY ("stationVersionId") REFERENCES "StationVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Call" ADD CONSTRAINT "Call_toolId_fkey" FOREIGN KEY ("toolId") REFERENCES "Tool"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Call" ADD CONSTRAINT "Call_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Call" ADD CONSTRAINT "Call_openedByEmployeeId_fkey" FOREIGN KEY ("openedByEmployeeId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Call" ADD CONSTRAINT "Call_closedByEmployeeId_fkey" FOREIGN KEY ("closedByEmployeeId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Call" ADD CONSTRAINT "Call_shiftInstanceId_fkey" FOREIGN KEY ("shiftInstanceId") REFERENCES "ShiftInstance"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Cycle" ADD CONSTRAINT "Cycle_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Cycle" ADD CONSTRAINT "Cycle_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "Station"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Cycle" ADD CONSTRAINT "Cycle_workcenterId_fkey" FOREIGN KEY ("workcenterId") REFERENCES "Workcenter"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Cycle" ADD CONSTRAINT "Cycle_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Cycle" ADD CONSTRAINT "Cycle_shiftInstanceId_fkey" FOREIGN KEY ("shiftInstanceId") REFERENCES "ShiftInstance"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Cycle" ADD CONSTRAINT "Cycle_stationVersionId_fkey" FOREIGN KEY ("stationVersionId") REFERENCES "StationVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Cycle" ADD CONSTRAINT "Cycle_jobVersionId_fkey" FOREIGN KEY ("jobVersionId") REFERENCES "JobVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Cycle" ADD CONSTRAINT "Cycle_modeId_fkey" FOREIGN KEY ("modeId") REFERENCES "ProductionMode"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Cycle" ADD CONSTRAINT "Cycle_amendmentId_fkey" FOREIGN KEY ("amendmentId") REFERENCES "JobHistoryAmendment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Dashboard" ADD CONSTRAINT "Dashboard_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Datasource" ADD CONSTRAINT "Datasource_gatewayId_fkey" FOREIGN KEY ("gatewayId") REFERENCES "Gateway"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Datasource" ADD CONSTRAINT "Datasource_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PointGroup" ADD CONSTRAINT "PointGroup_datasourceId_fkey" FOREIGN KEY ("datasourceId") REFERENCES "Datasource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PointValue" ADD CONSTRAINT "PointValue_pointId_fkey" FOREIGN KEY ("pointId") REFERENCES "Point"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Point" ADD CONSTRAINT "Point_datasourceId_fkey" FOREIGN KEY ("datasourceId") REFERENCES "Datasource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Point" ADD CONSTRAINT "Point_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "PointGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DisplayRefreshToken" ADD CONSTRAINT "DisplayRefreshToken_displayId_fkey" FOREIGN KEY ("displayId") REFERENCES "Display"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Display" ADD CONSTRAINT "Display_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Display" ADD CONSTRAINT "Display_dashboardId_fkey" FOREIGN KEY ("dashboardId") REFERENCES "Dashboard"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Display" ADD CONSTRAINT "Display_workcenterId_fkey" FOREIGN KEY ("workcenterId") REFERENCES "Workcenter"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Display" ADD CONSTRAINT "Display_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "Station"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentLink" ADD CONSTRAINT "DocumentLink_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_currentFileId_fkey" FOREIGN KEY ("currentFileId") REFERENCES "DocumentFile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentFile" ADD CONSTRAINT "DocumentFile_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentFile" ADD CONSTRAINT "DocumentFile_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeRole" ADD CONSTRAINT "EmployeeRole_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeSiteAccess" ADD CONSTRAINT "EmployeeSiteAccess_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeSiteAccess" ADD CONSTRAINT "EmployeeSiteAccess_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeSiteAccess" ADD CONSTRAINT "EmployeeSiteAccess_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "EmployeeRole"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeVersion" ADD CONSTRAINT "EmployeeVersion_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "EmployeeVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommandQueue" ADD CONSTRAINT "CommandQueue_gatewayId_fkey" FOREIGN KEY ("gatewayId") REFERENCES "Gateway"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GatewayToken" ADD CONSTRAINT "GatewayToken_gatewayId_fkey" FOREIGN KEY ("gatewayId") REFERENCES "Gateway"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Gateway" ADD CONSTRAINT "Gateway_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GraphChangeset" ADD CONSTRAINT "GraphChangeset_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GraphChangeset" ADD CONSTRAINT "GraphChangeset_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AgentSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GraphEdge" ADD CONSTRAINT "GraphEdge_fromPropertyId_fkey" FOREIGN KEY ("fromPropertyId") REFERENCES "GraphProperty"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GraphEdge" ADD CONSTRAINT "GraphEdge_toPropertyId_fkey" FOREIGN KEY ("toPropertyId") REFERENCES "GraphProperty"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GraphHook" ADD CONSTRAINT "GraphHook_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GraphNodeTypeFacet" ADD CONSTRAINT "GraphNodeTypeFacet_typeId_fkey" FOREIGN KEY ("typeId") REFERENCES "GraphNodeType"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GraphNodeTypeField" ADD CONSTRAINT "GraphNodeTypeField_typeId_fkey" FOREIGN KEY ("typeId") REFERENCES "GraphNodeType"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GraphNodeTypeInput" ADD CONSTRAINT "GraphNodeTypeInput_typeId_fkey" FOREIGN KEY ("typeId") REFERENCES "GraphNodeType"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GraphNodeType" ADD CONSTRAINT "GraphNodeType_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GraphNode" ADD CONSTRAINT "GraphNode_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GraphProperty" ADD CONSTRAINT "GraphProperty_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "GraphNode"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationRun" ADD CONSTRAINT "IntegrationRun_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "Integration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationTrigger" ADD CONSTRAINT "IntegrationTrigger_hookId_fkey" FOREIGN KEY ("hookId") REFERENCES "GraphHook"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationTrigger" ADD CONSTRAINT "IntegrationTrigger_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "Integration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationTrigger" ADD CONSTRAINT "IntegrationTrigger_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Integration" ADD CONSTRAINT "Integration_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "Cycle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_amendmentId_fkey" FOREIGN KEY ("amendmentId") REFERENCES "JobHistoryAmendment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "Station"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_workcenterId_fkey" FOREIGN KEY ("workcenterId") REFERENCES "Workcenter"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_toolId_fkey" FOREIGN KEY ("toolId") REFERENCES "Tool"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_shiftInstanceId_fkey" FOREIGN KEY ("shiftInstanceId") REFERENCES "ShiftInstance"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_jobProductVersionId_fkey" FOREIGN KEY ("jobProductVersionId") REFERENCES "JobProductVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_productVersionId_fkey" FOREIGN KEY ("productVersionId") REFERENCES "ProductVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_toolVersionId_fkey" FOREIGN KEY ("toolVersionId") REFERENCES "ToolVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_toolCavityVersionId_fkey" FOREIGN KEY ("toolCavityVersionId") REFERENCES "ToolCavityVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_modeId_fkey" FOREIGN KEY ("modeId") REFERENCES "ProductionMode"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemDispositionLog" ADD CONSTRAINT "ItemDispositionLog_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemDispositionLog" ADD CONSTRAINT "ItemDispositionLog_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "Station"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemDispositionLog" ADD CONSTRAINT "ItemDispositionLog_workcenterId_fkey" FOREIGN KEY ("workcenterId") REFERENCES "Workcenter"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemDispositionLog" ADD CONSTRAINT "ItemDispositionLog_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "Cycle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemDispositionLog" ADD CONSTRAINT "ItemDispositionLog_shiftInstanceId_fkey" FOREIGN KEY ("shiftInstanceId") REFERENCES "ShiftInstance"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemDispositionLog" ADD CONSTRAINT "ItemDispositionLog_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemDispositionLog" ADD CONSTRAINT "ItemDispositionLog_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemDispositionLog" ADD CONSTRAINT "ItemDispositionLog_toolId_fkey" FOREIGN KEY ("toolId") REFERENCES "Tool"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemDispositionLog" ADD CONSTRAINT "ItemDispositionLog_itemDispositionId_fkey" FOREIGN KEY ("itemDispositionId") REFERENCES "ItemDisposition"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemDispositionLog" ADD CONSTRAINT "ItemDispositionLog_dispositionReasonId_fkey" FOREIGN KEY ("dispositionReasonId") REFERENCES "ItemDispositionReason"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemDispositionLog" ADD CONSTRAINT "ItemDispositionLog_stationVersionId_fkey" FOREIGN KEY ("stationVersionId") REFERENCES "StationVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemDispositionLog" ADD CONSTRAINT "ItemDispositionLog_jobProductVersionId_fkey" FOREIGN KEY ("jobProductVersionId") REFERENCES "JobProductVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemDispositionLog" ADD CONSTRAINT "ItemDispositionLog_productVersionId_fkey" FOREIGN KEY ("productVersionId") REFERENCES "ProductVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemDispositionLog" ADD CONSTRAINT "ItemDispositionLog_toolVersionId_fkey" FOREIGN KEY ("toolVersionId") REFERENCES "ToolVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemDispositionLog" ADD CONSTRAINT "ItemDispositionLog_toolCavityVersionId_fkey" FOREIGN KEY ("toolCavityVersionId") REFERENCES "ToolCavityVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemDispositionLog" ADD CONSTRAINT "ItemDispositionLog_modeId_fkey" FOREIGN KEY ("modeId") REFERENCES "ProductionMode"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemDispositionReason" ADD CONSTRAINT "ItemDispositionReason_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemDisposition" ADD CONSTRAINT "ItemDisposition_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobProductVersion" ADD CONSTRAINT "JobProductVersion_jobProductId_fkey" FOREIGN KEY ("jobProductId") REFERENCES "JobProduct"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobProduct" ADD CONSTRAINT "JobProduct_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobProduct" ADD CONSTRAINT "JobProduct_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobProduct" ADD CONSTRAINT "JobProduct_toolId_fkey" FOREIGN KEY ("toolId") REFERENCES "Tool"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobProduct" ADD CONSTRAINT "JobProduct_toolCavityId_fkey" FOREIGN KEY ("toolCavityId") REFERENCES "ToolCavity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobProduct" ADD CONSTRAINT "JobProduct_currentVersionId_fkey" FOREIGN KEY ("currentVersionId") REFERENCES "JobProductVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobTool" ADD CONSTRAINT "JobTool_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobTool" ADD CONSTRAINT "JobTool_toolId_fkey" FOREIGN KEY ("toolId") REFERENCES "Tool"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobVersion" ADD CONSTRAINT "JobVersion_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "StationProfile"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobVersion" ADD CONSTRAINT "JobVersion_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_currentVersionId_fkey" FOREIGN KEY ("currentVersionId") REFERENCES "JobVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LabelFilter" ADD CONSTRAINT "LabelFilter_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "Station"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Label" ADD CONSTRAINT "Label_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaterialLedgerEntry" ADD CONSTRAINT "MaterialLedgerEntry_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaterialLedgerEntry" ADD CONSTRAINT "MaterialLedgerEntry_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "Material"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaterialLedgerEntry" ADD CONSTRAINT "MaterialLedgerEntry_shiftInstanceId_fkey" FOREIGN KEY ("shiftInstanceId") REFERENCES "ShiftInstance"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaterialLedgerEntry" ADD CONSTRAINT "MaterialLedgerEntry_performedByUserId_fkey" FOREIGN KEY ("performedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaterialShiftUsage" ADD CONSTRAINT "MaterialShiftUsage_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaterialShiftUsage" ADD CONSTRAINT "MaterialShiftUsage_shiftInstanceId_fkey" FOREIGN KEY ("shiftInstanceId") REFERENCES "ShiftInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaterialShiftUsage" ADD CONSTRAINT "MaterialShiftUsage_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "Station"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaterialShiftUsage" ADD CONSTRAINT "MaterialShiftUsage_workcenterId_fkey" FOREIGN KEY ("workcenterId") REFERENCES "Workcenter"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaterialShiftUsage" ADD CONSTRAINT "MaterialShiftUsage_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaterialShiftUsage" ADD CONSTRAINT "MaterialShiftUsage_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaterialShiftUsage" ADD CONSTRAINT "MaterialShiftUsage_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "Material"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaterialShiftUsage" ADD CONSTRAINT "MaterialShiftUsage_flushedLedgerEntryId_fkey" FOREIGN KEY ("flushedLedgerEntryId") REFERENCES "MaterialLedgerEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaterialVersion" ADD CONSTRAINT "MaterialVersion_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "Material"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Material" ADD CONSTRAINT "Material_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Material" ADD CONSTRAINT "Material_currentVersionId_fkey" FOREIGN KEY ("currentVersionId") REFERENCES "MaterialVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MetricBucketLog" ADD CONSTRAINT "MetricBucketLog_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MetricBucket" ADD CONSTRAINT "MetricBucket_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationDelivery" ADD CONSTRAINT "NotificationDelivery_notificationId_fkey" FOREIGN KEY ("notificationId") REFERENCES "Notification"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationDelivery" ADD CONSTRAINT "NotificationDelivery_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationGroup" ADD CONSTRAINT "NotificationGroup_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "NotificationGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ObjectInstance" ADD CONSTRAINT "ObjectInstance_schemaId_fkey" FOREIGN KEY ("schemaId") REFERENCES "ObjectSchema"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ObjectInstance" ADD CONSTRAINT "ObjectInstance_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ObjectSchemaField" ADD CONSTRAINT "ObjectSchemaField_schemaId_fkey" FOREIGN KEY ("schemaId") REFERENCES "ObjectSchema"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ObjectSchemaField" ADD CONSTRAINT "ObjectSchemaField_refSchemaId_fkey" FOREIGN KEY ("refSchemaId") REFERENCES "ObjectSchema"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ObjectSchema" ADD CONSTRAINT "ObjectSchema_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ObjectSchema" ADD CONSTRAINT "ObjectSchema_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderConsumption" ADD CONSTRAINT "OrderConsumption_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderConsumption" ADD CONSTRAINT "OrderConsumption_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderConsumption" ADD CONSTRAINT "OrderConsumption_orderLineItemId_fkey" FOREIGN KEY ("orderLineItemId") REFERENCES "OrderLineItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderConsumption" ADD CONSTRAINT "OrderConsumption_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderConsumption" ADD CONSTRAINT "OrderConsumption_shiftInstanceId_fkey" FOREIGN KEY ("shiftInstanceId") REFERENCES "ShiftInstance"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderLineItem" ADD CONSTRAINT "OrderLineItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderLineItem" ADD CONSTRAINT "OrderLineItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OverheadPageLog" ADD CONSTRAINT "OverheadPageLog_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OverheadPageLog" ADD CONSTRAINT "OverheadPageLog_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "OverheadPage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OverheadPage" ADD CONSTRAINT "OverheadPage_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductMaterialAltGroup" ADD CONSTRAINT "ProductMaterialAltGroup_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductMaterialAltGroup" ADD CONSTRAINT "ProductMaterialAltGroup_activeProductMaterialId_fkey" FOREIGN KEY ("activeProductMaterialId") REFERENCES "ProductMaterial"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductMaterialVersion" ADD CONSTRAINT "ProductMaterialVersion_productMaterialId_fkey" FOREIGN KEY ("productMaterialId") REFERENCES "ProductMaterial"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductMaterialVersion" ADD CONSTRAINT "ProductMaterialVersion_materialVersionId_fkey" FOREIGN KEY ("materialVersionId") REFERENCES "MaterialVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductMaterialVersion" ADD CONSTRAINT "ProductMaterialVersion_productVersionId_fkey" FOREIGN KEY ("productVersionId") REFERENCES "ProductVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductMaterial" ADD CONSTRAINT "ProductMaterial_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductMaterial" ADD CONSTRAINT "ProductMaterial_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "Material"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductMaterial" ADD CONSTRAINT "ProductMaterial_altGroupId_fkey" FOREIGN KEY ("altGroupId") REFERENCES "ProductMaterialAltGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductMaterial" ADD CONSTRAINT "ProductMaterial_currentVersionId_fkey" FOREIGN KEY ("currentVersionId") REFERENCES "ProductMaterialVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductPicture" ADD CONSTRAINT "ProductPicture_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductStockAdjustment" ADD CONSTRAINT "ProductStockAdjustment_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductStockAdjustment" ADD CONSTRAINT "ProductStockAdjustment_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductStockAdjustment" ADD CONSTRAINT "ProductStockAdjustment_shiftInstanceId_fkey" FOREIGN KEY ("shiftInstanceId") REFERENCES "ShiftInstance"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductStockAdjustment" ADD CONSTRAINT "ProductStockAdjustment_performedByUserId_fkey" FOREIGN KEY ("performedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductStock" ADD CONSTRAINT "ProductStock_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductStock" ADD CONSTRAINT "ProductStock_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductVersion" ADD CONSTRAINT "ProductVersion_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_currentVersionId_fkey" FOREIGN KEY ("currentVersionId") REFERENCES "ProductVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductionMode" ADD CONSTRAINT "ProductionMode_itemDispositionId_fkey" FOREIGN KEY ("itemDispositionId") REFERENCES "ItemDisposition"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductionMode" ADD CONSTRAINT "ProductionMode_dispositionReasonId_fkey" FOREIGN KEY ("dispositionReasonId") REFERENCES "ItemDispositionReason"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductionMode" ADD CONSTRAINT "ProductionMode_statusReasonId_fkey" FOREIGN KEY ("statusReasonId") REFERENCES "StatusReason"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductionMode" ADD CONSTRAINT "ProductionMode_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReportDeck" ADD CONSTRAINT "ReportDeck_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReportDeck" ADD CONSTRAINT "ReportDeck_workcenterId_fkey" FOREIGN KEY ("workcenterId") REFERENCES "Workcenter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReportDeckEdition" ADD CONSTRAINT "ReportDeckEdition_deckId_fkey" FOREIGN KEY ("deckId") REFERENCES "ReportDeck"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReportDeckLinkEdition" ADD CONSTRAINT "ReportDeckLinkEdition_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES "ReportDeckLink"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReportDeckLinkEdition" ADD CONSTRAINT "ReportDeckLinkEdition_editionId_fkey" FOREIGN KEY ("editionId") REFERENCES "ReportDeckEdition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SavedView" ADD CONSTRAINT "SavedView_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SavedView" ADD CONSTRAINT "SavedView_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftAmendment" ADD CONSTRAINT "ShiftAmendment_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftAmendment" ADD CONSTRAINT "ShiftAmendment_workCenterId_fkey" FOREIGN KEY ("workCenterId") REFERENCES "Workcenter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftAmendment" ADD CONSTRAINT "ShiftAmendment_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "ShiftAssignment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftAmendment" ADD CONSTRAINT "ShiftAmendment_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftAssignment" ADD CONSTRAINT "ShiftAssignment_patternId_fkey" FOREIGN KEY ("patternId") REFERENCES "ShiftPattern"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftAssignment" ADD CONSTRAINT "ShiftAssignment_rotationStartDefinitionId_fkey" FOREIGN KEY ("rotationStartDefinitionId") REFERENCES "ShiftDefinition"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftAssignment" ADD CONSTRAINT "ShiftAssignment_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftAssignment" ADD CONSTRAINT "ShiftAssignment_workCenterId_fkey" FOREIGN KEY ("workCenterId") REFERENCES "Workcenter"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftComment" ADD CONSTRAINT "ShiftComment_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftComment" ADD CONSTRAINT "ShiftComment_shiftInstanceId_fkey" FOREIGN KEY ("shiftInstanceId") REFERENCES "ShiftInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftComment" ADD CONSTRAINT "ShiftComment_workcenterId_fkey" FOREIGN KEY ("workcenterId") REFERENCES "Workcenter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftComment" ADD CONSTRAINT "ShiftComment_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "Station"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftComment" ADD CONSTRAINT "ShiftComment_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftComment" ADD CONSTRAINT "ShiftComment_createdByEmployeeId_fkey" FOREIGN KEY ("createdByEmployeeId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftDefinition" ADD CONSTRAINT "ShiftDefinition_patternId_fkey" FOREIGN KEY ("patternId") REFERENCES "ShiftPattern"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftInstance" ADD CONSTRAINT "ShiftInstance_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "ShiftAssignment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftInstance" ADD CONSTRAINT "ShiftInstance_definitionId_fkey" FOREIGN KEY ("definitionId") REFERENCES "ShiftDefinition"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftInstance" ADD CONSTRAINT "ShiftInstance_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftInstance" ADD CONSTRAINT "ShiftInstance_workCenterId_fkey" FOREIGN KEY ("workCenterId") REFERENCES "Workcenter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftOverride" ADD CONSTRAINT "ShiftOverride_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftOverride" ADD CONSTRAINT "ShiftOverride_workCenterId_fkey" FOREIGN KEY ("workCenterId") REFERENCES "Workcenter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftPattern" ADD CONSTRAINT "ShiftPattern_clonedFromId_fkey" FOREIGN KEY ("clonedFromId") REFERENCES "ShiftPattern"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftPattern" ADD CONSTRAINT "ShiftPattern_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftSignoff" ADD CONSTRAINT "ShiftSignoff_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftSignoff" ADD CONSTRAINT "ShiftSignoff_shiftInstanceId_fkey" FOREIGN KEY ("shiftInstanceId") REFERENCES "ShiftInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftSignoff" ADD CONSTRAINT "ShiftSignoff_workcenterId_fkey" FOREIGN KEY ("workcenterId") REFERENCES "Workcenter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftSignoff" ADD CONSTRAINT "ShiftSignoff_postedById_fkey" FOREIGN KEY ("postedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftSignoff" ADD CONSTRAINT "ShiftSignoff_reopenedById_fkey" FOREIGN KEY ("reopenedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SiteAndonRule" ADD CONSTRAINT "SiteAndonRule_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Site" ADD CONSTRAINT "Site_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SmsConsentEvent" ADD CONSTRAINT "SmsConsentEvent_consentId_fkey" FOREIGN KEY ("consentId") REFERENCES "SmsConsent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SmsConsentEvent" ADD CONSTRAINT "SmsConsentEvent_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SmsConsent" ADD CONSTRAINT "SmsConsent_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobHistoryAmendment" ADD CONSTRAINT "JobHistoryAmendment_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobHistoryAmendment" ADD CONSTRAINT "JobHistoryAmendment_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "Station"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobHistoryAmendment" ADD CONSTRAINT "JobHistoryAmendment_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationDatasource" ADD CONSTRAINT "StationDatasource_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "Station"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationDatasource" ADD CONSTRAINT "StationDatasource_datasourceId_fkey" FOREIGN KEY ("datasourceId") REFERENCES "Datasource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationEventExecution" ADD CONSTRAINT "StationEventExecution_stationEventId_fkey" FOREIGN KEY ("stationEventId") REFERENCES "StationEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationEvent" ADD CONSTRAINT "StationEvent_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "Station"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationJobLog" ADD CONSTRAINT "StationJobLog_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "Station"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationJobLog" ADD CONSTRAINT "StationJobLog_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationJobLog" ADD CONSTRAINT "StationJobLog_workcenterId_fkey" FOREIGN KEY ("workcenterId") REFERENCES "Workcenter"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationJobLog" ADD CONSTRAINT "StationJobLog_shiftInstanceId_fkey" FOREIGN KEY ("shiftInstanceId") REFERENCES "ShiftInstance"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationJobLog" ADD CONSTRAINT "StationJobLog_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationJobLog" ADD CONSTRAINT "StationJobLog_amendmentId_fkey" FOREIGN KEY ("amendmentId") REFERENCES "JobHistoryAmendment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationLogonSession" ADD CONSTRAINT "StationLogonSession_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationLogonSession" ADD CONSTRAINT "StationLogonSession_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "EmployeeVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationLogonSession" ADD CONSTRAINT "StationLogonSession_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "Station"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationLogonSession" ADD CONSTRAINT "StationLogonSession_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationLogonSession" ADD CONSTRAINT "StationLogonSession_workcenterId_fkey" FOREIGN KEY ("workcenterId") REFERENCES "Workcenter"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationLogonSession" ADD CONSTRAINT "StationLogonSession_displayId_fkey" FOREIGN KEY ("displayId") REFERENCES "Display"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationLogonSession" ADD CONSTRAINT "StationLogonSession_shiftInstanceId_fkey" FOREIGN KEY ("shiftInstanceId") REFERENCES "ShiftInstance"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationModeLog" ADD CONSTRAINT "StationModeLog_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationModeLog" ADD CONSTRAINT "StationModeLog_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "Station"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationModeLog" ADD CONSTRAINT "StationModeLog_modeId_fkey" FOREIGN KEY ("modeId") REFERENCES "ProductionMode"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationModeLog" ADD CONSTRAINT "StationModeLog_workcenterId_fkey" FOREIGN KEY ("workcenterId") REFERENCES "Workcenter"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationModeLog" ADD CONSTRAINT "StationModeLog_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationModeLog" ADD CONSTRAINT "StationModeLog_jobVersionId_fkey" FOREIGN KEY ("jobVersionId") REFERENCES "JobVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationModeLog" ADD CONSTRAINT "StationModeLog_stationVersionId_fkey" FOREIGN KEY ("stationVersionId") REFERENCES "StationVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationModeLog" ADD CONSTRAINT "StationModeLog_toolId_fkey" FOREIGN KEY ("toolId") REFERENCES "Tool"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationModeLog" ADD CONSTRAINT "StationModeLog_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationModeLog" ADD CONSTRAINT "StationModeLog_shiftInstanceId_fkey" FOREIGN KEY ("shiftInstanceId") REFERENCES "ShiftInstance"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationModeLog" ADD CONSTRAINT "StationModeLog_startedByEmployeeId_fkey" FOREIGN KEY ("startedByEmployeeId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationModeLog" ADD CONSTRAINT "StationModeLog_endedByEmployeeId_fkey" FOREIGN KEY ("endedByEmployeeId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationProfileVariation" ADD CONSTRAINT "StationProfileVariation_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "StationProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationProfile" ADD CONSTRAINT "StationProfile_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationStateLog" ADD CONSTRAINT "StationStateLog_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "Station"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationStateLog" ADD CONSTRAINT "StationStateLog_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationStateLog" ADD CONSTRAINT "StationStateLog_workcenterId_fkey" FOREIGN KEY ("workcenterId") REFERENCES "Workcenter"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationStateLog" ADD CONSTRAINT "StationStateLog_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationStateLog" ADD CONSTRAINT "StationStateLog_shiftInstanceId_fkey" FOREIGN KEY ("shiftInstanceId") REFERENCES "ShiftInstance"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationStateLog" ADD CONSTRAINT "StationStateLog_stationVersionId_fkey" FOREIGN KEY ("stationVersionId") REFERENCES "StationVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationStateLog" ADD CONSTRAINT "StationStateLog_jobVersionId_fkey" FOREIGN KEY ("jobVersionId") REFERENCES "JobVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationStateLog" ADD CONSTRAINT "StationStateLog_statusReasonId_fkey" FOREIGN KEY ("statusReasonId") REFERENCES "StatusReason"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationStateLog" ADD CONSTRAINT "StationStateLog_modeId_fkey" FOREIGN KEY ("modeId") REFERENCES "ProductionMode"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationVersion" ADD CONSTRAINT "StationVersion_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "StationProfile"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationVersion" ADD CONSTRAINT "StationVersion_variationId_fkey" FOREIGN KEY ("variationId") REFERENCES "StationProfileVariation"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StationVersion" ADD CONSTRAINT "StationVersion_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "Station"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Station" ADD CONSTRAINT "Station_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Station" ADD CONSTRAINT "Station_workcenterId_fkey" FOREIGN KEY ("workcenterId") REFERENCES "Workcenter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Station" ADD CONSTRAINT "Station_currentJobId_fkey" FOREIGN KEY ("currentJobId") REFERENCES "Job"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Station" ADD CONSTRAINT "Station_currentVersionId_fkey" FOREIGN KEY ("currentVersionId") REFERENCES "StationVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StatusCategory" ADD CONSTRAINT "StatusCategory_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StatusReason" ADD CONSTRAINT "StatusReason_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StatusReason" ADD CONSTRAINT "StatusReason_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "StatusCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockBalance" ADD CONSTRAINT "StockBalance_stockItemId_fkey" FOREIGN KEY ("stockItemId") REFERENCES "StockItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockItem" ADD CONSTRAINT "StockItem_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_stockItemId_fkey" FOREIGN KEY ("stockItemId") REFERENCES "StockItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_reversesMovementId_fkey" FOREIGN KEY ("reversesMovementId") REFERENCES "StockMovement"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "Station"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_shiftInstanceId_fkey" FOREIGN KEY ("shiftInstanceId") REFERENCES "ShiftInstance"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_performedByUserId_fkey" FOREIGN KEY ("performedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ToolCavityVersion" ADD CONSTRAINT "ToolCavityVersion_toolCavityId_fkey" FOREIGN KEY ("toolCavityId") REFERENCES "ToolCavity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ToolCavity" ADD CONSTRAINT "ToolCavity_toolId_fkey" FOREIGN KEY ("toolId") REFERENCES "Tool"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ToolCavity" ADD CONSTRAINT "ToolCavity_currentVersionId_fkey" FOREIGN KEY ("currentVersionId") REFERENCES "ToolCavityVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ToolVersion" ADD CONSTRAINT "ToolVersion_toolId_fkey" FOREIGN KEY ("toolId") REFERENCES "Tool"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tool" ADD CONSTRAINT "Tool_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tool" ADD CONSTRAINT "Tool_currentVersionId_fkey" FOREIGN KEY ("currentVersionId") REFERENCES "ToolVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Workcenter" ADD CONSTRAINT "Workcenter_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Workcenter" ADD CONSTRAINT "Workcenter_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Workcenter"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_CallDefinitionOpenRoles" ADD CONSTRAINT "_CallDefinitionOpenRoles_A_fkey" FOREIGN KEY ("A") REFERENCES "CallDefinition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_CallDefinitionOpenRoles" ADD CONSTRAINT "_CallDefinitionOpenRoles_B_fkey" FOREIGN KEY ("B") REFERENCES "EmployeeRole"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_CallDefinitionAnswerRoles" ADD CONSTRAINT "_CallDefinitionAnswerRoles_A_fkey" FOREIGN KEY ("A") REFERENCES "CallDefinition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_CallDefinitionAnswerRoles" ADD CONSTRAINT "_CallDefinitionAnswerRoles_B_fkey" FOREIGN KEY ("B") REFERENCES "EmployeeRole"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_CycleToToolVersion" ADD CONSTRAINT "_CycleToToolVersion_A_fkey" FOREIGN KEY ("A") REFERENCES "Cycle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_CycleToToolVersion" ADD CONSTRAINT "_CycleToToolVersion_B_fkey" FOREIGN KEY ("B") REFERENCES "ToolVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_CycleToJobTool" ADD CONSTRAINT "_CycleToJobTool_A_fkey" FOREIGN KEY ("A") REFERENCES "Cycle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_CycleToJobTool" ADD CONSTRAINT "_CycleToJobTool_B_fkey" FOREIGN KEY ("B") REFERENCES "JobTool"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_ProductionModeRoles" ADD CONSTRAINT "_ProductionModeRoles_A_fkey" FOREIGN KEY ("A") REFERENCES "EmployeeRole"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_ProductionModeRoles" ADD CONSTRAINT "_ProductionModeRoles_B_fkey" FOREIGN KEY ("B") REFERENCES "ProductionMode"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_NotificationGroupMembers" ADD CONSTRAINT "_NotificationGroupMembers_A_fkey" FOREIGN KEY ("A") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_NotificationGroupMembers" ADD CONSTRAINT "_NotificationGroupMembers_B_fkey" FOREIGN KEY ("B") REFERENCES "NotificationGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_InventoryItemToProductMaterialVersion" ADD CONSTRAINT "_InventoryItemToProductMaterialVersion_A_fkey" FOREIGN KEY ("A") REFERENCES "InventoryItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_InventoryItemToProductMaterialVersion" ADD CONSTRAINT "_InventoryItemToProductMaterialVersion_B_fkey" FOREIGN KEY ("B") REFERENCES "ProductMaterialVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_ItemDispositionLogToProductMaterialVersion" ADD CONSTRAINT "_ItemDispositionLogToProductMaterialVersion_A_fkey" FOREIGN KEY ("A") REFERENCES "ItemDispositionLog"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_ItemDispositionLogToProductMaterialVersion" ADD CONSTRAINT "_ItemDispositionLogToProductMaterialVersion_B_fkey" FOREIGN KEY ("B") REFERENCES "ProductMaterialVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_ItemDispositionReasonToLabel" ADD CONSTRAINT "_ItemDispositionReasonToLabel_A_fkey" FOREIGN KEY ("A") REFERENCES "ItemDispositionReason"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_ItemDispositionReasonToLabel" ADD CONSTRAINT "_ItemDispositionReasonToLabel_B_fkey" FOREIGN KEY ("B") REFERENCES "Label"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_DispositionReasonDispositions" ADD CONSTRAINT "_DispositionReasonDispositions_A_fkey" FOREIGN KEY ("A") REFERENCES "ItemDisposition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_DispositionReasonDispositions" ADD CONSTRAINT "_DispositionReasonDispositions_B_fkey" FOREIGN KEY ("B") REFERENCES "ItemDispositionReason"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_JobToLabel" ADD CONSTRAINT "_JobToLabel_A_fkey" FOREIGN KEY ("A") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_JobToLabel" ADD CONSTRAINT "_JobToLabel_B_fkey" FOREIGN KEY ("B") REFERENCES "Label"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_LabelToTool" ADD CONSTRAINT "_LabelToTool_A_fkey" FOREIGN KEY ("A") REFERENCES "Label"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_LabelToTool" ADD CONSTRAINT "_LabelToTool_B_fkey" FOREIGN KEY ("B") REFERENCES "Tool"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_LabelToProduct" ADD CONSTRAINT "_LabelToProduct_A_fkey" FOREIGN KEY ("A") REFERENCES "Label"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_LabelToProduct" ADD CONSTRAINT "_LabelToProduct_B_fkey" FOREIGN KEY ("B") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_LabelToMaterial" ADD CONSTRAINT "_LabelToMaterial_A_fkey" FOREIGN KEY ("A") REFERENCES "Label"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_LabelToMaterial" ADD CONSTRAINT "_LabelToMaterial_B_fkey" FOREIGN KEY ("B") REFERENCES "Material"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_LabelToStation" ADD CONSTRAINT "_LabelToStation_A_fkey" FOREIGN KEY ("A") REFERENCES "Label"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_LabelToStation" ADD CONSTRAINT "_LabelToStation_B_fkey" FOREIGN KEY ("B") REFERENCES "Station"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_LabelToStatusReason" ADD CONSTRAINT "_LabelToStatusReason_A_fkey" FOREIGN KEY ("A") REFERENCES "Label"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_LabelToStatusReason" ADD CONSTRAINT "_LabelToStatusReason_B_fkey" FOREIGN KEY ("B") REFERENCES "StatusReason"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_LabelToLabelFilter" ADD CONSTRAINT "_LabelToLabelFilter_A_fkey" FOREIGN KEY ("A") REFERENCES "Label"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_LabelToLabelFilter" ADD CONSTRAINT "_LabelToLabelFilter_B_fkey" FOREIGN KEY ("B") REFERENCES "LabelFilter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_StationToStatusReason" ADD CONSTRAINT "_StationToStatusReason_A_fkey" FOREIGN KEY ("A") REFERENCES "Station"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_StationToStatusReason" ADD CONSTRAINT "_StationToStatusReason_B_fkey" FOREIGN KEY ("B") REFERENCES "StatusReason"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_StatusReasonToWorkcenter" ADD CONSTRAINT "_StatusReasonToWorkcenter_A_fkey" FOREIGN KEY ("A") REFERENCES "StatusReason"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_StatusReasonToWorkcenter" ADD CONSTRAINT "_StatusReasonToWorkcenter_B_fkey" FOREIGN KEY ("B") REFERENCES "Workcenter"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ── Hand-written SQL (not expressible in the Prisma schema) ─────────────

-- Unit conversion for the stock book. Units with no gram factor (EA, ...) get
-- no factor, and stock_convert then leaves the number as it is.
CREATE FUNCTION stock_unit_grams(unit text) RETURNS numeric
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE unit
    WHEN 'G' THEN 1
    WHEN 'KG' THEN 1000
    WHEN 'MT' THEN 1000000
    WHEN 'OZ' THEN 28.349523125
    WHEN 'LB' THEN 453.59237
    WHEN 'TON' THEN 907184.74
  END::numeric
$$;

-- Convert q from one unit to another, rounded to 4 places (the book's
-- precision). Every total uses this, one movement at a time, so totals kept
-- up as we go and totals rebuilt from scratch always agree.
CREATE FUNCTION stock_convert(q numeric, from_unit text, to_unit text) RETURNS numeric
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE
    WHEN from_unit = to_unit OR stock_unit_grams(from_unit) IS NULL OR stock_unit_grams(to_unit) IS NULL THEN q
    ELSE ROUND(q * stock_unit_grams(from_unit) / stock_unit_grams(to_unit), 4)
  END
$$;

-- MetricBucket is updated on every tick. Page headroom (fillfactor 70) keeps
-- those updates HOT, and aggressive autovacuum keeps dead tuples down.
ALTER TABLE "MetricBucket" SET (
  fillfactor = 70,
  autovacuum_vacuum_scale_factor = 0.02,
  autovacuum_vacuum_cost_delay = 0
);

-- CHECK constraints
ALTER TABLE "Bucket" ADD CONSTRAINT "Bucket_kind_workcenter_check"
  CHECK (("kind" = 'WORKCENTER') = ("workcenterId" IS NOT NULL));
-- A movement always moves something.
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_quantity_not_zero"
  CHECK ("quantity" <> 0);
-- The parts always add up to the total.
ALTER TABLE "StockBalance" ADD CONSTRAINT "StockBalance_parts_add_up"
  CHECK ("onHand" = "produced" - "scrapped" - "consumed" + "adjusted" + "received" - "issued");

-- Partial unique indexes
CREATE UNIQUE INDEX "Bucket_one_plant_per_site" ON "Bucket" ("siteId") WHERE "kind" = 'PLANT';
CREATE UNIQUE INDEX "Call_stationId_definitionId_open_unique" ON "Call" ("stationId", "definitionId") WHERE "closedAt" IS NULL AND "deletedAt" IS NULL;
CREATE UNIQUE INDEX "ItemDisposition_siteId_system_unique" ON "ItemDisposition" ("siteId") WHERE "isSystem";
CREATE UNIQUE INDEX "StationModeLog_stationId_open_unique" ON "StationModeLog" ("stationId") WHERE "endTime" IS NULL;
CREATE UNIQUE INDEX "StationProfile_siteId_default_key" ON "StationProfile" ("siteId") WHERE "isDefault";
CREATE UNIQUE INDEX "StationStateLog_stationId_open_unique" ON "StationStateLog" ("stationId") WHERE "endTime" IS NULL AND "deletedAt" IS NULL;
$baseline$;
    RETURN;
  END IF;

  SELECT array_agg(n ORDER BY n) INTO missing FROM unnest(legacy) AS n WHERE n <> ALL (applied);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'v1_baseline: this database is missing % migration(s) from before the squash: %',
      cardinality(missing), array_to_string(missing, ', ')
      USING HINT = 'Run `prisma migrate resolve --rolled-back 20261016000000_v1_baseline`, deploy the last release before the squash (2748b90), then deploy again.';
  END IF;
END
$guard$;
