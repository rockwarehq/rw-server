// Historian series queries (ADR 0008): a series is a range-queryable view of
// IMM history with a shared delta contract — an initial range query returns a
// snapshot plus an opaque cursor, and `changes` replays revisions since the
// cursor as full-row idempotent upserts (or soft-delete tombstones).

/** Services never throw (ADR 0003); historian functions return this on failure. */
export type HistorianError = { error: string; code: string };

export function isHistorianError(value: unknown): value is HistorianError {
  return typeof value === "object" && value !== null && "error" in value && "code" in value;
}

/**
 * A relative window resolves server-side exactly once into this fixed range.
 * `to: null` = open-ended forward: new rows fall inside the range and arrive
 * as ordinary upserts. The server never re-resolves a range against a cursor.
 */
export interface ResolvedRange {
  from: Date;
  to: Date | null;
}

/** Shift metadata attached when a `{ shift: "current" }` window resolves. */
export interface ShiftWindow {
  range: ResolvedRange;
  shiftInstanceId: string;
  shiftName: string;
  shiftStart: Date;
  shiftEnd: Date;
}

export interface SeriesPage<Row> {
  rows: Row[];
  nextPageToken: string | null;
}

export interface SeriesDelta<Row> {
  /** "delete" means deletedAt was set — the row is still delivered in full. */
  op: "upsert" | "delete";
  row: Row;
}

export interface SeriesChanges<Row> {
  deltas: SeriesDelta<Row>[];
  /** Epoch-ms change-timestamp frontier for the next cursor. */
  nextWatermarkMs: number;
  hasMore: boolean;
}

/**
 * One registered series type. Input schemas live at the RPC boundary (the
 * discriminated union is what types the published rpc-client); definitions
 * own scope authorization, window resolution, and the two fetch verbs.
 */
export interface SeriesDefinition<Scope, Row> {
  seriesType: string;
  /** Server-side poll cadence for a future `subscribe` loop. */
  pollIntervalMs: number;
  /**
   * Re-validated on every call: the scope's entities must belong to
   * `scope.siteId` (caller↔site access is asserted separately at the RPC
   * boundary; this guards against a foreign entity id under an accessible
   * siteId).
   */
  assertScope(scope: Scope): Promise<HistorianError | { ok: true }>;
  /** Resolve `{ shift: "current" }` for this scope; null = no active shift. */
  resolveCurrentShift(scope: Scope): Promise<ShiftWindow | null | HistorianError>;
  fetchRange(
    scope: Scope,
    range: ResolvedRange,
    page: { limit: number; pageToken?: string | null },
  ): Promise<SeriesPage<Row> | HistorianError>;
  /**
   * Rows whose change timestamp is past the watermark minus the overlap
   * window. At-least-once: bounded redelivery is expected and harmless under
   * the idempotent-upsert contract.
   */
  fetchChanges(
    scope: Scope,
    range: ResolvedRange,
    watermarkMs: number,
    limit: number,
  ): Promise<SeriesChanges<Row> | HistorianError>;
}
