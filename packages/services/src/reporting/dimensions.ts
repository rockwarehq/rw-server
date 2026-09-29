import type { DimensionDef } from "./types.js";

// Conformed dimensions — one factory per entity, reused by every fact, so
// cross-fact drill-across groups on identical keys and identical name lookups.
// Versioned entities resolve their display name through currentVersion.

const idDim = (
  label: string,
  column: string,
  join: string,
  name: string,
  sortExpr?: string,
  labelJoin?: DimensionDef["labelJoin"],
): DimensionDef => ({
  label,
  column,
  type: "id",
  lookup: { join, name },
  sortExpr,
  labelJoin,
});

// Prisma orders an implicit m2m table's name and columns alphabetically, so the
// label side is B for Job and ItemDispositionReason and A for the rest. Verified
// against the migrations; don't infer it.
const labels = (table: string, labelColumn: "A" | "B") => ({ table, labelColumn });

export const stationDim = (column = "stationId") =>
  idDim(
    "Station",
    column,
    `LEFT JOIN "Station" {a} ON {a}."id" = f."${column}"`,
    `{a}."name"`,
    undefined,
    labels("_LabelToStation", "A"),
  );

export const workcenterDim = (column = "workcenterId") =>
  idDim("Workcenter", column, `LEFT JOIN "Workcenter" {a} ON {a}."id" = f."${column}"`, `{a}."name"`);

export const jobDim = (column = "jobId") =>
  idDim(
    "Job",
    column,
    `LEFT JOIN "Job" {a} ON {a}."id" = f."${column}" LEFT JOIN "JobVersion" {b} ON {b}."id" = {a}."currentVersionId"`,
    `{b}."name"`,
    undefined,
    labels("_JobToLabel", "B"),
  );

export const productDim = (column = "productId") =>
  idDim(
    "Product",
    column,
    `LEFT JOIN "Product" {a} ON {a}."id" = f."${column}" LEFT JOIN "ProductVersion" {b} ON {b}."id" = {a}."currentVersionId"`,
    `COALESCE({b}."name", {b}."sku")`,
    undefined,
    labels("_LabelToProduct", "A"),
  );

export const toolDim = (column = "toolId") =>
  idDim(
    "Tool",
    column,
    `LEFT JOIN "Tool" {a} ON {a}."id" = f."${column}" LEFT JOIN "ToolVersion" {b} ON {b}."id" = {a}."currentVersionId"`,
    `{b}."name"`,
    undefined,
    labels("_LabelToTool", "A"),
  );

export const materialDim = (column = "materialId") =>
  idDim(
    "Material",
    column,
    `LEFT JOIN "Material" {a} ON {a}."id" = f."${column}" LEFT JOIN "MaterialVersion" {b} ON {b}."id" = {a}."currentVersionId"`,
    `COALESCE({b}."name", {b}."materialNumber")`,
    undefined,
    labels("_LabelToMaterial", "A"),
  );

/**
 * A product's SKU as its own dimension, sharing the productId column with
 * `product`. Two dimensions may sit on one column with different display
 * expressions — the log wants Part and SKU in separate cells.
 */
export const productSkuDim = (column = "productId") =>
  idDim(
    "Product SKU",
    column,
    `LEFT JOIN "Product" {a} ON {a}."id" = f."${column}" LEFT JOIN "ProductVersion" {b} ON {b}."id" = {a}."currentVersionId"`,
    `{b}."sku"`,
  );

/** The cavity recorded on a disposition; the stamp is a version id. */
export const toolCavityDim = (column = "toolCavityVersionId") =>
  idDim("Tool cavity", column, `LEFT JOIN "ToolCavityVersion" {a} ON {a}."id" = f."${column}"`, `{a}."name"`);

/** The status reason's category, two hops from the reason stamp. */
export const statusCategoryDim = (column = "statusReasonId") =>
  idDim(
    "Status category",
    column,
    `LEFT JOIN "StatusReason" {a} ON {a}."id" = f."${column}" LEFT JOIN "StatusCategory" {b} ON {b}."id" = {a}."categoryId"`,
    `{b}."name"`,
  );

