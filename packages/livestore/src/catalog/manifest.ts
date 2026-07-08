import { z } from "zod";

import { LIVESTORE_HOOK_EVENT_CATALOG, type LivestoreHookEventSchema } from "./events.js";
import { GRAPH_TYPE_INPUT_VALUE_TYPES, GRAPH_TYPE_VALUE_TYPES } from "./graph-types.js";
import type { GraphHookConditionOperator } from "./hook-conditions.js";
import {
  LIVESTORE_AGGREGATIONS,
  LIVESTORE_RESOLVER_CONFIG_SCHEMAS,
  LIVESTORE_RESOLVER_TYPES,
  type LivestoreResolverType,
} from "./resolver-schemas.js";

// The capability manifest: everything a programmatic builder (UI, agent, MCP
// server) needs to construct valid graph definitions without reading source.
// Static per deploy — the per-site vocabulary (types, entities, metrics,
// existing nodes/properties) is served by the graph.* discovery RPCs instead.

export interface LivestoreResolverTypeDescriptor {
  type: LivestoreResolverType;
  label: string;
  description: string;
  // How dependency edges are derived from this resolver's config.
  dependencies: "none" | "expressionSymbols" | "sourceProperty";
  // Server-side checks that run on save beyond the structural configSchema.
  referentialChecks: string[];
  configSchema: Record<string, unknown>;
}

export interface LivestoreHookOperatorDescriptor {
  operator: GraphHookConditionOperator;
  description: string;
  requiresThreshold: boolean;
  requiresValue: boolean;
  supportsMinDelta: boolean;
}

export interface LivestoreCapabilityManifest {
  manifestVersion: number;
  resolverTypes: LivestoreResolverTypeDescriptor[];
  aggregations: readonly string[];
  expression: {
    language: string;
    propertyReference: {
      symbolPrefix: string;
      symbolPattern: string;
      description: string;
    };
  };
  hookConditions: {
    operators: LivestoreHookOperatorDescriptor[];
    conditionSchema: Record<string, unknown>;
  };
  hookEvents: readonly LivestoreHookEventSchema[];
  graphTypes: {
    valueTypes: readonly string[];
    inputValueTypes: readonly string[];
    typeRefFormat: string;
  };
  limits: {
    minWindowMs: number;
    ewmaAlphaRange: string;
    sampleRateMs: string;
  };
  valueEnvelope: {
    qualities: readonly string[];
    description: string;
  };
}

const RESOLVER_DESCRIPTOR_META: Record<
  LivestoreResolverType,
  Pick<LivestoreResolverTypeDescriptor, "label" | "description" | "dependencies" | "referentialChecks">
> = {
  tag: {
    label: "Tag",
    description: "Live edge value from a device tag (NATS subject derived from deviceId + tagPath).",
    dependencies: "none",
    referentialChecks: [],
  },
  entity: {
    label: "Entity field",
    description: "Field or relation read off a catalogued entity (system entity or user object schema).",
    dependencies: "none",
    referentialChecks: [
      "entityType must be a known system entity or a user object-schema key/ID in the site",
      "entityId must exist in the graph's site",
      'path must be a catalog field on the entity (or the runtime specials "id" / "*")',
    ],
  },
  metric: {
    label: "Metric",
    description: "Manufacturing KPI column from a MetricBucket, delivered via the metrics bridge.",
    dependencies: "none",
    referentialChecks: [
      "entityType must be Site, Workcenter, Station, or Job",
      "entityId must exist in the graph's site",
    ],
  },
  expr: {
    label: "Expression",
    description: "Sandboxed mathjs expression over other property values.",
    dependencies: "expressionSymbols",
    referentialChecks: [
      "every referenced property must exist in the graph's site",
      "the resulting dependency edges must not create a cycle",
    ],
  },
  window: {
    label: "Window",
    description: "Time aggregation (tumbling buckets or EWMA) over one source property.",
    dependencies: "sourceProperty",
    referentialChecks: [
      "sourcePropertyId must exist in the graph's site",
      "the source property must not itself be a window property",
      "the resulting dependency edge must not create a cycle",
    ],
  },
  rollup: {
    label: "Rollup",
    description: "Structural aggregation over child assets found via entity relations.",
    dependencies: "none",
    referentialChecks: ["parent (when given) must reference an entity that exists in the graph's site"],
  },
};

