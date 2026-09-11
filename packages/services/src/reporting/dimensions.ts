import type { DimensionDef } from "./types.js";

// Conformed dimensions — one factory per entity, reused by every fact, so
// cross-fact drill-across groups on identical keys and identical name lookups.
// Versioned entities resolve their display name through currentVersion.

const idDim = (label: string, column: string, join: string, name: string): DimensionDef => ({
  label,
  column,
  type: "id",
  lookup: { join, name },
});

export const stationDim = (column = "stationId") =>
  idDim("Station", column, `LEFT JOIN "Station" {a} ON {a}."id" = f."${column}"`, `{a}."name"`);

export const workcenterDim = (column = "workcenterId") =>
  idDim("Workcenter", column, `LEFT JOIN "Workcenter" {a} ON {a}."id" = f."${column}"`, `{a}."name"`);

export const jobDim = (column = "jobId") =>
  idDim(
    "Job",
    column,
    `LEFT JOIN "Job" {a} ON {a}."id" = f."${column}" LEFT JOIN "JobVersion" {b} ON {b}."id" = {a}."currentVersionId"`,
    `{b}."name"`,
  );

export const productDim = (column = "productId") =>
  idDim(
    "Product",
    column,
    `LEFT JOIN "Product" {a} ON {a}."id" = f."${column}" LEFT JOIN "ProductVersion" {b} ON {b}."id" = {a}."currentVersionId"`,
    `COALESCE({b}."name", {b}."sku")`,
  );

export const toolDim = (column = "toolId") =>
  idDim(
    "Tool",
    column,
    `LEFT JOIN "Tool" {a} ON {a}."id" = f."${column}" LEFT JOIN "ToolVersion" {b} ON {b}."id" = {a}."currentVersionId"`,
    `{b}."name"`,
  );

export const materialDim = (column = "materialId") =>
  idDim(
    "Material",
    column,
    `LEFT JOIN "Material" {a} ON {a}."id" = f."${column}" LEFT JOIN "MaterialVersion" {b} ON {b}."id" = {a}."currentVersionId"`,
    `COALESCE({b}."name", {b}."materialNumber")`,
  );

export const shiftDim = (column = "shiftInstanceId") =>
  idDim("Shift", column, `LEFT JOIN "ShiftInstance" {a} ON {a}."id" = f."${column}"`, `{a}."shiftName"`);

export const modeDim = (column = "modeId") =>
  idDim("Production mode", column, `LEFT JOIN "ProductionMode" {a} ON {a}."id" = f."${column}"`, `{a}."name"`);

export const employeeDim = (column = "employeeId") =>
  idDim(
    "Employee",
    column,
    `LEFT JOIN "Employee" {a} ON {a}."id" = f."${column}" LEFT JOIN "EmployeeVersion" {b} ON {b}."id" = {a}."versionId"`,
    `TRIM(CONCAT({b}."firstName", ' ', {b}."lastName"))`,
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
  );

export const statusReasonDim = (column = "statusReasonId") =>
  idDim("Status reason", column, `LEFT JOIN "StatusReason" {a} ON {a}."id" = f."${column}"`, `{a}."name"`);

export const callDefinitionDim = (column = "definitionId") =>
  idDim("Call type", column, `LEFT JOIN "CallDefinition" {a} ON {a}."id" = f."${column}"`, `{a}."name"`);

export const businessDateDim = (column = "businessDate"): DimensionDef => ({
  label: "Business date",
  column,
  type: "date",
});

export const enumDim = (label: string, column: string, values: readonly string[]): DimensionDef => ({
  label,
  column,
  type: "enum",
  enumValues: values,
});
