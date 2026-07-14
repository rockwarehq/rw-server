import { z } from "zod";
import { ORPCError } from "@orpc/server";
import prisma from "@rw/db";
import {
  decodeCursor,
  encodeCursor,
  getSeries,
  isHistorianError,
  type ResolvedRange,
  type SeriesDefinition,
  type ShiftWindow,
} from "@rw/historian";
import { Principal } from "../auth/index.js";
import { userOrDisplayRequired } from "./middleware.js";
import { throwServiceError } from "./errors.js";

// Historian series queries (ADR 0008): `query` returns a range snapshot plus
// an opaque cursor; `changes` replays revisions since the cursor as full-row
// idempotent upserts / soft-delete tombstones. The handlers are generic
// dispatchers over the series registry — adding a series type is one
// definition file, one registry entry, and one member of the selector union
// below (the union is what types the published rpc-client).

// ============================================================================
// Input Schemas
// ============================================================================

const seriesSelectorSchema = z.discriminatedUnion("seriesType", [
  z.object({
    seriesType: z.literal("stationState"),
    siteId: z.uuid(),
    stationId: z.uuid(),
  }),
]);

type SeriesSelector = z.infer<typeof seriesSelectorSchema>;

const rangeSchema = z.union([
  // to: null = open-ended forward — new rows arrive as ordinary upserts.
  z.object({ from: z.coerce.date(), to: z.coerce.date().nullable() }),
  z.object({ lastSeconds: z.number().int().positive() }),
  z.object({ shift: z.literal("current") }),
]);

const queryInputSchema = z.object({
  series: seriesSelectorSchema,
  range: rangeSchema,
  limit: z.number().int().min(1).max(1000).default(500),
  pageToken: z.string().optional(),
});

const changesInputSchema = z.object({
  series: seriesSelectorSchema,
  cursor: z.string(),
  limit: z.number().int().min(1).max(1000).default(500),
});

// ============================================================================
// Shared authorization (pattern from metrics.ts)
// ============================================================================

async function assertSiteAccess(siteId: string, workspaceId: string): Promise<void> {
  const site = await prisma.site.findUnique({
    where: { id: siteId },
    select: { workspaceId: true },
  });

  if (!site) {
    throw new ORPCError("NOT_FOUND", { message: "Site not found" });
  }

  if (site.workspaceId !== workspaceId) {
    throw new ORPCError("FORBIDDEN", { message: "Site does not belong to this workspace" });
  }
}

async function assertRuntimeSiteAccess(
  iam: { principal: string; workspaceId?: string; siteId?: string },
  siteId: string,
): Promise<void> {
  if (iam.principal === Principal.DISPLAY) {
    if (iam.siteId !== siteId) {
      throw new ORPCError("FORBIDDEN", { message: "Display can only access history for its site" });
    }

    return;
  }

  if (!iam.workspaceId) {
    throw new ORPCError("UNAUTHORIZED", { message: "Workspace context required" });
  }

  await assertSiteAccess(siteId, iam.workspaceId);
}

/**
 * Every verb re-validates caller↔site access and scope↔site consistency —
 * a forged or replayed cursor can only reach data the caller may read anyway.
 */
async function authorizeSeries(
  iam: { principal: string; workspaceId?: string; siteId?: string },
  series: SeriesSelector,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<SeriesDefinition<any, any>> {
  await assertRuntimeSiteAccess(iam, series.siteId);

  const definition = getSeries(series.seriesType);
  if (!definition) {
    throw new ORPCError("BAD_REQUEST", { message: `Unknown series type: ${series.seriesType}` });
  }

  const scope = await definition.assertScope(series);
  if (isHistorianError(scope)) throwServiceError(scope);

  return definition;
}

// ============================================================================
// Range resolution — relative windows resolve server-side exactly once
// ============================================================================

type ResolvedWindow = {
  range: ResolvedRange;
  shift: ShiftWindow | null;
};

async function resolveRange(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  definition: SeriesDefinition<any, any>,
  series: SeriesSelector,
  range: z.infer<typeof rangeSchema>,
): Promise<ResolvedWindow | null> {
  if ("shift" in range) {
    const window = await definition.resolveCurrentShift(series);
    if (isHistorianError(window)) throwServiceError(window);
    if (!window) return null;
    return { range: window.range, shift: window };
  }

  if ("lastSeconds" in range) {
    return {
      range: { from: new Date(Date.now() - range.lastSeconds * 1000), to: null },
      shift: null,
    };
  }

  if (range.to && range.to.getTime() <= range.from.getTime()) {
    throw new ORPCError("BAD_REQUEST", { message: "Range end must be after range start" });
  }

  return { range: { from: range.from, to: range.to }, shift: null };
}

function shiftMeta(shift: ShiftWindow | null) {
  if (!shift) return null;
  return {
    shiftInstanceId: shift.shiftInstanceId,
    shiftName: shift.shiftName,
    shiftStart: shift.shiftStart,
    shiftEnd: shift.shiftEnd,
  };
}

async function dbNowMs(): Promise<number> {
  const [{ now }] = await prisma.$queryRaw<[{ now: Date }]>`SELECT now() AS now`;
  return now.getTime();
}

// ============================================================================
// Verbs
// ============================================================================

export const query = userOrDisplayRequired.input(queryInputSchema).handler(async ({ context, input }) => {
  const definition = await authorizeSeries(context.iam, input.series);

  const window = await resolveRange(definition, input.series, input.range);
  if (!window) {
    // A relative window with nothing to resolve (no active shift): an empty
    // snapshot with no cursor. The client re-queries when a shift starts.
    return {
      resolvedRange: null,
      shift: null,
      rows: [],
      nextPageToken: null,
      cursor: null,
    };
  }

  // The change cursor is stamped at first-page time; rows that mutate while
  // the client pages through the snapshot are redelivered by the first
  // `changes` call.
  const cursor = input.pageToken
    ? null
    : encodeCursor(input.series.seriesType, input.series, window.range, await dbNowMs());

  const page = await definition.fetchRange(input.series, window.range, {
    limit: input.limit,
    pageToken: input.pageToken ?? null,
  });
  if (isHistorianError(page)) throwServiceError(page);

  return {
    resolvedRange: window.range,
    shift: shiftMeta(window.shift),
    rows: page.rows,
    nextPageToken: page.nextPageToken,
    cursor,
  };
});

export const changes = userOrDisplayRequired.input(changesInputSchema).handler(async ({ context, input }) => {
  const definition = await authorizeSeries(context.iam, input.series);

  const decoded = decodeCursor(input.cursor, input.series.seriesType, input.series, Date.now());
  if (isHistorianError(decoded)) throwServiceError(decoded);

  const result = await definition.fetchChanges(input.series, decoded.range, decoded.watermarkMs, input.limit);
  if (isHistorianError(result)) throwServiceError(result);

  return {
    deltas: result.deltas,
    cursor: encodeCursor(input.series.seriesType, input.series, decoded.range, result.nextWatermarkMs),
    hasMore: result.hasMore,
  };
});
