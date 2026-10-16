// Runs before `prisma migrate deploy` (see "prisma:migrate" in package.json).
//
// 20261016000000_v1_baseline squashes the migrations before it. On a database
// that has only some of those old migrations, the baseline can't apply: the
// last release before the squash (2748b90) has to be deployed first. The
// baseline itself refuses in that case, but by then Prisma has recorded it as
// a failed migration, which blocks every later deploy until someone runs
// `prisma migrate resolve`. Checking here, before Prisma starts, fails the
// same way without recording anything: deploy 2748b90, then deploy again.

import "dotenv/config";
import pg from "pg";

const BASELINE = "20261016000000_v1_baseline";

// The squashed migrations.
const LEGACY = [
  "20260115205313_init",
  "20260127230334_add_workspace_to_location",
  "20260130190044_invites",
  "20260211014709_add_station_models",
  "20260212185450_add_workcenters",
  "20260213143429_cycle_job_shift_models",
  "20260216225152_add_datasource_status",
  "20260217145238_station_site_relation",
  "20260217154557_point_value",
  "20260219214301_add_station_events",
  "20260220221728_part_materials_job_tools",
  "20260223224745_versioning_inventory_jobs_cycles",
  "20260224120656_material_product_m2m",
  "20260226222911_state_state_and_support_tables",
  "20260227165515_add_product_pictures",
  "20260227190325_add_cavity_count_and_quantity",
  "20260227193000_add_station_event_executions",
  "20260304191542_job_updates",
  "20260305162437_add_dashboard_and_display",
  "20260305171208_add_metric_buckets",
  "20260305213548_site_timezone_addition",
  "20260306122129_add_metric_bucket_path",
  "20260306182810_station_job_bucket",
  "20260309120000_add_shift_sort_order",
  "20260310155305_oee_building_blocks",
  "20260311180000_add_metric_bucket_shift_instance_id",
  "20260311200000_widen_oee_decimal_precision",
  "20260311210000_enforce_single_open_state_log",
  "20260312000000_metrics_overhaul",
  "20260312165035_add_workcenter_process_type",
  "20260313000000_goodcycles_generated_columns",
  "20260313174755_scrap_downtime_schema_additions",
  "20260316150827_add_station_blob_refs",
  "20260317000000_replace_rotation_start_shift_with_definition_fk",
  "20260319164929_add_display_workcenter_station",
  "20260320112737_add_workcenter_to_disposition_log",
  "20260320121500_inventory_relationships_no_delete",
  "20260320150821_add_current_job_to_metric_buckets",
  "20260324171925_use_timestamptz",
  "20260325000000_oee_zero_not_null",
  "20260326000000_metric_bucket_log_generated_columns",
  "20260326100000_add_product_material_blob",
  "20260326182530_product_material_blob",
  "20260331120423_add_job_blob_id_to_station_state_log",
  "20260331191248_add_employee_and_operator_logon",
  "20260402175132_production_orders",
  "20260403000000_employee_role_table",
  "20260410114621_add_starttime_indexes_for_rollup_queries",
  "20260412005102_display_auth",
  "20260416133205_add_shift_comment",
  "20260421020632_add_site_andon_rules",
  "20260426093908_add_material_ledger_alt_groups_shift_usage",
  "20260427155847_add_weight_unit_mt_ton",
  "20260427233455_rbac",
  "20260430141632_widen_product_blob_weight_cost_precision",
  "20260430160333_disposition_reason_m2m",
  "20260529182020_automations",
  "20260604120000_add_documents",
  "20260606000000_add_graph_models",
  "20260611120000_add_user_entities",
  "20260612120000_bind_graph_nodes_to_object_instances",
  "20260612130000_site_scope_graph_nodes",
  "20260613120000_object_schema_catalog_source",
  "20260618120000_site_scoped_entity_keys",
  "20260619192711_add_livestore_hooks",
  "20260619201302_add_livestore_hook_context",
  "20260620164537_split_livestore_hook_event_identity",
  "20260622120000_graph_types",
  "20260623120000_graph_node_facets",
  "20260623130000_graph_type_inputs_facets",
  "20260708164934_api_tokens",
  "20260708165507_api_token_audit_actions",
  "20260708170000_add_graph_updatedat_indexes",
  "20260710120000_rename_blob_to_version",
  "20260713120000_add_station_state_log_updatedat_index",
  "20260714120000_refresh_reuse_grace",
  "20260722180000_add_metric_bucket_historian_indexes",
  "20260722210000_saved_views",
  "20260803120000_cycle_source_event_id",
  "20260804144907_integrations",
  "20260812190000_metricbucket_hot_updates",
  "20260817120000_point_static_source",
  "20260819120000_inventory_item_quantity",
  "20260824140000_labels",
  "20260825112710_reset_code_and_admin_reset",
  "20260825120000_cycle_modes_rate_standards",
  "20260825190000_invite_temp_password",
  "20260826010000_label_color",
  "20260826020000_user_avatar",
  "20260827090000_inventory_first_orders",
  "20260828090000_product_stock_adjustments",
  "20260828181749_calls",
  "20260831151747_call_definition_require_open_message",
  "20260831155743_call_definition_role_restrictions",
  "20260901000000_simplify_site_roles",
  "20260901090000_production_modes",
  "20260901120000_workcenter_grants",
  "20260902160000_automation_foundations",
  "20260902180000_mode_events_source",
  "20260902200000_notifications",
  "20260902230000_mode_log_dimensions",
  "20260903000000_automation_cooldown",
  "20260903010000_notification_direct_recipients",
  "20260904000000_sms_consent",
  "20260909000000_star_pattern_stamps",
  "20260910090000_job_history_amendment",
  "20260910120000_job_log_block_id",
  "20260911090000_cycle_amendment_id",
  "20260911093000_item_amendment_id",
  "20260912090000_state_log_planned_down",
  "20260913090000_job_log_amendment_id",
  "20260915090000_shift_gaps_overrides",
  "20260915130000_shift_definition_local_time",
  "20260915150000_shift_amendment",
  "20260915160000_shift_scheduled_flag",
  "20260915170000_shift_amendment_scheduled_flag",
  "20260916090000_shift_scheduled_stamps",
  "20260916120000_shift_override_note",
  "20260916150000_shift_pattern_soft_delete",
  "20260916160000_shift_gap_off_hours",
  "20260916190000_shift_amendment_added_shift",
  "20260916210000_shift_amendment_undo",
  "20260917120000_add_shift_signoff",
  "20260921180000_order_lifecycle",
  "20260922190000_expand_permission_vocabulary",
  "20260923100000_contract_permission_vocabulary",
  "20260924100000_bucket_access_model",
  "20260925100000_bucket_integrity",
  "20260926100000_plant_member_admin_split",
  "20260927100000_bucket_level_rename",
  "20260928100000_account_admin_flag",
  "20260929100000_drop_dead_models",
  "20260930100000_document_file_versions",
  "20261001100000_stock_ledger",
  "20261002100000_shift_comment_employee_author",
  "20261003100000_material_stock_book",
  "20261004100000_station_profiles",
  "20261005100000_station_profile_default",
  "20261006100000_automation_schedule",
  "20261006100000_station_profile_variations",
  "20261007100000_report_decks",
  "20261008100000_site_week_start",
  "20261009100000_report_deck_kind",
  "20261010100000_account_team_members",
  "20261011100000_station_sort_order",
  "20261012100000_fast_detect_workcenter_defaults",
  "20261013100000_graph_changesets_and_agent",
  "20261013100000_point_group_publish_interval",
  "20261014100000_agent_message_content_json",
  "20261014100000_overhead_pages",
  "20261015100000_overhead_page_log_source",
];

// Same precedence as prisma.config.ts.
const url = process.env.DATABASE_URL_MIGRATION ?? process.env.DATABASE_URL;
if (!url) {
  console.error("baseline-guard: DATABASE_URL_MIGRATION / DATABASE_URL not set");
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });
await client.connect();
let applied = new Set();
try {
  const { rows } = await client.query("SELECT to_regclass('public._prisma_migrations') IS NOT NULL AS exists");
  if (rows[0].exists) {
    const res = await client.query(
      "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL",
    );
    applied = new Set(res.rows.map((r) => r.migration_name));
  }
} finally {
  await client.end();
}

const missing = LEGACY.filter((name) => !applied.has(name));
// Nothing old recorded (new database), the baseline already recorded, or every
// old migration recorded: the baseline handles all three.
if (applied.has(BASELINE) || missing.length === 0 || missing.length === LEGACY.length) process.exit(0);

console.error(`baseline-guard: this database is missing ${missing.length} migration(s) from before the ${BASELINE} squash:`);
for (const name of missing) console.error(`  - ${name}`);
console.error("Nothing was changed. Deploy the last release before the squash (2748b90) to apply them, then deploy again.");
process.exit(1);
