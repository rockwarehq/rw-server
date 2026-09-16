// Every table that carries a shift stamp, named once. The re-stamp writes
// through this list, the "is this instance still in use" check reads it, and a
// new stamped table only has to be added here.

export interface StampedFact {
  table: string;
  /** SQL for the instant the row is stamped by: what decides which shift owns it. */
  at: string;
  /** Stamped per station. The rest are site-level and belong to the site schedule only. */
  byStation: boolean;
  /** The table also carries the shift's business date. */
  businessDate: boolean;
}

/** Facts placed in time, so a re-stamp can re-resolve them from the instant alone. */
export const STAMPED_FACTS: readonly StampedFact[] = [
  { table: "Cycle", at: 'COALESCE("end", "start")', byStation: true, businessDate: true },
  { table: "InventoryItem", at: '"createdAt"', byStation: true, businessDate: true },
  { table: "ItemDispositionLog", at: '"createdAt"', byStation: true, businessDate: true },
  { table: "Call", at: '"openedAt"', byStation: true, businessDate: true },
  { table: "StationModeLog", at: '"startTime"', byStation: true, businessDate: true },
  { table: "StationLogonSession", at: '"logonTime"', byStation: true, businessDate: true },
  { table: "StationStateLog", at: '"startTime"', byStation: true, businessDate: true },
  { table: "StationJobLog", at: '"startTime"', byStation: true, businessDate: true },
  { table: "MaterialLedgerEntry", at: '"createdAt"', byStation: false, businessDate: true },
  { table: "OrderConsumption", at: '"createdAt"', byStation: false, businessDate: true },
  { table: "ProductStockAdjustment", at: '"createdAt"', byStation: false, businessDate: true },
] as const;

/**
 * Totals keyed by shift rather than placed in time: there is no instant to
 * re-resolve them from, so a re-stamp leaves them alone and a reference from
 * one keeps its shift instance alive instead.
 */
const SHIFT_AGGREGATE_TABLES = ["MaterialShiftUsage"] as const;

/** Buckets name their shift in a plain column (no FK); an amendment rebuilds them outright. */
const METRIC_BUCKET_TABLES = ["MetricBucket", "MetricBucketLog"] as const;

/** Tables a re-stamp re-resolves, so a reference from one does not pin an obsolete row. */
export const RESTAMPED_TABLES: readonly string[] = STAMPED_FACTS.map((f) => f.table);

/**
 * Everything that references a ShiftInstance. A row referenced by any of these
 * is "in use" and must survive rematerialization — deleting it would SET NULL
 * (or cascade-delete, for the aggregates) the shift dimension on history.
 */
export const SHIFT_REFERENCING_TABLES: readonly string[] = [
  ...METRIC_BUCKET_TABLES,
  ...RESTAMPED_TABLES,
  ...SHIFT_AGGREGATE_TABLES,
];

export const isMetricBucketTable = (table: string) => table.startsWith("MetricBucket");