const HOOK_OPERATOR_DESCRIPTORS: LivestoreHookOperatorDescriptor[] = [
  {
    operator: "changed",
    description: "Fires on any value change.",
    requiresThreshold: false,
    requiresValue: false,
    supportsMinDelta: true,
  },
  {
    operator: "increases",
    description: "Fires when the numeric value increases.",
    requiresThreshold: false,
    requiresValue: false,
    supportsMinDelta: true,
  },
  {
    operator: "decreases",
    description: "Fires when the numeric value decreases.",
    requiresThreshold: false,
    requiresValue: false,
    supportsMinDelta: true,
  },
  {
    operator: "equals",
    description: "Fires when the value equals `value`.",
    requiresThreshold: false,
    requiresValue: true,
    supportsMinDelta: false,
  },
  {
    operator: "notEquals",
    description: "Fires when the value stops equalling `value`.",
    requiresThreshold: false,
    requiresValue: true,
    supportsMinDelta: false,
  },
  {
    operator: "gt",
    description: "Fires while the value is > threshold.",
    requiresThreshold: true,
    requiresValue: false,
    supportsMinDelta: false,
  },
  {
    operator: "gte",
    description: "Fires while the value is >= threshold.",
    requiresThreshold: true,
    requiresValue: false,
    supportsMinDelta: false,
  },
  {
    operator: "lt",
    description: "Fires while the value is < threshold.",
    requiresThreshold: true,
    requiresValue: false,
    supportsMinDelta: false,
  },
  {
    operator: "lte",
    description: "Fires while the value is <= threshold.",
    requiresThreshold: true,
    requiresValue: false,
    supportsMinDelta: false,
  },
  {
    operator: "crossesAbove",
    description: "Fires on the transition from <= threshold to > threshold.",
    requiresThreshold: true,
    requiresValue: false,
    supportsMinDelta: false,
  },
  {
    operator: "crossesBelow",
    description: "Fires on the transition from >= threshold to < threshold.",
    requiresThreshold: true,
    requiresValue: false,
    supportsMinDelta: false,
  },
];

// Hand-written JSON Schema mirroring catalog/hook-conditions.ts's
// parseGraphHookCondition. Kept literal (not zod-derived) because the
// "value key must be present but may hold anything" rule has no clean zod
// encoding; hook-conditions.test.ts pins the parser to these shapes.
const HOOK_CONDITION_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  description: "Condition watching one property; fires the hook's event when it matches (gated on good quality).",
  properties: {
    source: {
      type: "object",
      properties: {
        type: { const: "property" },
        propertyId: { type: "string", description: "Property to watch; must exist in the site." },
      },
      required: ["type", "propertyId"],
    },
    operator: { enum: HOOK_OPERATOR_DESCRIPTORS.map((op) => op.operator) },
    value: { description: "Comparison value; required for equals / notEquals." },
    threshold: {
      type: "number",
      description: "Numeric threshold; required for gt, gte, lt, lte, crossesAbove, crossesBelow.",
    },
    minDelta: {
      type: "number",
      minimum: 0,
      description: "Minimum numeric change for changed / increases / decreases to fire.",
    },
  },
  required: ["source", "operator"],
  allOf: [
    {
      if: { properties: { operator: { enum: ["equals", "notEquals"] } } },
      // biome-ignore lint/suspicious/noThenProperty: JSON Schema if/then keyword, not a thenable
      then: { required: ["value"] },
    },
    {
      if: { properties: { operator: { enum: ["gt", "gte", "lt", "lte", "crossesAbove", "crossesBelow"] } } },
      // biome-ignore lint/suspicious/noThenProperty: JSON Schema if/then keyword, not a thenable
      then: { required: ["threshold"] },
    },
  ],
};

let cachedManifest: LivestoreCapabilityManifest | null = null;

export function buildLivestoreCapabilityManifest(): LivestoreCapabilityManifest {
  if (cachedManifest) return cachedManifest;

  cachedManifest = {
    manifestVersion: 1,
    resolverTypes: LIVESTORE_RESOLVER_TYPES.map((type) => ({
      type,
      ...RESOLVER_DESCRIPTOR_META[type],
      configSchema: z.toJSONSchema(LIVESTORE_RESOLVER_CONFIG_SCHEMAS[type]) as Record<string, unknown>,
    })),
    aggregations: LIVESTORE_AGGREGATIONS,
    expression: {
      language: "mathjs",
      propertyReference: {
        symbolPrefix: "p_",
        symbolPattern: "^p_[0-9a-f]{8}_[0-9a-f]{4}_[1-8][0-9a-f]{3}_[89ab][0-9a-f]{3}_[0-9a-f]{12}$",
        description:
          "Reference a property as p_<propertyId> with dashes replaced by underscores. Each reference becomes a dependency edge; non-UUID p_* symbols are rejected at save time.",
      },
    },
    hookConditions: {
      operators: HOOK_OPERATOR_DESCRIPTORS,
      conditionSchema: HOOK_CONDITION_JSON_SCHEMA,
    },
    hookEvents: LIVESTORE_HOOK_EVENT_CATALOG,
    graphTypes: {
      valueTypes: GRAPH_TYPE_VALUE_TYPES,
      inputValueTypes: GRAPH_TYPE_INPUT_VALUE_TYPES,
      typeRefFormat:
        'Integration types: "@<namespace>/<key>" (e.g. "@imm/station"). Site types: bare "<key>". Both discoverable via graph.type.catalog.',
    },
    limits: {
      minWindowMs: 1000,
      ewmaAlphaRange: "(0, 1]",
      sampleRateMs: "positive integer milliseconds, or null for unsampled",
    },
    valueEnvelope: {
      qualities: ["good", "stale", "uncertain", "bad"],
      description:
        'Every property value is a ValueEnvelope { value, quality, timestamp, context? }. Quality propagates worst-of-inputs; evaluation errors surface as quality "bad" with the error in context.',
    },
  };

  return cachedManifest;
}
