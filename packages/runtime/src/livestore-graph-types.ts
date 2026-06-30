const GRAPH_TYPE_TOKEN_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
const SCOPED_GRAPH_TYPE_REF_PATTERN = /^@([a-z0-9][a-z0-9_-]*)\/([a-z0-9][a-z0-9_-]*)$/;

export const GRAPH_TYPE_VALUE_TYPES = ["string", "number", "percent", "boolean", "object", "json", "date"] as const;
export type GraphTypeValueType = (typeof GRAPH_TYPE_VALUE_TYPES)[number];

export const GRAPH_TYPE_INPUT_VALUE_TYPES = [...GRAPH_TYPE_VALUE_TYPES, "entityRef"] as const;
export type GraphTypeInputValueType = (typeof GRAPH_TYPE_INPUT_VALUE_TYPES)[number];

const GRAPH_TYPE_VALUE_TYPE_SET: ReadonlySet<string> = new Set(GRAPH_TYPE_VALUE_TYPES);
const GRAPH_TYPE_INPUT_VALUE_TYPE_SET: ReadonlySet<string> = new Set(GRAPH_TYPE_INPUT_VALUE_TYPES);

export interface LivestoreGraphTypeInputSchema {
  key: string;
  label: string;
  valueType: GraphTypeInputValueType;
  description?: string;
  required?: boolean;
  entityKey?: string;
  sortOrder?: number;
}

export interface LivestoreGraphTypeFieldSchema {
  key: string;
  label: string;
  valueType: GraphTypeValueType;
  resolverType: string;
  resolver: Record<string, unknown>;
  description?: string;
  required?: boolean;
  sampleRateMs?: number | null;
  sortOrder?: number;
}

export interface LivestoreGraphTypeFacetSchema {
  key: string;
  label: string;
  valueType?: GraphTypeValueType;
  resolverType: string;
  resolver: Record<string, unknown>;
  description?: string;
  required?: boolean;
  sortOrder?: number;
}

export interface LivestoreGraphTypeSchema {
  key: string;
  label: string;
  description?: string;
  inputs?: readonly LivestoreGraphTypeInputSchema[];
  facets?: readonly LivestoreGraphTypeFacetSchema[];
  fields: readonly LivestoreGraphTypeFieldSchema[];
}

export interface LivestoreGraphTypeNamespaceSchema {
  namespace: string;
  displayName: string;
  integration: string;
  description?: string;
  types: readonly LivestoreGraphTypeSchema[];
}

export interface ParsedGraphTypeRef {
  namespace: string | null;
  key: string;
  typeRef: string;
}

interface CounterSpec {
  key: string;
  label: string;
  description: string;
  // MetricBucket column / NATS subject token, when it differs from the displayed key.
  metricKey?: string;
}

interface DerivedSpec {
  key: string;
  label: string;
  description: string;
  expression: string;
  valueType: GraphTypeValueType;
}

// Additive counters: mirrored on Station, summed (rollup) on Workcenter/Site.
const BASE_COUNTERS: CounterSpec[] = [
  { key: "totalCycles", label: "Total Cycles", description: "Total cycle count" },
  { key: "expectedCycles", label: "Expected Cycles", description: "Expected cycle count" },
  { key: "totalItems", label: "Total Items", description: "Total produced item count" },
  { key: "badItems", label: "Bad Items", description: "Bad produced item count" },
  { key: "expectedItems", label: "Expected Items", description: "Expected produced item count" },
  { key: "runSeconds", label: "Run Seconds", description: "Running time" },
  // Downtime split: OEE-exempt (planned) vs counted (unplanned). The bucket's
  // total `downSeconds` column is intentionally not surfaced.
  {
    key: "oeeExemptDownSeconds",
    label: "OEE Exempt Down Seconds",
    description: "OEE-exempt (planned) downtime",
    metricKey: "plannedDownSeconds",
  },
  { key: "downSeconds", label: "Down Seconds", description: "Unplanned downtime", metricKey: "unplannedDownSeconds" },
  { key: "plannedProductionSeconds", label: "Planned Production Seconds", description: "Planned production time" },
  {
    key: "netRunSeconds",
    label: "Net Run Seconds",
    description: "Cycle count × standard cycle, summed (expected/ideal run time)",
    metricKey: "idealCycleSeconds",
  },
  { key: "elapsedExpectedCycles", label: "Elapsed Expected Cycles", description: "Elapsed expected cycle count" },
  { key: "elapsedExpectedItems", label: "Elapsed Expected Items", description: "Elapsed expected item count" },
  {
    key: "elapsedPlannedProductionSeconds",
    label: "Elapsed Planned Production Seconds",
    description: "Elapsed planned production time",
  },
];

