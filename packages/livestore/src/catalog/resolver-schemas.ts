import { z } from "zod";

// Structural schemas for property resolver configs — the machine-readable
// source of truth behind graph/validation.ts's validateResolverConfig and the
// capability manifest (catalog/manifest.ts). Referential checks (entity
// exists in site, dependency properties exist, cycle detection) are NOT
// expressible here and stay in graph/validation.ts.
//
// Error messages are attached per field so the validator can surface the
// first issue's message verbatim, matching the historical error strings.

export const LIVESTORE_AGGREGATIONS = ["sum", "avg", "count", "min", "max"] as const;
export type LivestoreAggregation = (typeof LIVESTORE_AGGREGATIONS)[number];

export const LIVESTORE_RESOLVER_TYPES = ["tag", "entity", "metric", "expr", "window", "rollup"] as const;
export type LivestoreResolverType = (typeof LIVESTORE_RESOLVER_TYPES)[number];

export const tagResolverConfigSchema = z
  .looseObject({
    type: z.literal("tag").meta({ description: "Discriminator; must equal the property's resolverType." }),
    deviceId: z
      .string({ error: "tag resolver requires deviceId and tagPath" })
      .meta({ description: "Datasource/device ID publishing the tag." }),
    tagPath: z
      .string({ error: "tag resolver requires deviceId and tagPath" })
      .meta({ description: 'Tag path on the device, e.g. "line1/press/cycleCount".' }),
  })
  .meta({ description: "Live edge value: subscribes to the NATS subject derived from deviceId + tagPath." });

export const metricResolverConfigSchema = z
  .looseObject({
    type: z.literal("metric"),
    entityType: z
      .string({ error: "metric resolver requires entityType, entityId, granularity, and metricKey" })
      .meta({ description: "Metric entity kind: Site, Workcenter, Station, or Job." }),
    entityId: z
      .string({ error: "metric resolver requires entityType, entityId, granularity, and metricKey" })
      .meta({ description: "Entity instance ID; must exist in the graph's site." }),
    granularity: z
      .string({ error: "metric resolver requires entityType, entityId, granularity, and metricKey" })
      .meta({ description: 'Metric bucket granularity, e.g. "SHIFT".' }),
    metricKey: z
      .string({ error: "metric resolver requires entityType, entityId, granularity, and metricKey" })
      .meta({ description: "MetricBucket column key (see metricCatalog.list for valid keys per kind)." }),
  })
  .meta({ description: "Manufacturing KPI column delivered via the metrics→NATS bridge." });

export const entityResolverConfigSchema = z
  .looseObject({
    type: z.literal("entity"),
    entityType: z.string({ error: "entity resolver requires entityType, entityId, and path" }).meta({
      description: 'Entity catalog key — a system entity (e.g. "imm.station") or a user object-schema key/ID.',
    }),
    entityId: z
      .string({ error: "entity resolver requires entityType, entityId, and path" })
      .meta({ description: "Entity instance ID; must exist in the graph's site." }),
    path: z.string({ error: "entity resolver requires entityType, entityId, and path" }).meta({
      description:
        'Catalog field key on the entity. Runtime specials: "id" (the entity ID) and "*" (the whole record).',
    }),
  })
  .meta({ description: "Field/relation read off a catalogued entity, refreshed from the domain-event feed." });

const EXPRESSION_NON_BLANK = /\S/;

export const exprResolverConfigSchema = z
  .looseObject({
    type: z.literal("expr"),
    expression: z
      .string({ error: "expr resolver requires expression" })
      .regex(EXPRESSION_NON_BLANK, { error: "expr resolver requires expression" })
      .meta({
        description:
          "mathjs expression. Reference other properties as p_<propertyId with dashes replaced by underscores>; each reference becomes a dependency edge.",
      }),
  })
  .meta({ description: "Sandboxed mathjs expression over other property values." });

