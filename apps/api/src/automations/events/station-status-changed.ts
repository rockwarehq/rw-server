import { type ContextBuilder, type EventSchema, statelessContextBuilder } from "@rw/automations";
import { WORK_CONTEXT_PROPS, workContextPayload } from "./work-context.js";
import type { StationStatusEvent } from "@rw/runtime/station-status-events";

const STATUSES = ["FAST", "SLOW", "UP", "DOWN"];

/**
 * `station.status.changed` — the open state-log row's status or reason changed. Fed by the
 * `stations.*.*.status` stream. `statusSince` anchors delayed actions, so "DOWN for 10 minutes"
 * measures from when the station went down, not from the event that armed it.
 */
export const schema: EventSchema = {
  type: "station.status.changed",
  displayName: "Station Status Changed",
  latest: "1",
  versions: {
    "1": {
      scopeKey: "stationId",
      cooldownKey: "stationId",
      sinceKey: "statusSince",
      payload: {
        siteId: { type: "string", title: "Site", matchable: false },
        stationId: { type: "string", title: "Station", ref: { source: "stations" } },
        stationName: { type: "string", title: "Station Name", matchable: false },
        state: { type: "string", title: "State", enum: ["UP", "DOWN"] },
        status: { type: "string", title: "Status", enum: STATUSES },
        previousStatus: { type: "string", title: "Previous Status", enum: STATUSES },
        statusReasonId: { type: "string", title: "Reason", ref: { source: "statusReasons" } },
        statusReason: { type: "string", title: "Reason Name", matchable: false },
        previousStatusReasonId: { type: "string", title: "Previous Reason", ref: { source: "statusReasons" } },
        statusSince: { type: "string", title: "Status Since", matchable: false },
        ...WORK_CONTEXT_PROPS,
        source: { type: "string", title: "Triggered By", enum: ["MANUAL", "SYSTEM"], matchable: false },
        sourceType: { type: "string", title: "Trigger Type", matchable: false },
        sourceRef: { type: "string", title: "Source Ref", matchable: false },
      },
    },
  },
};

export const contextBuilder: ContextBuilder = statelessContextBuilder;

export function fromStationStatusEvent(e: StationStatusEvent): Record<string, unknown> {
  return {
    ...workContextPayload(e),
    siteId: e.siteId,
    stationId: e.stationId,
    stationName: e.stationName,
    state: e.state,
    status: e.status,
    previousStatus: e.previousStatus,
    statusReasonId: e.statusReasonId,
    statusReason: e.statusReason,
    previousStatusReasonId: e.previousStatusReasonId,
    statusSince: e.statusSince,
    source: e.source,
    sourceType: e.sourceType,
    sourceRef: e.sourceRef,
  };
}