// Derived KPIs computed by expression at every level over the base counters.
const DERIVED_FIELDS: DerivedSpec[] = [
  {
    key: "goodItems",
    label: "Good Items",
    description: "Good produced item count (totalItems − badItems)",
    valueType: "number",
    expression: "$field.totalItems - $field.badItems",
  },
  {
    key: "availability",
    label: "Availability",
    description: "Availability ratio (runSeconds / elapsedPlannedProductionSeconds)",
    valueType: "percent",
    expression: "$field.runSeconds / $field.elapsedPlannedProductionSeconds",
  },
  {
    key: "performance",
    label: "Performance",
    description: "Performance ratio (netRunSeconds / runSeconds)",
    valueType: "percent",
    expression: "$field.netRunSeconds / $field.runSeconds",
  },
  {
    key: "quality",
    label: "Quality",
    description: "Quality ratio ((totalItems − badItems) / totalItems)",
    valueType: "percent",
    expression: "($field.totalItems - $field.badItems) / $field.totalItems",
  },
  {
    key: "oee",
    label: "OEE",
    description: "Overall equipment effectiveness ratio",
    valueType: "percent",
    expression:
      "($field.netRunSeconds * ($field.totalItems - $field.badItems)) / ($field.elapsedPlannedProductionSeconds * $field.totalItems)",
  },
];

const counterMetricFields = (startSort: number): LivestoreGraphTypeFieldSchema[] =>
  BASE_COUNTERS.map((c, i) =>
    metricField(
      c.key,
      c.label,
      `${c.description} for the current shift`,
      c.metricKey ?? c.key,
      "number",
      startSort + i * 10,
    ),
  );

const counterRollupFields = (
  childKind: string,
  relation: string,
  parentModel: string,
  parentInputKey: string,
  startSort: number,
): LivestoreGraphTypeFieldSchema[] =>
  BASE_COUNTERS.map((c, i) =>
    rollupField(
      c.key,
      c.label,
      `${c.description} summed across ${relation}`,
      childKind,
      relation,
      parentModel,
      parentInputKey,
      startSort + i * 10,
    ),
  );

const derivedExprFields = (startSort: number): LivestoreGraphTypeFieldSchema[] =>
  DERIVED_FIELDS.map((d, i) => exprField(d.key, d.label, d.description, d.expression, d.valueType, startSort + i * 10));