/** The employee's badge number, sharing the employeeId column with `employee`. */
export const employeeNumberDim = (column = "employeeId") =>
  idDim(
    "Employee number",
    column,
    `LEFT JOIN "Employee" {a} ON {a}."id" = f."${column}" LEFT JOIN "EmployeeVersion" {b} ON {b}."id" = {a}."versionId"`,
    `{b}."employeeNumber"`,
  );

export const displayDim = (column = "displayId") =>
  idDim("Display", column, `LEFT JOIN "Display" {a} ON {a}."id" = f."${column}"`, `{a}."name"`);

/**
 * The workcenter inside a metric bucket's hierarchy path.
 *
 * Buckets carry no workcenterId column, but every bucket for a station in a
 * workcenter has `site.<id>.workcenter.<id>.station.<id>` — job buckets too,
 * which is why they can be workcenter-narrowed after all. A bucket for a
 * station outside any workcenter has no segment, so the value is NULL and a
 * workcenter-restricted principal doesn't see it.
 */
export const BUCKET_WORKCENTER_EXPR = `substring(f."path" from 'workcenter\\.([0-9a-f-]{36})')::uuid`;

/**
 * The station inside a metric bucket's path.
 *
 * A JOB bucket is per station — its entityId is an md5 of (station, job), so
 * the station can't be joined from the id, but the path names it. This is how
 * the old Job Recap showed a Station column: it parsed the same path in the
 * browser and looked the name up client-side.
 */
export const BUCKET_STATION_EXPR = `substring(f."path" from 'station\\.([0-9a-f-]{36})')::uuid`;

/**
 * The unit a station counts in ("ft", "lb"), from its current version; null
 * for a station that counts plain items. It is the station's unit NOW: a
 * station whose unit was changed shows its new unit on old rows too.
 */
const stationUnitExpr = (station: string) =>
  `(SELECT NULLIF(sv."quantityUnit", '') FROM "Station" s JOIN "StationVersion" sv ON sv."id" = s."currentVersionId" WHERE s."id" = ${station})`;

export const stationUnitDim = (column = "stationId"): DimensionDef => ({
  label: "Unit",
  column,
  expr: stationUnitExpr(`f."${column}"`),
  type: "string",
});

export const bucketStationDim = (): DimensionDef => ({
  label: "Station",
  column: "path",
  expr: BUCKET_STATION_EXPR,
  type: "id",
  lookup: {
    join: `LEFT JOIN "Station" {a} ON {a}."id" = ${BUCKET_STATION_EXPR}`,
    name: `{a}."name"`,
  },
});

/** A bucket's station's unit, the station read from its path (job buckets too). */
export const bucketStationUnitDim = (): DimensionDef => ({
  label: "Unit",
  column: "path",
  expr: stationUnitExpr(BUCKET_STATION_EXPR),
  type: "string",
});

export const bucketWorkcenterDim = (): DimensionDef => ({
  label: "Workcenter",
  column: "path",
  expr: BUCKET_WORKCENTER_EXPR,
  type: "id",
  lookup: {
    join: `LEFT JOIN "Workcenter" {a} ON {a}."id" = ${BUCKET_WORKCENTER_EXPR}`,
    name: `{a}."name"`,
  },
});

export const shiftDim = (column = "shiftInstanceId") =>
  idDim(
    "Shift",
    column,
    `LEFT JOIN "ShiftInstance" {a} ON {a}."id" = f."${column}"`,
    `{a}."shiftName"`,
    `{a}."startTime"`,
  );

/**
 * The shift's NAME ("2nd") as text, beside `shift`, which is one shift
 * instance. Filtering "2nd" by name keeps every 2nd shift, whatever the date
 * range; filtering `shift` pins one day's instance. The old logs filtered by
 * name, and reports must too. A primary-key lookup per row, so it needs no
 * join and filters, groups and sorts like any text column.
 */
