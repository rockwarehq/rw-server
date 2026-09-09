import {
  businessDateDim,
  callDefinitionDim,
  dispositionDim,
  dispositionReasonDim,
  employeeDim,
  enumDim,
  jobDim,
  materialDim,
  modeDim,
  orderDim,
  productDim,
  shiftDim,
  stationDim,
  statusReasonDim,
  toolDim,
  workcenterDim,
} from "./dimensions.js";
import type { DimensionDef, FactDef, MeasureDef } from "./types.js";

// One catalog entry per star-stamped fact table. Grain and caveats are stated
// in each description — they surface in the report builder UI via
// report.schema.
//
// NOTE: rows written before the star-stamps migration have NULL stamps and a
// NULL siteId on some tables — they fall out of these facts until the
// backfill script runs. Period facts clamp open rows (endTime NULL) to NOW(),
// so in-progress durations grow between queries.

/** Seconds between a period row's start and its end (open rows clamp to now). */
const periodSeconds = (start: string, end: string) =>
  `EXTRACT(EPOCH FROM (COALESCE(f."${end}", NOW()) - f."${start}"))`;

const WEIGHT_UNITS = ["KG", "LB", "G", "OZ", "MT", "TON"] as const;

// ── Net production: produced items (+) ∪ scrap dispositions (−) ──────────────
// Both tables carry the same star stamps, so the union has the full shared
// dimension set and every measure stays a plain signed sum (rollup-ready).
// Both branches require a businessDate stamp: legacy dispositions predate the
// stamps while legacy items lack siteId entirely, so unstamped rows would net
// asymmetrically (scrap counted, production not). Backfilling the stamps
// brings history into this fact on both sides at once.
const PRODUCTION_COLUMNS = `"siteId", "businessDate", "shiftInstanceId", "stationId", "workcenterId", "jobId", "productId", "toolId", "modeId", "createdAt"`;
const PRODUCTION_SOURCE = `
  SELECT ${PRODUCTION_COLUMNS}, "quantity", 'PRODUCED' AS "entryType"
  FROM "InventoryItem" WHERE "deletedAt" IS NULL AND "businessDate" IS NOT NULL
  UNION ALL
  SELECT ${PRODUCTION_COLUMNS}, -"quantity", 'SCRAPPED' AS "entryType"
  FROM "ItemDispositionLog" WHERE "deletedAt" IS NULL AND "businessDate" IS NOT NULL`;

// ── KPI facts: MetricBucket ∪ MetricBucketLog ────────────────────────────────
// Active buckets plus archived history. The NOT EXISTS guards the
// replay-unarchive window where a bucket id exists in both tables — the
// active row wins. All KPI columns are additive components; availability/
// performance/quality/OEE are ratio measures, so any slice aggregates as
// ratio-of-sums (the correct way to combine OEE — never average per-row OEEs).
const KPI_COLUMNS = `"id", "siteId", "entityId", "entityName", "granularity", "startTime", "shiftInstanceId", "businessDate", "totalCycles", "expectedCycles", "badCycles", "goodCycles", "totalItems", "badItems", "goodItems", "expectedItems", "runSeconds", "downSeconds", "plannedDownSeconds", "unplannedDownSeconds", "idealCycleSeconds", "totalCycleSeconds", "elapsedPlannedProductionSeconds"`;
const kpiSource = (entityType: string) => `
  SELECT ${KPI_COLUMNS} FROM "MetricBucket" WHERE "entityType" = '${entityType}'
  UNION ALL
  SELECT ${KPI_COLUMNS} FROM "MetricBucketLog" l
  WHERE l."entityType" = '${entityType}'
    AND NOT EXISTS (SELECT 1 FROM "MetricBucket" a WHERE a."id" = l."id")`;

const sumOf = (label: string, column: string): MeasureDef => ({ kind: "sum", label, expr: `f."${column}"` });

// Buckets carry no workcenter stamp, so workcenter-restricted principals
// narrow via a predicate instead: station buckets through the station's
// workcenter, workcenter buckets directly. JOB bucket entityIds are opaque
// hashes with no workcenter linkage — restricted principals are refused.
const KPI_WORKCENTER_PREDICATES: Record<string, string | undefined> = {
  STATION: `f."entityId" IN (SELECT "id" FROM "Station" WHERE "workcenterId" = ANY({ids}))`,
  WORKCENTER: `f."entityId" = ANY({ids})`,
  JOB: undefined,
};

