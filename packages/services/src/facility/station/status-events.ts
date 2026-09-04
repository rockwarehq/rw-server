import prisma from "@rw/db";
import type { EventCause } from "@rw/runtime/domain-events";
import type { StationStatus, StationStatusEvent, StationStatusEventSource } from "@rw/runtime/station-status-events";
import { createEventSink, type EventSink } from "../../events/sink.js";
import { resolveShiftContext, toDateString } from "../work-context.js";

const statusEvents = createEventSink<StationStatusEvent>("station-status-events");

export type StationStatusEventSink = EventSink<StationStatusEvent>;
export const setStationStatusEventSink = statusEvents.set;
export const publishStationStatusEvent = statusEvents.publish;

export interface StatusChangeActor {
  source?: StationStatusEventSource;
  sourceType?: string;
  sourceRef?: string;
  cause?: EventCause;
}

/**
 * Publish `stations.<site>.<station>.status` for a committed change of the open row's status or
 * reason. Fire-and-forget: call after the transaction, only when something actually changed. Reads
 * the open row (the change may have been backdated or split by the time this runs) and the
 * station's context. Nothing is published when no sink is installed or the station has no open row.
 */
export async function emitStationStatusChanged(
  stationId: string,
  previous: { status: StationStatus | null; statusReasonId: string | null },
  actor: StatusChangeActor = {},
): Promise<void> {
  const [station, open] = await Promise.all([
    prisma.station.findUnique({
      where: { id: stationId },
      select: {
        name: true,
        siteId: true,
        workcenterId: true,
        currentJobId: true,
        site: { select: { workspaceId: true } },
        workcenter: { select: { name: true } },
        currentJob: { select: { currentVersion: { select: { name: true } } } },
      },
    }),
    prisma.stationStateLog.findFirst({
      where: { stationId, endTime: null, deletedAt: null },
      orderBy: { startTime: "desc" },
      select: {
        state: true,
        status: true,
        blockId: true,
        statusReasonId: true,
        statusReason: { select: { name: true } },
      },
    }),
  ]);
  if (!station || !open) return;
  const status = open.status ?? open.state;
  const now = new Date();
  const [statusSince, shift] = await Promise.all([
    findStatusSince(stationId, status, open.blockId),
    resolveShiftContext(station.siteId, station.workcenterId, now),
  ]);

  publishStationStatusEvent({
    workspaceId: station.site.workspaceId,
    siteId: station.siteId,
    stationId,
    stationName: station.name,
    state: open.state,
    status,
    previousStatus: previous.status ?? undefined,
    statusReasonId: open.statusReasonId ?? undefined,
    statusReason: open.statusReason?.name,
    previousStatusReasonId: previous.statusReasonId ?? undefined,
    statusSince: statusSince.toISOString(),
    source: actor.source ?? "SYSTEM",
    sourceType: actor.sourceType,
    sourceRef: actor.sourceRef,
    cause: actor.cause,
    workcenterId: station.workcenterId ?? undefined,
    workcenterName: station.workcenter?.name,
    jobId: station.currentJobId ?? undefined,
    jobName: station.currentJob?.currentVersion?.name,
    shiftInstanceId: shift?.id,
    shiftName: shift?.name,
    businessDate: toDateString(shift?.businessDate),
  });
}

/**
 * Start of the current status run: walk back over contiguous rows carrying the same status within
 * the same block. A new downtime always opens a new block, so a DOWN row converted in place right
 * after an earlier DOWN block does not inherit that block's start.
 */
async function findStatusSince(stationId: string, status: StationStatus, blockId: string): Promise<Date> {
  const rows = await prisma.stationStateLog.findMany({
    where: { stationId, deletedAt: null },
    orderBy: { startTime: "desc" },
    select: { state: true, status: true, blockId: true, startTime: true },
    take: 200,
  });
  let since = rows[0]?.startTime ?? new Date();
  for (const row of rows) {
    if ((row.status ?? row.state) !== status || row.blockId !== blockId) break;
    since = row.startTime;
  }
  return since;
}
