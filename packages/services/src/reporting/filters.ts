import { Prisma } from "@rw/db";
import type { DimensionDef, FactDef, FieldDef, FilterOp, ReportFilter } from "./types.js";

// Filter compilation, shared by both query modes.
//
// A filter targets a dimension, a field, or a measure. Where the predicate
// lands depends on what it targets and which mode is running:
//   dimension / field → WHERE (row-local columns)
//   measure, detail   → WHERE (the measure's expr is row-local by rule 1)
//   measure, aggregate → HAVING (the aggregated value)
//
// Values are only ever bound as parameters. Operators and columns come from
// the catalog, and each type declares which operators it accepts, so a client
// cannot ask for "greater than" on a uuid or a LIKE on a date.

type ServiceError = { error: string; code: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const isValidDate = (value: string) => DATE_RE.test(value) && !Number.isNaN(Date.parse(value));
const isValidInstant = (value: string) => !Number.isNaN(Date.parse(value));
const isValidNumber = (value: string) => value.trim() !== "" && Number.isFinite(Number(value));

const SET_OPS = new Set<FilterOp>(["in", "notIn"]);
const RANGE_OPS = new Set<FilterOp>(["between", "notBetween"]);
const NULL_OPS = new Set<FilterOp>(["isNull", "notNull"]);
const ORDER_OPS = new Set<FilterOp>(["gt", "gte", "lt", "lte", "between", "notBetween"]);
const TEXT_OPS = new Set<FilterOp>(["contains", "beginsWith"]);

/** Which operators each target type accepts. */
const ALLOWED: Record<string, (op: FilterOp) => boolean> = {
  // Ordering a uuid is meaningless; substring-matching one is a mistake.
  id: (op) => op === "eq" || op === "neq" || SET_OPS.has(op) || NULL_OPS.has(op),
  enum: (op) => op === "eq" || op === "neq" || SET_OPS.has(op) || NULL_OPS.has(op),
  date: (op) => op === "eq" || op === "neq" || ORDER_OPS.has(op) || NULL_OPS.has(op),
  timestamp: (op) => op === "eq" || op === "neq" || ORDER_OPS.has(op) || NULL_OPS.has(op),
  number: (op) => op === "eq" || op === "neq" || ORDER_OPS.has(op) || SET_OPS.has(op) || NULL_OPS.has(op),
  string: (op) => op === "eq" || op === "neq" || SET_OPS.has(op) || TEXT_OPS.has(op) || NULL_OPS.has(op),
  boolean: (op) => op === "eq" || op === "neq" || NULL_OPS.has(op),
};

/** Wildcards in a user's value are literal text, not pattern syntax. */
const escapeLike = (value: string) => value.replace(/([\\%_])/g, "\\$1");

/**
 * How a target's values reach Postgres: the cast applied to each parameter,
 * and the validation that keeps a bad value a clean 4xx instead of a cast
 * error surfacing as a 500.
 */
interface ValueKind {
  /** Comparison group, keyed into ALLOWED. */
  ops: keyof typeof ALLOWED;
  validate?: (value: string) => boolean;
  cast?: "date" | "uuid" | "timestamptz" | "numeric" | "boolean";
  /** Compare the column as text (enums, and anything parameterised as text). */
  asText?: boolean;
}

function dimensionKind(dim: DimensionDef): ValueKind {
  switch (dim.type) {
    case "date":
      return { ops: "date", validate: isValidDate, cast: "date" };
    case "id":
      return { ops: "id", validate: (v) => UUID_RE.test(v), cast: "uuid" };
    case "enum":
      return { ops: "enum", asText: true };
    default:
      return { ops: "string", asText: true };
  }
}

function fieldKind(field: FieldDef): ValueKind {
  switch (field.type) {
    case "timestamp":
      return { ops: "timestamp", validate: isValidInstant, cast: "timestamptz" };
    case "decimal":
    case "number":
      return { ops: "number", validate: isValidNumber, cast: "numeric" };
    case "id":
      return { ops: "id", validate: (v) => UUID_RE.test(v), cast: "uuid" };
    case "boolean":
      return { ops: "boolean", validate: (v) => v === "true" || v === "false", cast: "boolean" };
    default:
      return { ops: "string", asText: true };
  }
}

/** Where a resolved filter's predicate belongs. */
export type FilterPlacement = "where" | "having";

export interface ResolvedFilter {
  sql: Prisma.Sql;
  placement: FilterPlacement;
  /** Lookup join this predicate needs, when filtering a dimension's name. */
  join?: string;
}

/** The dimension's value expression: an override, else the plain column. */
export const dimSql = (dim: DimensionDef) => dim.expr ?? `f."${dim.column}"`;

/** A parameter with its cast applied, e.g. `$1::uuid`. */
function param(value: string, kind: ValueKind): Prisma.Sql {
  switch (kind.cast) {
    case "date":
      return Prisma.sql`${value}::date`;
    case "uuid":
      return Prisma.sql`${value}::uuid`;
    case "timestamptz":
      return Prisma.sql`${value}::timestamptz`;
    case "numeric":
      return Prisma.sql`${value}::numeric`;
    case "boolean":
      return Prisma.sql`${value}::boolean`;
    default:
      return Prisma.sql`${value}`;
  }
}

function comparison(col: Prisma.Sql, op: FilterOp, rhs: Prisma.Sql): Prisma.Sql | ServiceError {
  switch (op) {
    case "eq":
      return Prisma.sql`${col} = ${rhs}`;
    // IS DISTINCT FROM, so a NULL row is "not equal" rather than unknown —
    // "everything except X" should include the rows with no value at all.
    case "neq":
      return Prisma.sql`${col} IS DISTINCT FROM ${rhs}`;
    case "gt":
      return Prisma.sql`${col} > ${rhs}`;
    case "gte":
      return Prisma.sql`${col} >= ${rhs}`;
    case "lt":
      return Prisma.sql`${col} < ${rhs}`;
    case "lte":
      return Prisma.sql`${col} <= ${rhs}`;
    default:
      return { error: `Operator ${op} needs a different value shape`, code: "INVALID_FILTER" };
  }
}

/**
 * Compiles one filter into a predicate, or an error naming what was wrong.
 *
 * `resolveMeasure` supplies the measure SQL for the current mode — the caller
 * owns that, so measure internals stay in the compiler.
 */
export function compileFilter(
  fact: FactDef,
  filter: ReportFilter,
  opts: {
    mode: "aggregate" | "detail";
    resolveMeasure: (key: string) => string | ServiceError;
    /** Unique suffix for this filter's own join alias. */
    alias: string;
  },
): ResolvedFilter | ServiceError {
  const key = filter.dimension;
  const op = filter.op;

  // Resolution mirrors the projection. Fields are detail-only, so an aggregate
  // query cannot see them — otherwise a field would shadow the measure of the
  // same name (both `quantity`) and HAVING would be unreachable.
  const dim = fact.dimensions[key];
  const field = opts.mode === "detail" ? fact.fields?.[key] : undefined;
  const measure = fact.measures[key];

  // `<key>Name` filters the display value rather than the id — matching on a
  // name is what a person actually types. The lookup join comes along for the
  // filter whether or not the column was selected; a row-local nameColumn
  // needs no join at all.
  const named = key.endsWith("Name") ? fact.dimensions[key.slice(0, -4)] : undefined;

  let column: string;
  let kind: ValueKind;
  let placement: FilterPlacement = "where";
  let join: string | undefined;

  if (dim) {
    column = dimSql(dim);
    kind = dimensionKind(dim);
  } else if (named?.nameColumn) {
    column = `f."${named.nameColumn}"`;
    kind = { ops: "string", asText: true };
  } else if (named?.lookup) {
    const alias = `fn${opts.alias}`;
    join = named.lookup.join.replaceAll("{a}", alias).replaceAll("{b}", `${alias}b`);
    column = named.lookup.name.replaceAll("{a}", alias).replaceAll("{b}", `${alias}b`);
    kind = { ops: "string", asText: true };
  } else if (field) {
    column = `f."${field.column}"`;
    kind = fieldKind(field);
  } else if (measure) {
    const expr = opts.resolveMeasure(key);
    if (typeof expr !== "string") return expr;
    column = `(${expr})`;
    kind = { ops: "number", validate: isValidNumber, cast: "numeric" };
    // An aggregated value can only be compared after grouping.
    placement = opts.mode === "aggregate" ? "having" : "where";
  } else {
    return { error: `Unknown filter target: ${key}`, code: "UNKNOWN_DIMENSION" };
  }

  if (op === "hasLabel" || op === "notHasLabel") {
    if (!dim?.labelJoin) {
      return { error: `${key} is not labelable`, code: "INVALID_FILTER" };
    }
    const ids = Array.isArray(filter.value) ? filter.value : filter.value === undefined ? [] : [filter.value];
    if (ids.length === 0) return { error: "A label filter needs at least one label", code: "INVALID_FILTER" };
    const bad = ids.find((v) => !UUID_RE.test(v));
    if (bad !== undefined) return { error: `Invalid label id: ${bad}`, code: "INVALID_FILTER" };

    // EXISTS against the implicit m2m table: "carries at least one of these".
    // The entity id is in whichever column the label is not.
    const { table, labelColumn } = dim.labelJoin;
    const entityColumn = labelColumn === "A" ? "B" : "A";
    const link = Prisma.raw(
      `SELECT 1 FROM "${table}" lbl WHERE lbl."${entityColumn}" = ${dimSql(dim)} AND lbl."${labelColumn}" = ANY(`,
    );
    const exists = Prisma.sql`${link}${ids}::uuid[])`;
    return {
      sql: op === "hasLabel" ? Prisma.sql`EXISTS (${exists})` : Prisma.sql`NOT EXISTS (${exists})`,
      placement: "where",
      join,
    };
  }

  if (!ALLOWED[kind.ops](op)) {
    return { error: `Operator ${op} is not available on ${key}`, code: "INVALID_FILTER" };
  }

  const col = Prisma.raw(kind.asText ? `${column}::text` : column);

  if (NULL_OPS.has(op)) {
    return {
      sql: op === "isNull" ? Prisma.sql`${col} IS NULL` : Prisma.sql`${col} IS NOT NULL`,
      placement,
      join,
    };
  }

  if (filter.value === undefined) return { error: `Operator ${op} needs a value`, code: "INVALID_FILTER" };
  const values = Array.isArray(filter.value) ? filter.value : [filter.value];
  if (values.length === 0) return { error: "Filter has no values", code: "INVALID_FILTER" };
  if (kind.validate) {
    const bad = values.find((v) => !kind.validate?.(v));
    if (bad !== undefined) return { error: `Invalid ${kind.ops} filter value: ${bad}`, code: "INVALID_FILTER" };
  }

  if (SET_OPS.has(op)) {
    // ANY over an array parameter, so one bind covers any number of values.
    const array =
      kind.cast === "uuid"
        ? Prisma.sql`${values}::uuid[]`
        : kind.cast === "numeric"
          ? Prisma.sql`${values}::numeric[]`
          : Prisma.sql`${values}`;
    return {
      sql: op === "in" ? Prisma.sql`${col} = ANY(${array})` : Prisma.sql`NOT (${col} = ANY(${array}))`,
      placement,
      join,
    };
  }

  if (RANGE_OPS.has(op)) {
    if (values.length !== 2) {
      return { error: `Operator ${op} needs exactly two values`, code: "INVALID_FILTER" };
    }
    const range = Prisma.sql`${param(values[0], kind)} AND ${param(values[1], kind)}`;
    return {
      sql: op === "between" ? Prisma.sql`${col} BETWEEN ${range}` : Prisma.sql`${col} NOT BETWEEN ${range}`,
      placement,
      join,
    };
  }

  if (TEXT_OPS.has(op)) {
    // Case-insensitive, and the user's own % or _ stay literal.
    const pattern = op === "contains" ? `%${escapeLike(values[0])}%` : `${escapeLike(values[0])}%`;
    return { sql: Prisma.sql`${col} ILIKE ${pattern}`, placement, join };
  }

  const predicate = comparison(col, op, param(values[0], kind));
  if ("error" in predicate) return predicate;
  return { sql: predicate, placement, join };
}