function kpiFact(
  entityType: "STATION" | "WORKCENTER" | "JOB",
  label: string,
  entityDimensions: Record<string, DimensionDef>,
): FactDef {
  return {
    label,
    description:
      `Aggregated KPI buckets per ${entityType.toLowerCase()} and time window. ` +
      "Defaults to SHIFT-granularity buckets; filter granularity = HOUR (with hourly date bucketing) or DAY to change grain.",
    permission: "job:read",
    source: kpiSource(entityType),
    dateColumn: "businessDate",
    timeColumn: "startTime",
    workcenterColumn: null,
    workcenterPredicate: KPI_WORKCENTER_PREDICATES[entityType],
    defaultFilters: [{ dimension: "granularity", op: "eq", value: "SHIFT" }],
    measures: {
      totalCycles: sumOf("Total cycles", "totalCycles"),
      goodCycles: sumOf("Good cycles", "goodCycles"),
      badCycles: sumOf("Bad cycles", "badCycles"),
      expectedCycles: sumOf("Expected cycles", "expectedCycles"),
      totalItems: sumOf("Total items", "totalItems"),
      goodItems: sumOf("Good items", "goodItems"),
      badItems: sumOf("Bad items", "badItems"),
      expectedItems: sumOf("Expected items (target)", "expectedItems"),
      runSeconds: sumOf("Run (s)", "runSeconds"),
      downSeconds: sumOf("Down (s)", "downSeconds"),
      plannedDownSeconds: sumOf("Planned down (s)", "plannedDownSeconds"),
      unplannedDownSeconds: sumOf("Unplanned down (s)", "unplannedDownSeconds"),
      idealCycleSeconds: sumOf("Ideal cycle (s)", "idealCycleSeconds"),
      totalCycleSeconds: sumOf("Actual cycle (s)", "totalCycleSeconds"),
      elapsedPlannedProductionSeconds: sumOf("Planned production (s)", "elapsedPlannedProductionSeconds"),
      availability: {
        kind: "ratio",
        label: "Availability",
        numerator: "runSeconds",
        denominator: "elapsedPlannedProductionSeconds",
      },
      performance: { kind: "ratio", label: "Performance", numerator: "idealCycleSeconds", denominator: "runSeconds" },
      avgCycleSeconds: {
        kind: "ratio",
        label: "Avg cycle time (s)",
        numerator: "totalCycleSeconds",
        denominator: "totalCycles",
      },
      quality: { kind: "ratio", label: "Quality", numerator: "goodItems", denominator: "totalItems" },
      oee: {
        kind: "ratio",
        label: "OEE",
        numerator: ["idealCycleSeconds", "goodItems"],
        denominator: ["elapsedPlannedProductionSeconds", "totalItems"],
      },
    },
    dimensions: {
      businessDate: businessDateDim(),
      shift: shiftDim(),
      granularity: enumDim("Bucket granularity", "granularity", ["MINUTE", "HOUR", "SHIFT", "DAY"]),
      ...entityDimensions,
    },
  };
}