export const IMM_GRAPH_TYPE_NAMESPACE = {
  namespace: "imm",
  displayName: "IMM",
  integration: "rockware-imm",
  description: "Rockware IMM graph node types.",
  types: [
    {
      key: "station",
      label: "Station",
      description: "IMM station with live shift metrics.",
      inputs: [
        {
          key: "stationId",
          label: "Station",
          description: "Station entity instance backing this graph node.",
          valueType: "entityRef",
          entityKey: "imm.station",
          required: true,
          sortOrder: 10,
        },
      ],
      facets: [
        entityFacet("stationId", "Station", "Station entity id", "imm.station", "$input.stationId", "id", true, 10),
        entityFacet(
          "workcenterId",
          "Workcenter",
          "Workcenter containing the station",
          "imm.station",
          "$input.stationId",
          "workcenter",
          false,
          20,
        ),
      ],
      fields: [
        entityField(
          "stationId",
          "Station Id",
          "Station entity id",
          "imm.station",
          "$input.stationId",
          "id",
          "string",
          5,
        ),
        entityField("name", "Name", "Station name", "imm.station", "$input.stationId", "name", "string", 6),
        entityField(
          "currentJobId",
          "Current Job",
          "Current job id on the station",
          "imm.station",
          "$input.stationId",
          "currentJob",
          "string",
          7,
        ),

        // Mirrored counters (NATS metric subjects, SHIFT granularity)
        ...counterMetricFields(100),
        // Derived KPIs (expressions over the counters)
        ...derivedExprFields(300),

        // Mirrored context (NATS metric subjects, non-KPI values)
        metricField(
          "shiftStartTime",
          "Shift Start",
          "Start time of the current shift bucket",
          "startTime",
          "date",
          400,
        ),
        metricField("businessDate", "Business Date", "Business date of the current shift", "businessDate", "date", 410),
        metricField("businessShift", "Business Shift", "Human-readable shift name", "businessShift", "string", 420),
        metricField(
          "currentStandardCycle",
          "Standard Cycle",
          "Standard cycle time in effect for the current shift",
          "currentStandardCycle",
          "number",
          430,
        ),
        metricField(
          "currentJobName",
          "Current Job Name",
          "Name of the current job on the station",
          "currentJobName",
          "string",
          440,
        ),
      ],
    },
    {
      key: "workcenter",
      label: "Workcenter",
      description: "IMM workcenter rolling up its stations.",
      inputs: [
        {
          key: "workcenterId",
          label: "Workcenter",
          description: "Workcenter entity instance backing this graph node.",
          valueType: "entityRef",
          entityKey: "imm.workcenter",
          required: true,
          sortOrder: 10,
        },
      ],
      facets: [
        entityFacet(
          "workcenterId",
          "Workcenter",
          "Workcenter entity id",
          "imm.workcenter",
          "$input.workcenterId",
          "id",
          true,
          10,
        ),
      ],
      fields: [
        entityField(
          "workcenterId",
          "Workcenter Id",
          "Workcenter entity id",
          "imm.workcenter",
          "$input.workcenterId",
          "id",
          "string",
          5,
        ),
        entityField("name", "Name", "Workcenter name", "imm.workcenter", "$input.workcenterId", "name", "string", 6),
        ...counterRollupFields("Station", "stations", "Workcenter", "workcenterId", 100),
        ...derivedExprFields(300),
      ],
    },
    {
      key: "site",
      label: "Site",
      description: "IMM site rolling up its workcenters.",
      inputs: [
        {
          key: "siteId",
          label: "Site",
          description: "Site entity instance backing this graph node.",
          valueType: "entityRef",
          entityKey: "imm.site",
          required: true,
          sortOrder: 10,
        },
      ],
      facets: [entityFacet("siteId", "Site", "Site entity id", "imm.site", "$input.siteId", "id", true, 10)],
      fields: [
        entityField("siteId", "Site Id", "Site entity id", "imm.site", "$input.siteId", "id", "string", 5),
        entityField("name", "Name", "Site name", "imm.site", "$input.siteId", "name", "string", 6),
        ...counterRollupFields("Workcenter", "workcenters", "Site", "siteId", 100),
        ...derivedExprFields(300),
      ],
    },
  ],
} satisfies LivestoreGraphTypeNamespaceSchema;

export const LIVESTORE_GRAPH_TYPE_NAMESPACES = [
  IMM_GRAPH_TYPE_NAMESPACE,
] as const satisfies readonly LivestoreGraphTypeNamespaceSchema[];

function entityFacet(
  key: string,
  label: string,
  description: string,
  entityKey: string,
  entityId: string,
  path: string,
  required: boolean,
  sortOrder: number,
): LivestoreGraphTypeFacetSchema {
  return {
    key,
    label,
    description,
    required,
    resolverType: "entity",
    resolver: {
      type: "entity",
      entityRef: {
        key: entityKey,
        id: entityId,
      },
      path,
    },
    sortOrder,
  };
}

function entityField(
  key: string,
  label: string,
  description: string,
  entityType: string,
  entityId: string,
  path: string,
  valueType: GraphTypeValueType,
  sortOrder: number,
): LivestoreGraphTypeFieldSchema {
  return {
    key,
    label,
    description,
    valueType,
    resolverType: "entity",
    resolver: {
      type: "entity",
      entityType,
      entityId,
      path,
    },
    sortOrder,
  };
}

function metricField(
  key: string,
  label: string,
  description: string,
  metricKey: string,
  valueType: GraphTypeValueType,
  sortOrder: number,
): LivestoreGraphTypeFieldSchema {
  return {
    key,
    label,
    description,
    valueType,
    resolverType: "metric",
    resolver: {
      type: "metric",
      entityType: "Station",
      entityId: "$input.stationId",
      granularity: "SHIFT",
      metricKey,
    },
    sortOrder,
  };
}

