import { FACTS } from "./facts.js";
import type { FactDef, MeasureDef, ReportFilter, ValueFormat } from "./types.js";
import { VIEWS } from "./views.js";

export { compileReportQuery, compileReportRows, runReportQuery, runReportRows } from "./compiler.js";
export { FACTS } from "./facts.js";
export { VIEWS, type ViewDef } from "./views.js";
export { RELATIVE_PRESETS, resolveDateRange, siteDate, type RelativePreset, type ReportDateRange } from "./dates.js";
export type {
  CatalogText,
  SegmentDef,
  FactDef,
  FieldDef,
  MeasureDef,
  DimensionDef,
  ReportFilter,
  ReportQuery,
  ReportResult,
  ReportRow,
  ReportRowsQuery,
  ReportRowsResult,
  ReportScope,
} from "./types.js";

/** Serializable measure metadata — SQL stays server-side. */
export interface MeasureSchema {
  key: string;
  label: string;
  kind: "count" | "sum" | "min" | "max" | "avg" | "ratio";
  description?: string;
  /**
   * Whether the measure has a value for a single row, so report.rows can show
   * it. COUNT doesn't, and nor does a ratio built on one — "good cycle rate"
   * is a property of a group, not of one cycle.
   */
  rowLocal: boolean;
  /** How to render the number — seconds and percentages aren't plain counts. */
  format: ValueFormat;
  /** Dimensions a query must group by (or pin) to ask for this measure. */
  requiresDimensions?: readonly string[];
}

/** A measure with no declared format is a plain tally; a ratio is a percentage. */
const measureFormat = (measure: MeasureDef): ValueFormat =>
  measure.format ?? (measure.kind === "ratio" ? "percent" : "count");

/** Mirrors what the detail compiler will accept, so the schema can't promise more. */
function isRowLocal(fact: FactDef, measure: MeasureDef): boolean {
  if (measure.kind === "count") return false;
  if (measure.kind !== "ratio") return true;
  const components = [measure.numerator, measure.denominator].flatMap((side) => (Array.isArray(side) ? side : [side]));
  return components.every((key) => {
    const component = fact.measures[key];
    return component !== undefined && component.kind !== "count" && component.kind !== "ratio";
  });
}

export interface DimensionSchema {
  key: string;
  label: string;
  type: "id" | "date" | "enum" | "string";
  enumValues?: readonly string[];
  /** True when result rows include a `<key>Name` display column. */
  hasName: boolean;
  /** True when hasLabel/notHasLabel filters are available on this dimension. */
  hasLabels: boolean;
  description?: string;
}

/** A named filter a query can switch on with `segments: [key]`. */
export interface SegmentSchema {
  key: string;
  label: string;
  description?: string;
}

/**
 * A row-local column, available to report.rows only. Not a grouping key, so it
 * never appears in an aggregate query.
 */
export interface FieldSchema {
  key: string;
  label: string;
  type: "timestamp" | "decimal" | "number" | "string" | "id" | "boolean";
  description?: string;
  /** How to render the value; defaults by type when the field doesn't say. */
  format: ValueFormat;
}

export interface FactSchema {
  key: string;
  label: string;
  description?: string;
  /** Whether dateGranularity: "hour" is available (fact has an event timestamp). */
  supportsHourly: boolean;
  /** Whether report.rows can list this fact's rows (the fact declares a row key). */
  supportsDetail: boolean;
  /** Filters applied unless the query pins that dimension (UI should surface them). */
  defaultFilters: ReportFilter[];
  segments: SegmentSchema[];
  measures: MeasureSchema[];
  dimensions: DimensionSchema[];
  /**
   * Detail-only columns. Default column sets and their order belong to each
   * client — the catalog states what exists, not how to lay it out.
   */
  fields: FieldSchema[];
}

/**
 * The catalog as plain data for the report-builder UI: fact/measure/dimension
 * pickers render straight from this. No SQL crosses the wire.
 */
export function reportSchema(): FactSchema[] {
  return Object.entries(FACTS).map(([key, fact]) => ({
    key,
    label: fact.label,
    description: fact.description,
    supportsHourly: fact.timeColumn !== undefined,
    supportsDetail: fact.rowKey !== undefined,
    defaultFilters: fact.defaultFilters ?? [],
    segments: Object.entries(fact.segments ?? {}).map(([sKey, seg]) => ({
      key: sKey,
      label: seg.label,
      description: seg.description,
    })),
    measures: Object.entries(fact.measures).map(([mKey, m]) => ({
      key: mKey,
      label: m.label,
      kind: m.kind,
      description: m.description,
      rowLocal: isRowLocal(fact, m),
      format: measureFormat(m),
      ...(m.requiresDimensions ? { requiresDimensions: m.requiresDimensions } : {}),
    })),
    dimensions: Object.entries(fact.dimensions).map(([dKey, d]) => ({
      key: dKey,
      label: d.label,
      type: d.type,
      enumValues: d.enumValues,
      hasName: d.lookup !== undefined || d.nameColumn !== undefined,
      hasLabels: d.labelJoin !== undefined,
      description: d.description,
    })),
    fields: Object.entries(fact.fields ?? {}).map(([fKey, f]) => ({
      key: fKey,
      label: f.label,
      type: f.type,
      description: f.description,
      format: f.format ?? (f.type === "decimal" || f.type === "number" ? "quantity" : "text"),
    })),
  }));
}

// ── The catalog for the AI ──────────────────────────────────────────────────
// Short on purpose: every word here is sent to the model on each question.
// Keys, plain descriptions, other names and tips. Never SQL.

