export const METRIC_CATALOG_ENTITY_TYPES = ["STATION", "WORKCENTER", "SITE", "JOB"] as const;
export const METRIC_CATALOG_GRANULARITIES = ["MINUTE", "HOUR", "SHIFT", "DAY", "LIVE"] as const;
export const METRIC_CATALOG_VALUE_TYPES = ["number", "percent", "duration", "count", "string"] as const;
export const METRIC_CATALOG_DEFAULT_AGGREGATIONS = ["latest", "sum", "avg", "min", "max"] as const;

export type MetricCatalogEntityType = (typeof METRIC_CATALOG_ENTITY_TYPES)[number];
export type MetricCatalogGranularity = (typeof METRIC_CATALOG_GRANULARITIES)[number];
export type MetricCatalogValueType = (typeof METRIC_CATALOG_VALUE_TYPES)[number];
export type MetricCatalogDefaultAggregation = (typeof METRIC_CATALOG_DEFAULT_AGGREGATIONS)[number];

export interface MetricCatalogDefinition {
  key: string;
  label: string;
  description?: string | null;
  unit?: string | null;
  valueType: MetricCatalogValueType;
  granularities: readonly MetricCatalogGranularity[];
  entityTypes: readonly MetricCatalogEntityType[];
  defaultAggregation?: MetricCatalogDefaultAggregation;
}

const ENTITY_TYPE_SET = new Set<string>(METRIC_CATALOG_ENTITY_TYPES);
const GRANULARITY_SET = new Set<string>(METRIC_CATALOG_GRANULARITIES);
const VALUE_TYPE_SET = new Set<string>(METRIC_CATALOG_VALUE_TYPES);
const DEFAULT_AGGREGATION_SET = new Set<string>(METRIC_CATALOG_DEFAULT_AGGREGATIONS);

const STANDARD_GRANULARITIES = ["HOUR", "SHIFT", "DAY"] as const;
const ALL_ENTITY_TYPES = ["STATION", "WORKCENTER", "SITE", "JOB"] as const;