// Rollup field; sums a child kind's matching property over `relation`.
function rollupField(
  key: string,
  label: string,
  description: string,
  childKind: string,
  relation: string,
  parentModel: string,
  parentInputKey: string,
  sortOrder: number,
): LivestoreGraphTypeFieldSchema {
  return {
    key,
    label,
    description,
    valueType: "number",
    resolverType: "rollup",
    resolver: {
      type: "rollup",
      childKind,
      relation,
      childProperty: key,
      aggregation: "sum",
      parent: { model: parentModel, id: `$input.${parentInputKey}` },
    },
    sortOrder,
  };
}

// Expression field; references sibling fields via `$field.<key>` tokens.
function exprField(
  key: string,
  label: string,
  description: string,
  expression: string,
  valueType: GraphTypeValueType,
  sortOrder: number,
): LivestoreGraphTypeFieldSchema {
  return {
    key,
    label,
    description,
    valueType,
    resolverType: "expr",
    resolver: {
      type: "expr",
      expression,
    },
    sortOrder,
  };
}

export function normalizeGraphTypeToken(value: string): string {
  if (containsBlockedCharacter(value)) {
    throw new Error("Graph type token contains a wildcard or control character");
  }
  const token = value
    .trim()
    .toLowerCase()
    .replace(/[./\\\s]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[-_]+|[-_]+$/g, "");
  if (!token) throw new Error("Graph type token must not be empty");
  if (!GRAPH_TYPE_TOKEN_PATTERN.test(token)) throw new Error("Graph type token must be registry-safe");
  return token;
}

export function isGraphTypeValueType(value: unknown): value is GraphTypeValueType {
  return typeof value === "string" && GRAPH_TYPE_VALUE_TYPE_SET.has(value);
}

export function isGraphTypeInputValueType(value: unknown): value is GraphTypeInputValueType {
  return typeof value === "string" && GRAPH_TYPE_INPUT_VALUE_TYPE_SET.has(value);
}

export function normalizeGraphTypeValueType(value: string): GraphTypeValueType {
  const token = normalizeGraphTypeToken(value);
  if (!isGraphTypeValueType(token)) {
    throw new Error(`Graph type valueType must be one of: ${GRAPH_TYPE_VALUE_TYPES.join(", ")}`);
  }
  return token;
}

export function normalizeGraphTypeInputValueType(value: string): GraphTypeInputValueType {
  const token = normalizeGraphTypeToken(value);
  if (!isGraphTypeInputValueType(token)) {
    throw new Error(`Graph type input valueType must be one of: ${GRAPH_TYPE_INPUT_VALUE_TYPES.join(", ")}`);
  }
  return token;
}

export function graphTypeRef(namespace: string | null | undefined, key: string): string {
  const typeKey = normalizeGraphTypeToken(key);
  if (!namespace) return typeKey;
  return `@${normalizeGraphTypeToken(namespace)}/${typeKey}`;
}

export function parseGraphTypeRef(value: string): ParsedGraphTypeRef {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("Graph type ref must not be empty");
  if (trimmed.startsWith("@")) {
    const match = SCOPED_GRAPH_TYPE_REF_PATTERN.exec(trimmed.toLowerCase());
    if (!match) throw new Error("Scoped graph type refs must use @namespace/key");
    const namespace = normalizeGraphTypeToken(match[1] ?? "");
    const key = normalizeGraphTypeToken(match[2] ?? "");
    return { namespace, key, typeRef: graphTypeRef(namespace, key) };
  }
  const key = normalizeGraphTypeToken(trimmed);
  return { namespace: null, key, typeRef: key };
}

export function getLivestoreGraphTypeSchema(typeRef: string): LivestoreGraphTypeSchema | null {
  const parsed = parseGraphTypeRef(typeRef);
  if (!parsed.namespace) return null;
  const namespace = LIVESTORE_GRAPH_TYPE_NAMESPACES.find((candidate) => candidate.namespace === parsed.namespace);
  return namespace?.types.find((type) => type.key === parsed.key) ?? null;
}

for (const namespace of LIVESTORE_GRAPH_TYPE_NAMESPACES) {
  normalizeGraphTypeToken(namespace.namespace);
  for (const type of namespace.types) {
    normalizeGraphTypeToken(type.key);
    for (const input of type.inputs ?? []) normalizeGraphTypeToken(input.key);
    for (const facet of type.facets ?? []) normalizeGraphTypeToken(facet.key);
    for (const field of type.fields) normalizeGraphTypeToken(field.key);
  }
}

function containsBlockedCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (char === "*" || char === ">" || code < 32 || code === 127) return true;
  }
  return false;
}