export const FACTS: Record<string, FactDef> = {
  cycles: {
    label: "Cycles",
    description: "One row per completed machine cycle recorded at a station.",
    permission: "job:read",
    table: "Cycle",
    // Cycles count when they END: in-progress rows (open/close stations keep
    // one end-NULL row per station) are excluded until they complete, matching
    // the metric-bucket convention. Stamps and hourly buckets are end-time.
    baseFilter: `f."deletedAt" IS NULL AND f."end" IS NOT NULL`,
    dateColumn: "businessDate",
    timeColumn: "end",
    workcenterColumn: "workcenterId",
    measures: {
      cycles: { kind: "count", label: "Cycles" },
      quantity: { kind: "sum", label: "Quantity", expr: `COALESCE(f."quantity", 1)` },
      goodCycles: {
        kind: "sum",
        label: "Good cycles",
        expr: `CASE WHEN f."cycleStatus" = 'GOOD' THEN 1 ELSE 0 END`,
      },
      badCycles: { kind: "sum", label: "Bad cycles", expr: `CASE WHEN f."cycleStatus" <> 'GOOD' THEN 1 ELSE 0 END` },
      cycleSeconds: {
        kind: "sum",
        label: "Cycle time (s)",
        expr: `EXTRACT(EPOCH FROM (f."end" - f."start"))`,
      },
      avgCycleSeconds: {
        kind: "avg",
        label: "Avg cycle time (s)",
        expr: `EXTRACT(EPOCH FROM (f."end" - f."start"))`,
      },
      earnedSeconds: {
        kind: "sum",
        label: "Earned standard (s)",
        expr: `COALESCE(f."standardCycle", 0)`,
        description: "Standard seconds earned by completed cycles.",
      },
      goodCycleRate: { kind: "ratio", label: "Good cycle rate", numerator: "goodCycles", denominator: "cycles" },
    },
    dimensions: {
      businessDate: businessDateDim(),
      shift: shiftDim(),
      station: stationDim(),
      workcenter: workcenterDim(),
      job: jobDim(),
      mode: modeDim(),
      cycleStatus: enumDim("Cycle status", "cycleStatus", ["GOOD", "BAD", "DISCARD"]),
    },
  },

  items: {
    label: "Produced items",
    description: "One row per product produced by a cycle; quantity is the produced amount.",
    permission: "product:read",
    table: "InventoryItem",
    baseFilter: `f."deletedAt" IS NULL`,
    dateColumn: "businessDate",
    timeColumn: "createdAt",
    workcenterColumn: "workcenterId",
    measures: {
      rows: { kind: "count", label: "Item rows" },
      quantity: { kind: "sum", label: "Produced quantity", expr: `f."quantity"` },
    },
    dimensions: {
      businessDate: businessDateDim(),
      shift: shiftDim(),
      station: stationDim(),
      workcenter: workcenterDim(),
      job: jobDim(),
      product: productDim(),
      tool: toolDim(),
      mode: modeDim(),
    },
  },

  dispositions: {
    label: "Scrap & dispositions",
    description: "One row per item disposition (scrap) entry.",
    permission: "product:read",
    table: "ItemDispositionLog",
    baseFilter: `f."deletedAt" IS NULL`,
    dateColumn: "businessDate",
    timeColumn: "createdAt",
    workcenterColumn: "workcenterId",
    measures: {
      entries: { kind: "count", label: "Entries" },
      quantity: { kind: "sum", label: "Scrapped quantity", expr: `f."quantity"` },
    },
    dimensions: {
      businessDate: businessDateDim(),
      shift: shiftDim(),
      station: stationDim(),
      workcenter: workcenterDim(),
      job: jobDim(),
      product: productDim(),
      tool: toolDim(),
      mode: modeDim(),
      disposition: dispositionDim(),
      reason: dispositionReasonDim(),
    },
  },

  statePeriods: {
    label: "Station status periods",
    description:
      "One row per station status stretch (period model). Periods spanning shift boundaries are stamped with the shift they started in.",
    // Parity with logs.downtimeSearch, which gates the same data.
    permission: "status:read",
    table: "StationStateLog",
    baseFilter: `f."deletedAt" IS NULL`,
    dateColumn: "businessDate",
    timeColumn: "startTime",
    workcenterColumn: "workcenterId",
    measures: {
      periods: { kind: "count", label: "Periods" },
      durationSeconds: { kind: "sum", label: "Duration (s)", expr: periodSeconds("startTime", "endTime") },
      avgDurationSeconds: {
        kind: "avg",
        label: "Avg duration (s)",
        expr: periodSeconds("startTime", "endTime"),
        description: "Average period length; filter state = DOWN for average downtime stretch.",
      },
      maxDurationSeconds: {
        kind: "max",
        label: "Longest period (s)",
        expr: periodSeconds("startTime", "endTime"),
      },
      downSeconds: {
        kind: "sum",
        label: "Down (s)",
        expr: `CASE WHEN f."state" = 'DOWN' THEN ${periodSeconds("startTime", "endTime")} ELSE 0 END`,
      },
      upSeconds: {
        kind: "sum",
        label: "Up (s)",
        expr: `CASE WHEN f."state" = 'UP' THEN ${periodSeconds("startTime", "endTime")} ELSE 0 END`,
      },
    },
    dimensions: {
      businessDate: businessDateDim(),
      shift: shiftDim(),
      station: stationDim(),
      workcenter: workcenterDim(),
      job: jobDim(),
      mode: modeDim(),
      state: enumDim("State", "state", ["UP", "DOWN"]),
      status: enumDim("Status", "status", ["FAST", "SLOW", "UP", "DOWN"]),
      statusReason: statusReasonDim(),
    },
  },

  modePeriods: {
    label: "Production mode periods",
    description: "One row per stretch a station spent in a production mode.",
    permission: "job:read",
    table: "StationModeLog",
    dateColumn: "businessDate",
    timeColumn: "startTime",
    workcenterColumn: "workcenterId",
    measures: {
      periods: { kind: "count", label: "Periods" },
      durationSeconds: { kind: "sum", label: "Duration (s)", expr: periodSeconds("startTime", "endTime") },
      avgDurationSeconds: { kind: "avg", label: "Avg duration (s)", expr: periodSeconds("startTime", "endTime") },
    },
    dimensions: {
      businessDate: businessDateDim(),
      shift: shiftDim(),
      station: stationDim(),
      workcenter: workcenterDim(),
      job: jobDim(),
      product: productDim(),
      tool: toolDim(),
      mode: modeDim(),
    },
  },

  jobRuns: {
    label: "Job runs",
    description: "One row per job assignment stretch on a station.",
    permission: "job:read",
    table: "StationJobLog",
    dateColumn: "businessDate",
    timeColumn: "startTime",
    workcenterColumn: "workcenterId",
    measures: {
      runs: { kind: "count", label: "Runs" },
      durationSeconds: { kind: "sum", label: "Duration (s)", expr: periodSeconds("startTime", "endTime") },
      avgDurationSeconds: { kind: "avg", label: "Avg run (s)", expr: periodSeconds("startTime", "endTime") },
    },
    dimensions: {
      businessDate: businessDateDim(),
      shift: shiftDim(),
      station: stationDim(),
      workcenter: workcenterDim(),
      job: jobDim(),
    },
  },

  logonSessions: {
    label: "Operator logons",
    description: "One row per operator logon session at a station.",
    permission: "employee:read",
    table: "StationLogonSession",
    dateColumn: "businessDate",
    timeColumn: "logonTime",
    workcenterColumn: "workcenterId",
    measures: {
      sessions: { kind: "count", label: "Sessions" },
      durationSeconds: { kind: "sum", label: "Logged on (s)", expr: periodSeconds("logonTime", "logoffTime") },
      avgDurationSeconds: { kind: "avg", label: "Avg session (s)", expr: periodSeconds("logonTime", "logoffTime") },
    },
    dimensions: {
      businessDate: businessDateDim(),
      shift: shiftDim(),
      station: stationDim(),
      workcenter: workcenterDim(),
      employee: employeeDim(),
      logonMethod: enumDim("Logon method", "logonMethod", ["EMPLOYEE_ID", "PIN", "BADGE", "GENERIC"]),
    },
  },

  calls: {
    label: "Calls",
    description: "One row per raised shop-floor call.",
    permission: "calls:read",
    table: "Call",
    baseFilter: `f."deletedAt" IS NULL`,
    dateColumn: "businessDate",
    timeColumn: "openedAt",
    workcenterColumn: "workcenterId",
    measures: {
      calls: { kind: "count", label: "Calls" },
      openSeconds: { kind: "sum", label: "Open time (s)", expr: periodSeconds("openedAt", "closedAt") },
      avgOpenSeconds: {
        kind: "avg",
        label: "Avg response (s)",
        expr: periodSeconds("openedAt", "closedAt"),
        description: "Average time from raise to close; open calls count elapsed-so-far.",
      },
      maxOpenSeconds: { kind: "max", label: "Longest open (s)", expr: periodSeconds("openedAt", "closedAt") },
    },
    dimensions: {
      businessDate: businessDateDim(),
      shift: shiftDim(),
      station: stationDim(),
      workcenter: workcenterDim(),
      job: jobDim(),
      product: productDim(),
      tool: toolDim(),
      definition: callDefinitionDim(),
      severity: enumDim("Severity", "severity", ["INFORMATION", "ALERT", "WARNING"]),
      source: enumDim("Source", "source", ["MANUAL", "SYSTEM"]),
    },
  },

  materialLedger: {
    label: "Material ledger",
    description: "One row per material quantity change (signed; PRODUCTION rows are negative).",
    permission: "product:read",
    table: "MaterialLedgerEntry",
    dateColumn: "businessDate",
    timeColumn: "createdAt",
    workcenterColumn: null,
    measures: {
      entries: { kind: "count", label: "Entries" },
      quantity: { kind: "sum", label: "Quantity (signed)", expr: `f."quantity"` },
    },
    dimensions: {
      businessDate: businessDateDim(),
      shift: shiftDim(),
      material: materialDim(),
      kind: enumDim("Kind", "kind", [
        "RECEIPT",
        "ADJUSTMENT",
        "WRITE_OFF",
        "TRANSFER_IN",
        "TRANSFER_OUT",
        "OPENING_BALANCE",
        "PRODUCTION",
      ]),
      // Always include when summing quantity — units must never sum together.
      unit: enumDim("Unit", "unit", WEIGHT_UNITS),
    },
  },

  materialUsage: {
    label: "Material usage",
    description: "One row per (shift, station, job, product, material) production consumption scope.",
    permission: "product:read",
    table: "MaterialShiftUsage",
    dateColumn: "businessDate",
    workcenterColumn: "workcenterId",
    measures: {
      quantity: { kind: "sum", label: "Consumed quantity", expr: `f."quantity"` },
      itemCount: { kind: "sum", label: "Items", expr: `f."itemCount"` },
    },
    dimensions: {
      businessDate: businessDateDim(),
      shift: shiftDim(),
      station: stationDim(),
      workcenter: workcenterDim(),
      job: jobDim(),
      product: productDim(),
      material: materialDim(),
      // Always include when summing quantity — units must never sum together.
      unit: enumDim("Unit", "unit", WEIGHT_UNITS),
    },
  },

  orderConsumptions: {
    label: "Order fulfillment",
    description: "One row per line item consumed when an order completes.",
    permission: "product:read",
    table: "OrderConsumption",
    dateColumn: "businessDate",
    timeColumn: "createdAt",
    workcenterColumn: null,
    measures: {
      lines: { kind: "count", label: "Lines" },
      quantity: { kind: "sum", label: "Consumed quantity", expr: `f."quantity"` },
    },
    dimensions: {
      businessDate: businessDateDim(),
      shift: shiftDim(),
      order: orderDim(),
      product: productDim(),
      source: enumDim("Source", "source", ["MANUAL", "AUTO", "BACKFILL"]),
    },
  },

  stockAdjustments: {
    label: "Stock adjustments",
    description: "One row per manual product on-hand correction (signed delta).",
    permission: "product:read",
    table: "ProductStockAdjustment",
    dateColumn: "businessDate",
    timeColumn: "createdAt",
    workcenterColumn: null,
    measures: {
      entries: { kind: "count", label: "Entries" },
      delta: { kind: "sum", label: "Delta (signed)", expr: `f."delta"` },
    },
    dimensions: {
      businessDate: businessDateDim(),
      shift: shiftDim(),
      product: productDim(),
      reason: enumDim("Reason", "reason", ["CYCLE_COUNT", "DAMAGE", "FOUND", "INITIAL", "OTHER"]),
    },
  },

  production: {
    label: "Net production",
    description:
      "Produced items (+) unioned with scrap dispositions (−); netQuantity nets them per slice. " +
      "Netting is per bucket, not per physical item — scrap logged against an earlier period stays " +
      "on the shift it was recorded for, so a bucket's net can go negative.",
    permission: "product:read",
    source: PRODUCTION_SOURCE,
    dateColumn: "businessDate",
    timeColumn: "createdAt",
    workcenterColumn: "workcenterId",
    measures: {
      produced: {
        kind: "sum",
        label: "Produced",
        expr: `CASE WHEN f."entryType" = 'PRODUCED' THEN f."quantity" ELSE 0 END`,
      },
      scrapped: {
        kind: "sum",
        label: "Scrapped",
        expr: `CASE WHEN f."entryType" = 'SCRAPPED' THEN -f."quantity" ELSE 0 END`,
      },
      netQuantity: { kind: "sum", label: "Net quantity", expr: `f."quantity"` },
      scrapRate: { kind: "ratio", label: "Scrap rate", numerator: "scrapped", denominator: "produced" },
    },
    dimensions: {
      businessDate: businessDateDim(),
      shift: shiftDim(),
      station: stationDim(),
      workcenter: workcenterDim(),
      job: jobDim(),
      product: productDim(),
      tool: toolDim(),
      mode: modeDim(),
      entryType: enumDim("Entry type", "entryType", ["PRODUCED", "SCRAPPED"]),
    },
  },

  stationKpis: kpiFact("STATION", "Station KPIs", { station: stationDim("entityId") }),
  workcenterKpis: kpiFact("WORKCENTER", "Workcenter KPIs", { workcenter: workcenterDim("entityId") }),
  jobKpis: kpiFact("JOB", "Job KPIs (per station)", {
    // JOB bucket entityIds are synthetic hashes of (station, job) — the
    // bucket's own entityName is the only label; there is no Job FK to join.
    jobRun: { label: "Job (per station)", column: "entityId", type: "id", nameColumn: "entityName" },
  }),
};
