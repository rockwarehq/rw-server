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
import type { FactDef } from "./types.js";

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

export const FACTS: Record<string, FactDef> = {
  cycles: {
    label: "Cycles",
    description: "One row per machine cycle recorded at a station.",
    table: "Cycle",
    baseFilter: `f."deletedAt" IS NULL`,
    dateColumn: "businessDate",
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
        expr: `COALESCE(EXTRACT(EPOCH FROM (f."end" - f."start")), 0)`,
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
    table: "InventoryItem",
    baseFilter: `f."deletedAt" IS NULL`,
    dateColumn: "businessDate",
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
    table: "ItemDispositionLog",
    baseFilter: `f."deletedAt" IS NULL`,
    dateColumn: "businessDate",
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
    table: "StationStateLog",
    baseFilter: `f."deletedAt" IS NULL`,
    dateColumn: "businessDate",
    workcenterColumn: "workcenterId",
    measures: {
      periods: { kind: "count", label: "Periods" },
      durationSeconds: { kind: "sum", label: "Duration (s)", expr: periodSeconds("startTime", "endTime") },
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
    table: "StationModeLog",
    dateColumn: "businessDate",
    workcenterColumn: "workcenterId",
    measures: {
      periods: { kind: "count", label: "Periods" },
      durationSeconds: { kind: "sum", label: "Duration (s)", expr: periodSeconds("startTime", "endTime") },
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
    table: "StationJobLog",
    dateColumn: "businessDate",
    workcenterColumn: "workcenterId",
    measures: {
      runs: { kind: "count", label: "Runs" },
      durationSeconds: { kind: "sum", label: "Duration (s)", expr: periodSeconds("startTime", "endTime") },
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
    table: "StationLogonSession",
    dateColumn: "businessDate",
    workcenterColumn: "workcenterId",
    measures: {
      sessions: { kind: "count", label: "Sessions" },
      durationSeconds: { kind: "sum", label: "Logged on (s)", expr: periodSeconds("logonTime", "logoffTime") },
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
    table: "Call",
    baseFilter: `f."deletedAt" IS NULL`,
    dateColumn: "businessDate",
    workcenterColumn: "workcenterId",
    measures: {
      calls: { kind: "count", label: "Calls" },
      openSeconds: { kind: "sum", label: "Open time (s)", expr: periodSeconds("openedAt", "closedAt") },
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
    table: "MaterialLedgerEntry",
    dateColumn: "businessDate",
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
    },
  },

  materialUsage: {
    label: "Material usage",
    description: "One row per (shift, station, job, product, material) production consumption scope.",
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
    },
  },

  orderConsumptions: {
    label: "Order fulfillment",
    description: "One row per line item consumed when an order completes.",
    table: "OrderConsumption",
    dateColumn: "businessDate",
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
    table: "ProductStockAdjustment",
    dateColumn: "businessDate",
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
};