export const METRIC_CATALOG_REGISTRY = [
  {
    key: "status",
    label: "Status",
    description: "Current live station status",
    valueType: "string",
    granularities: ["LIVE"],
    entityTypes: ["STATION"],
    defaultAggregation: "latest",
  },
  {
    key: "statusReason",
    label: "Status Reason",
    description: "Status reason id on the currently open state log row",
    valueType: "string",
    granularities: ["LIVE"],
    entityTypes: ["STATION"],
    defaultAggregation: "latest",
  },
  {
    key: "currentJob",
    label: "Current Job",
    description: "Name of the job currently running on the station",
    valueType: "string",
    granularities: ["LIVE"],
    entityTypes: ["STATION"],
    defaultAggregation: "latest",
  },
  {
    key: "currentLogons",
    label: "Current Logons",
    description: "Comma-separated names of operators currently logged on at the station; null when no active logons",
    valueType: "string",
    granularities: ["LIVE"],
    entityTypes: ["STATION"],
    defaultAggregation: "latest",
  },
  {
    key: "currentShift",
    label: "Current Shift",
    description: "Name of the shift currently active on the entity",
    valueType: "string",
    granularities: ["LIVE"],
    entityTypes: ["STATION", "WORKCENTER"],
    defaultAggregation: "latest",
  },
  {
    key: "currentShiftInstanceId",
    label: "Current Shift Instance ID",
    description: "ShiftInstance UUID currently active on the entity",
    valueType: "string",
    granularities: ["LIVE"],
    entityTypes: ["STATION", "WORKCENTER"],
    defaultAggregation: "latest",
  },
  {
    key: "lastCycleSeconds",
    label: "Last Cycle Time",
    description: "Duration in seconds of the most recent completed cycle on the station",
    unit: "sec",
    valueType: "duration",
    granularities: ["LIVE"],
    entityTypes: ["STATION"],
    defaultAggregation: "latest",
  },
  {
    key: "standardCycleSeconds",
    label: "Standard Cycle Time",
    description: "Standard cycle time in seconds for the job currently running on the station",
    unit: "sec",
    valueType: "duration",
    granularities: ["LIVE"],
    entityTypes: ["STATION"],
    defaultAggregation: "latest",
  },
  {
    key: "currentStandardCycle",
    label: "Current Standard Cycle",
    description: "Standard cycle (seconds) of the job running at the end of the bucket window",
    unit: "sec",
    valueType: "duration",
    granularities: STANDARD_GRANULARITIES,
    entityTypes: ALL_ENTITY_TYPES,
    defaultAggregation: "latest",
  },
  {
    key: "oee",
    label: "OEE",
    description: "Overall equipment effectiveness ratio",
    unit: "%",
    valueType: "percent",
    granularities: STANDARD_GRANULARITIES,
    entityTypes: ALL_ENTITY_TYPES,
    defaultAggregation: "avg",
  },
  {
    key: "availability",
    label: "Availability",
    description: "Share of planned time spent running",
    unit: "%",
    valueType: "percent",
    granularities: STANDARD_GRANULARITIES,
    entityTypes: ALL_ENTITY_TYPES,
    defaultAggregation: "avg",
  },
  {
    key: "performance",
    label: "Performance",
    description: "Speed efficiency compared to ideal cycle time",
    unit: "%",
    valueType: "percent",
    granularities: STANDARD_GRANULARITIES,
    entityTypes: ALL_ENTITY_TYPES,
    defaultAggregation: "avg",
  },
  {
    key: "quality",
    label: "Quality",
    description: "Share of produced items that are good",
    unit: "%",
    valueType: "percent",
    granularities: STANDARD_GRANULARITIES,
    entityTypes: ALL_ENTITY_TYPES,
    defaultAggregation: "avg",
  },
  {
    key: "runSeconds",
    label: "Run Time",
    description: "Seconds spent in UP state",
    unit: "sec",
    valueType: "duration",
    granularities: STANDARD_GRANULARITIES,
    entityTypes: ALL_ENTITY_TYPES,
    defaultAggregation: "sum",
  },
  {
    key: "downSeconds",
    label: "Down Time",
    description: "Seconds spent in DOWN state",
    unit: "sec",
    valueType: "duration",
    granularities: STANDARD_GRANULARITIES,
    entityTypes: ALL_ENTITY_TYPES,
    defaultAggregation: "sum",
  },
  {
    key: "plannedDownSeconds",
    label: "Planned Downtime",
    description: "Down seconds with planned downtime reason",
    unit: "sec",
    valueType: "duration",
    granularities: STANDARD_GRANULARITIES,
    entityTypes: ALL_ENTITY_TYPES,
    defaultAggregation: "sum",
  },
  {
    key: "unplannedDownSeconds",
    label: "Unplanned Downtime",
    description: "Down seconds without planned downtime reason",
    unit: "sec",
    valueType: "duration",
    granularities: STANDARD_GRANULARITIES,
    entityTypes: ALL_ENTITY_TYPES,
    defaultAggregation: "sum",
  },
  {
    key: "goodCycles",
    label: "Good Cycles",
    description: "Count of good completed cycles",
    valueType: "count",
    granularities: STANDARD_GRANULARITIES,
    entityTypes: ALL_ENTITY_TYPES,
    defaultAggregation: "sum",
  },
  {
    key: "badCycles",
    label: "Bad Cycles",
    description: "Count of bad completed cycles",
    valueType: "count",
    granularities: STANDARD_GRANULARITIES,
    entityTypes: ALL_ENTITY_TYPES,
    defaultAggregation: "sum",
  },
  {
    key: "totalCycles",
    label: "Total Cycles",
    description: "Count of all completed cycles",
    valueType: "count",
    granularities: STANDARD_GRANULARITIES,
    entityTypes: ALL_ENTITY_TYPES,
    defaultAggregation: "sum",
  },
  {
    key: "expectedCycles",
    label: "Expected Cycles",
    description: "Expected cycle count for the bucket window",
    valueType: "count",
    granularities: STANDARD_GRANULARITIES,
    entityTypes: ALL_ENTITY_TYPES,
    defaultAggregation: "sum",
  },
  {
    key: "idealCycleSeconds",
    label: "Ideal Cycle Time",
    description: "Sum of ideal cycle seconds",
    unit: "sec",
    valueType: "duration",
    granularities: STANDARD_GRANULARITIES,
    entityTypes: ALL_ENTITY_TYPES,
    defaultAggregation: "sum",
  },
  {
    key: "totalCycleSeconds",
    label: "Actual Cycle Time",
    description: "Sum of actual cycle seconds",
    unit: "sec",
    valueType: "duration",
    granularities: STANDARD_GRANULARITIES,
    entityTypes: ALL_ENTITY_TYPES,
    defaultAggregation: "sum",
  },
  {
    key: "totalItems",
    label: "Total Items",
    description: "Count of all produced items",
    valueType: "count",
    granularities: STANDARD_GRANULARITIES,
    entityTypes: ALL_ENTITY_TYPES,
    defaultAggregation: "sum",
  },
  {
    key: "goodItems",
    label: "Good Items",
    description: "Count of good produced items",
    valueType: "count",
    granularities: STANDARD_GRANULARITIES,
    entityTypes: ALL_ENTITY_TYPES,
    defaultAggregation: "sum",
  },
  {
    key: "badItems",
    label: "Bad Items",
    description: "Count of bad produced items",
    valueType: "count",
    granularities: STANDARD_GRANULARITIES,
    entityTypes: ALL_ENTITY_TYPES,
    defaultAggregation: "sum",
  },
  {
    key: "expectedItems",
    label: "Expected Items",
    description: "Expected produced item count for the bucket window",
    valueType: "count",
    granularities: STANDARD_GRANULARITIES,
    entityTypes: ALL_ENTITY_TYPES,
    defaultAggregation: "sum",
  },
] as const satisfies ReadonlyArray<MetricCatalogDefinition>;

export function validateMetricCatalogRegistry(registry: readonly MetricCatalogDefinition[]): void {
  const seenKeys = new Set<string>();

  for (const definition of registry) {
    if (seenKeys.has(definition.key)) {
      throw new Error(`Duplicate metric catalog key: ${definition.key}`);
    }
    seenKeys.add(definition.key);

    if (!VALUE_TYPE_SET.has(definition.valueType)) {
      throw new Error(`Invalid metric valueType for key '${definition.key}': ${definition.valueType}`);
    }

    if (definition.defaultAggregation && !DEFAULT_AGGREGATION_SET.has(definition.defaultAggregation)) {
      throw new Error(
        `Invalid metric defaultAggregation for key '${definition.key}': ${definition.defaultAggregation}`,
      );
    }

    if (definition.granularities.length === 0) {
      throw new Error(`Metric '${definition.key}' must declare at least one granularity`);
    }

    for (const granularity of definition.granularities) {
      if (!GRANULARITY_SET.has(granularity)) {
        throw new Error(`Invalid metric granularity for key '${definition.key}': ${granularity}`);
      }
    }

    if (definition.entityTypes.length === 0) {
      throw new Error(`Metric '${definition.key}' must declare at least one entity type`);
    }

    for (const entityType of definition.entityTypes) {
      if (!ENTITY_TYPE_SET.has(entityType)) {
        throw new Error(`Invalid metric entityType for key '${definition.key}': ${entityType}`);
      }
    }
  }
}

validateMetricCatalogRegistry(METRIC_CATALOG_REGISTRY);