const windowSourceProperty = z
  .string({ error: "window resolver requires sourcePropertyId" })
  .meta({ description: "Property whose values are aggregated. Must not itself be a window property." });

export const tumblingWindowResolverConfigSchema = z
  .looseObject({
    type: z.literal("window"),
    sourcePropertyId: windowSourceProperty,
    kind: z.literal("tumbling"),
    windowMs: z
      .number({ error: "tumbling windowMs must be a finite number >= 1000" })
      .min(1000, { error: "tumbling windowMs must be a finite number >= 1000" })
      .meta({ description: "Bucket width in milliseconds (>= 1000)." }),
    aggregation: z
      .enum(LIVESTORE_AGGREGATIONS, { error: "tumbling aggregation must be one of sum, avg, count, min, max" })
      .meta({ description: "Aggregation applied to samples inside each bucket." }),
    alignToMs: z
      .number()
      .optional()
      .meta({ description: "Optional epoch alignment for bucket boundaries, in milliseconds." }),
  })
  .meta({ description: "Tumbling bucket aggregation: emits one value per completed bucket." });

export const ewmaWindowResolverConfigSchema = z
  .looseObject({
    type: z.literal("window"),
    sourcePropertyId: windowSourceProperty,
    kind: z.literal("ewma"),
    alpha: z
      .number({ error: "ewma alpha must be a number in (0, 1]" })
      .gt(0, { error: "ewma alpha must be a number in (0, 1]" })
      .lte(1, { error: "ewma alpha must be a number in (0, 1]" })
      .meta({ description: "Smoothing factor in (0, 1]; higher weighs recent samples more." }),
  })
  .meta({ description: "Exponentially weighted moving average over the source property." });

export const windowResolverConfigSchema = z
  .discriminatedUnion("kind", [tumblingWindowResolverConfigSchema, ewmaWindowResolverConfigSchema], {
    error: "window kind must be tumbling or ewma",
  })
  .meta({ description: "Time aggregation over one source property; state persists across restarts." });

export const rollupResolverConfigSchema = z
  .looseObject({
    type: z.literal("rollup"),
    childKind: z
      .string({ error: "rollup resolver requires childKind, relation, childProperty, and aggregation" })
      .meta({ description: "Node kind (typeRef key) of the children being aggregated." }),
    relation: z
      .string({ error: "rollup resolver requires childKind, relation, childProperty, and aggregation" })
      .meta({ description: "Entity relation from the parent's entity to the child entities." }),
    childProperty: z
      .string({ error: "rollup resolver requires childKind, relation, childProperty, and aggregation" })
      .meta({ description: "Property name read off each child node (kinds share a property schema)." }),
    aggregation: z
      .enum(LIVESTORE_AGGREGATIONS, {
        error: "rollup resolver requires childKind, relation, childProperty, and aggregation",
      })
      .meta({ description: "Aggregation across children." }),
    parent: z
      .looseObject(
        {
          model: z.string({ error: "rollup parent must include model and id" }),
          id: z.string({ error: "rollup parent must include model and id" }),
        },
        { error: "rollup parent must include model and id" },
      )
      .optional()
      .meta({ description: "Optional explicit parent entity; defaults to the node's bound entity." }),
    weightBy: z.string().optional().meta({ description: "Child property used as the weight for weighted averages." }),
  })
  .meta({ description: "Structural aggregation over child assets found via entity relations." });

export const LIVESTORE_RESOLVER_CONFIG_SCHEMAS: Record<LivestoreResolverType, z.ZodType> = {
  tag: tagResolverConfigSchema,
  metric: metricResolverConfigSchema,
  entity: entityResolverConfigSchema,
  expr: exprResolverConfigSchema,
  window: windowResolverConfigSchema,
  rollup: rollupResolverConfigSchema,
};

export function livestoreResolverConfigSchema(resolverType: string): z.ZodType | null {
  return (LIVESTORE_RESOLVER_CONFIG_SCHEMAS as Record<string, z.ZodType>)[resolverType] ?? null;
}