export const shiftNameDim = (column = "shiftInstanceId"): DimensionDef => ({
  label: "Shift name",
  column,
  expr: `(SELECT si."shiftName" FROM "ShiftInstance" si WHERE si."id" = f."${column}")`,
  type: "string",
});

export const modeDim = (column = "modeId") =>
  idDim("Production mode", column, `LEFT JOIN "ProductionMode" {a} ON {a}."id" = f."${column}"`, `{a}."name"`);

export const employeeDim = (column = "employeeId", label = "Employee") =>
  idDim(
    label,
    column,
    `LEFT JOIN "Employee" {a} ON {a}."id" = f."${column}" LEFT JOIN "EmployeeVersion" {b} ON {b}."id" = {a}."versionId"`,
    `TRIM(CONCAT({b}."firstName", ' ', {b}."lastName"))`,
  );

/**
 * A signed-in user (not an employee): whoever wrote or signed off in the app.
 * Named by name only, null when they have none — never their email, since
 * report results are kept in deck editions that links show to anyone.
 */
export const userDim = (column: string, label: string) =>
  idDim(
    label,
    column,
    `LEFT JOIN "User" {a} ON {a}."id" = f."${column}"`,
    `NULLIF(TRIM(CONCAT({a}."firstName", ' ', {a}."lastName")), '')`,
  );

export const orderDim = (column = "orderId") =>
  idDim("Order", column, `LEFT JOIN "Order" {a} ON {a}."id" = f."${column}"`, `{a}."orderNumber"`);

export const dispositionDim = (column = "itemDispositionId") =>
  idDim("Disposition", column, `LEFT JOIN "ItemDisposition" {a} ON {a}."id" = f."${column}"`, `{a}."name"`);

export const dispositionReasonDim = (column = "dispositionReasonId") =>
  idDim(
    "Disposition reason",
    column,
    `LEFT JOIN "ItemDispositionReason" {a} ON {a}."id" = f."${column}"`,
    `{a}."name"`,
    undefined,
    labels("_ItemDispositionReasonToLabel", "B"),
  );

export const statusReasonDim = (column = "statusReasonId") =>
  idDim(
    "Status reason",
    column,
    `LEFT JOIN "StatusReason" {a} ON {a}."id" = f."${column}"`,
    `{a}."name"`,
    undefined,
    labels("_LabelToStatusReason", "A"),
  );

/**
 * The color the site gives a status reason, as `#rrggbb` text, or null when
 * it has none. Colors live in the site's settings
 * (`attrs.statusReasonColors.colors`, keyed by reason id), not on the reason,
 * so this reads them there for the row's own site. Unvalidated: a client
 * checks it is a color before drawing with it.
 */
export const statusReasonColorDim = (column = "statusReasonId"): DimensionDef => ({
  label: "Status reason color",
  column,
  expr: `(SELECT s."attrs"->'statusReasonColors'->'colors'->>(f."${column}"::text) FROM "Site" s WHERE s."id" = f."siteId")`,
  type: "string",
});

/** Whether the status reason itself is planned downtime — its class, beside the period's own flag. */
export const statusReasonPlannedDim = (column = "statusReasonId"): DimensionDef => ({
  label: "Reason is planned",
  column,
  expr: `(SELECT r."isPlannedDown" FROM "StatusReason" r WHERE r."id" = f."${column}")`,
  type: "enum",
  enumValues: ["true", "false"],
});

export const callDefinitionDim = (column = "definitionId") =>
  idDim("Call type", column, `LEFT JOIN "CallDefinition" {a} ON {a}."id" = f."${column}"`, `{a}."name"`);

export const businessDateDim = (column = "businessDate"): DimensionDef => ({
  label: "Business date",
  column,
  type: "date",
});

/** The row's shift-stamp flag (ADR-0015); facts carry it so no join is needed. */
export const scheduledDim = (column = "isScheduled") => enumDim("Scheduled time", column, ["true", "false"]);

export const enumDim = (label: string, column: string, values: readonly string[]): DimensionDef => ({
  label,
  column,
  type: "enum",
  enumValues: values,
});