export interface AiMember {
  key: string;
  label: string;
  description?: string;
  synonyms?: readonly string[];
  hint?: string;
}

export interface AiMeasure extends AiMember {
  format: ValueFormat;
  /** A ratio or average: the server combines it, never add these up yourself. */
  ratio?: true;
  requires?: readonly string[];
}

export interface AiDimension extends AiMember {
  type: "id" | "date" | "enum" | "string";
  values?: readonly string[];
}

/** One view, spelled out enough for the AI to write a query on it. */
export interface AiView extends AiMember {
  fact: string;
  examples?: readonly string[];
  hourly: boolean;
  measures: AiMeasure[];
  dimensions: AiDimension[];
  segments: AiMember[];
  /** Filters the server adds unless the query sets that dimension itself. */
  defaults: ReportFilter[];
}

const compact = <T extends object>(value: T): T =>
  Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined && !(Array.isArray(v) && v.length === 0)),
  ) as T;

/** Full detail for one view, or undefined when there is no such view. */
export function describeView(viewKey: string): AiView | undefined {
  const view = VIEWS[viewKey];
  const fact = view && FACTS[view.fact];
  if (!view || !fact) return undefined;
  return compact({
    key: viewKey,
    label: view.label,
    description: view.description,
    synonyms: view.synonyms,
    hint: view.aiHint,
    fact: view.fact,
    examples: view.examples,
    hourly: fact.timeColumn !== undefined,
    measures: view.measures.flatMap((key) => {
      const m = fact.measures[key];
      if (!m) return [];
      return [
        compact<AiMeasure>({
          key,
          label: m.label,
          description: m.description,
          synonyms: m.synonyms,
          hint: m.aiHint,
          format: measureFormat(m),
          ratio: m.kind === "ratio" || m.kind === "avg" ? true : undefined,
          requires: m.requiresDimensions,
        }),
      ];
    }),
    dimensions: view.dimensions.flatMap((key) => {
      const d = fact.dimensions[key];
      if (!d) return [];
      return [
        compact<AiDimension>({
          key,
          label: d.label,
          description: d.description,
          synonyms: d.synonyms,
          hint: d.aiHint,
          type: d.type,
          values: d.enumValues,
        }),
      ];
    }),
    segments: (view.segments ?? []).flatMap((key) => {
      const seg = fact.segments?.[key];
      return seg
        ? [compact<AiMember>({ key, label: seg.label, description: seg.description, synonyms: seg.synonyms })]
        : [];
    }),
    defaults: fact.defaultFilters ?? [],
  });
}

/** Every view in short form: what it is about and what it offers, by key. */
export function listViewsForAi(): Array<
  AiMember & { measures: string[]; dimensions: string[]; examples?: readonly string[] }
> {
  return Object.entries(VIEWS).map(([key, view]) =>
    compact({
      key,
      label: view.label,
      description: view.description,
      synonyms: view.synonyms,
      hint: view.aiHint,
      examples: view.examples,
      measures: [...view.measures],
      dimensions: [...view.dimensions],
    }),
  );
}

/**
 * Find views, measures and dimensions whose words match `text`. Plain word
 * matching, scored by how many words hit. Good enough for a catalog this size;
 * swap in embeddings if it grows past a few hundred members.
 */
export function searchCatalog(
  text: string,
  limit = 12,
): Array<{
  view: string;
  kind: "view" | "measure" | "dimension" | "segment";
  key: string;
  label: string;
  description?: string;
}> {
  const words = text
    .toLowerCase()
    .split(/[^a-z0-9%]+/)
    .filter((w) => w.length > 1);
  if (words.length === 0) return [];
  const score = (...parts: Array<string | readonly string[] | undefined>) => {
    const hay = parts.flat().filter(Boolean).join(" ").toLowerCase();
    return words.reduce((n, w) => n + (hay.includes(w) ? 1 : 0), 0);
  };
  const hits: Array<{
    score: number;
    view: string;
    kind: "view" | "measure" | "dimension" | "segment";
    key: string;
    label: string;
    description?: string;
  }> = [];
  for (const [viewKey, view] of Object.entries(VIEWS)) {
    const fact = FACTS[view.fact];
    if (!fact) continue;
    const viewScore = score(viewKey, view.label, view.description, view.synonyms);
    if (viewScore > 0)
      hits.push({
        score: viewScore + 1,
        view: viewKey,
        kind: "view",
        key: viewKey,
        label: view.label,
        description: view.description,
      });
    for (const key of view.measures) {
      const m = fact.measures[key];
      const n = m ? score(key, m.label, m.description, m.synonyms) : 0;
      if (m && n > 0)
        hits.push({ score: n, view: viewKey, kind: "measure", key, label: m.label, description: m.description });
    }
    for (const key of view.dimensions) {
      const d = fact.dimensions[key];
      const n = d ? score(key, d.label, d.description, d.synonyms) : 0;
      if (d && n > 0)
        hits.push({ score: n, view: viewKey, kind: "dimension", key, label: d.label, description: d.description });
    }
    for (const key of view.segments ?? []) {
      const seg = fact.segments?.[key];
      const n = seg ? score(key, seg.label, seg.description, seg.synonyms) : 0;
      if (seg && n > 0)
        hits.push({ score: n, view: viewKey, kind: "segment", key, label: seg.label, description: seg.description });
    }
  }
  return hits
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ score: _score, ...hit }) => hit);
}
