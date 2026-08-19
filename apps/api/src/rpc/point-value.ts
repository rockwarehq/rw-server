import { ORPCError, eventIterator } from "@orpc/server";
import * as z from "zod";
import {
  getLatestPointSnapshots,
  validatePointSiteAccess,
  type ValidatePointSiteAccessResult,
} from "../services/point-value.js";
import { authorizeList } from "@rw/auth/iam/policy";
import { grant } from "./authz.js";
import { subscribeStreamEvents, type PointValueEvent, type StreamEvent } from "@rw/runtime/events-bus";
import { throwServiceError, type CodeOverrides } from "./errors.js";
import { userOrDisplayRequired } from "./middleware.js";

const pointIdsInputSchema = z.object({
  pointIds: z.array(z.uuid()).min(1).max(500),
});

const pointSnapshotSchema = z.object({
  pointId: z.uuid(),
  quality: z.enum(["GOOD", "BAD", "UNKNOWN"]),
  value: z.number().nullable(),
  valueRaw: z.unknown(),
  previousValue: z.number().nullable(),
  previousValueRaw: z.unknown(),
  timestamp: z.iso.datetime(),
  gatewayTimestamp: z.iso.datetime(),
  processorTimestamp: z.iso.datetime(),
});

const getSnapshotsOutputSchema = z.object({
  snapshots: z.record(z.string(), pointSnapshotSchema),
});

const pointValueStreamPayloadSchema = z.object({
  pointId: z.uuid(),
  valueRaw: z.unknown(),
  previousValueRaw: z.unknown().optional(),
  quality: z.enum(["GOOD", "BAD", "UNKNOWN"]),
  value: z.number().optional(),
  previousValue: z.number().optional(),
  timestamp: z.iso.datetime(),
  gatewayTimestamp: z.iso.datetime(),
});

const pointValueStreamEventSchema = z.object({
  id: z.uuid(),
  type: z.literal("PointValue"),
  gatewayId: z.uuid(),
  workspaceId: z.uuid().nullable(),
  receivedAt: z.iso.datetime(),
  payload: pointValueStreamPayloadSchema,
});

function dedupePointIds(pointIds: string[]): string[] {
  return Array.from(new Set(pointIds));
}

// Historical mapping: a display asking for points outside its site is an access
// denial (FORBIDDEN) here, not the shared SITE_MISMATCH -> CONFLICT default.
const POINT_ACCESS_OVERRIDES: CodeOverrides = { SITE_MISMATCH: "FORBIDDEN" };

export async function* filterPointValueEvents(
  events: AsyncIterable<StreamEvent>,
  workspaceId: string,
  pointIds: ReadonlySet<string>,
): AsyncGenerator<PointValueEvent> {
  for await (const event of events) {
    if (event.type !== "PointValue") {
      continue;
    }

    if (event.workspaceId !== workspaceId) {
      continue;
    }

    if (!pointIds.has(event.payload.pointId)) {
      continue;
    }

    yield event;
  }
}

export const getSnapshots = userOrDisplayRequired
  .input(pointIdsInputSchema)
  .output(getSnapshotsOutputSchema)
  .handler(async ({ context, input }) => {
    const pointIds = dedupePointIds(input.pointIds);
    // Displays are pinned to their own site by the policy; site-scoped users
    // must have every point inside an accessible site; all-sites users keep
    // the existence/workspace validation.
    const scope = grant(await authorizeList(context.iam, { permission: "facility:read" }));
    const accessValidationResult: ValidatePointSiteAccessResult = await validatePointSiteAccess(pointIds, scope.siteId);

    if (!accessValidationResult.success) {
      throwServiceError(accessValidationResult, POINT_ACCESS_OVERRIDES);
    }

    const snapshots = await getLatestPointSnapshots(pointIds);

    return { snapshots };
  });

export const stream = userOrDisplayRequired
  .input(pointIdsInputSchema)
  .output(eventIterator(pointValueStreamEventSchema))
  .handler(async function* ({ context, input, signal }) {
    const pointIds = dedupePointIds(input.pointIds);
    // Displays are pinned to their own site by the policy; site-scoped users
    // must have every point inside an accessible site; all-sites users keep
    // the existence/workspace validation.
    const scope = grant(await authorizeList(context.iam, { permission: "facility:read" }));
    const accessValidationResult: ValidatePointSiteAccessResult = await validatePointSiteAccess(pointIds, scope.siteId);

    if (!accessValidationResult.success) {
      throwServiceError(accessValidationResult, POINT_ACCESS_OVERRIDES);
    }

    const workspaceId = context.iam.workspaceId;
    if (!workspaceId) {
      throw new ORPCError("UNAUTHORIZED", { message: "Workspace context required" });
    }

    const subscribedPointIds = new Set(pointIds);

    for await (const event of filterPointValueEvents(
      subscribeStreamEvents({ signal }),
      workspaceId,
      subscribedPointIds,
    )) {
      yield event;
    }
  });
