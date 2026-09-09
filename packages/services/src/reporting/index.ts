import { FACTS } from "./facts.js";
import type { ReportFilter } from "./types.js";

export { compileReportQuery, runReportQuery } from "./compiler.js";
export { FACTS } from "./facts.js";
export type {
  FactDef,
  MeasureDef,
  DimensionDef,
  ReportFilter,
  ReportQuery,
  ReportResult,
  ReportScope,
} from "./types.js";

/** Serializable measure metadata — SQL stays server-side. */
export interface MeasureSchema {
  key: string;
  label: string;
  kind: "count" | "sum" | "min" | "max" | "avg" | "ratio";
  description?: string;
}

export interface DimensionSchema {
  key: string;
  label: string;
  type: "id" | "date" | "enum" | "string";
  enumValues?: readonly string[];
  /** True when result rows include a `<key>Name` display column. */
  hasName: boolean;
}

export interface FactSchema {
  key: string;
  label: string;
  description?: string;
  /** Whether dateGranularity: "hour" is available (fact has an event timestamp). */
  supportsHourly: boolean;
  /** Filters applied unless the query pins that dimension (UI should surface them). */
  defaultFilters: ReportFilter[];
  measures: MeasureSchema[];
  dimensions: DimensionSchema[];
}

/**
 * The catalog as plain data for the report-builder UI: fact/measure/dimension
 * pickers render straight from this. No SQL crosses the wire. Pass the set of
 * permissions the caller holds to list only the facts they may query.
 */
export function reportSchema(grantedPermissions?: ReadonlySet<string>): FactSchema[] {
  return Object.entries(FACTS)
    .filter(([, fact]) => grantedPermissions === undefined || grantedPermissions.has(fact.permission))
    .map(([key, fact]) => ({
      key,
      label: fact.label,
      description: fact.description,
      supportsHourly: fact.timeColumn !== undefined,
      defaultFilters: fact.defaultFilters ?? [],
      measures: Object.entries(fact.measures).map(([mKey, m]) => ({
        key: mKey,
        label: m.label,
        kind: m.kind,
        description: m.description,
      })),
      dimensions: Object.entries(fact.dimensions).map(([dKey, d]) => ({
        key: dKey,
        label: d.label,
        type: d.type,
        enumValues: d.enumValues,
        hasName: d.lookup !== undefined || d.nameColumn !== undefined,
      })),
    }));
}
