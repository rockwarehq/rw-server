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
        metricField("oee", "OEE", "Overall equipment effectiveness ratio", "oee", "percent", 10),
        metricField(
          "goodItems",
          "Good Items",
          "Good produced item count for the current shift",
          "goodItems",
          "number",
          20,
        ),
        metricField(
          "totalItems",
          "Total Items",
          "Total produced item count for the current shift",
          "totalItems",
          "number",
          30,
        ),
        metricField("goodCycles", "Good Cycles", "Good cycle count for the current shift", "goodCycles", "number", 40),
        metricField(
          "totalCycles",
          "Total Cycles",
          "Total cycle count for the current shift",
          "totalCycles",
          "number",
          50,
        ),
      ],
    },
  ],
} as const satisfies LivestoreGraphTypeNamespaceSchema;

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
      entityType: "STATION",
      entityId: "$input.stationId",
      granularity: "SHIFT",
      metricKey,
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
