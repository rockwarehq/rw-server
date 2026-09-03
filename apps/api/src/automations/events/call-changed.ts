import { type ContextBuilder, type EventSchema, statelessContextBuilder } from "@rw/automations";
import { WORK_CONTEXT_PROPS, workContextPayload } from "./work-context.js";
import type { CallEvent } from "@rw/runtime/call-events";

/** `call.changed` — a call was opened or closed. Fed by the `calls.>` stream via the automation event consumer. */
export const schema: EventSchema = {
  type: "call.changed",
  displayName: "Call Changed",
  latest: "1",
  versions: {
    "1": {
      scopeKey: "callId",
      cooldownKey: "stationId",
      payload: {
        siteId: { type: "string", title: "Site", matchable: false },
        action: { type: "string", title: "What happened", enum: ["opened", "closed"] },
        callId: { type: "string", title: "Call Id", matchable: false },
        definitionId: { type: "string", title: "Call Definition", ref: { source: "callDefinitions" } },
        definitionName: { type: "string", title: "Call Name", matchable: false },
        severity: { type: "string", title: "Severity", enum: ["INFORMATION", "ALERT", "WARNING"] },
        stationId: { type: "string", title: "Station", ref: { source: "stations" } },
        stationName: { type: "string", title: "Station Name", matchable: false },
        ...WORK_CONTEXT_PROPS,
        source: { type: "string", title: "Triggered By", enum: ["MANUAL", "SYSTEM"], matchable: false },
        sourceType: { type: "string", title: "Trigger Type", matchable: false },
        sourceRef: { type: "string", title: "Source Ref", matchable: false },
        message: { type: "string", title: "Message", matchable: false },
        openedByEmployeeId: { type: "string", title: "Opened By (Employee Id)", matchable: false },
        closedByEmployeeId: { type: "string", title: "Closed By (Employee Id)", matchable: false },
        closeMessage: { type: "string", title: "Close Message", matchable: false },
      },
    },
  },
};

export const contextBuilder: ContextBuilder = statelessContextBuilder;

export function fromCallEvent(e: CallEvent): Record<string, unknown> {
  return {
    ...workContextPayload(e),
    siteId: e.siteId,
    action: e.action,
    callId: e.callId,
    definitionId: e.definitionId,
    definitionName: e.definitionName,
    severity: e.severity,
    stationId: e.stationId,
    stationName: e.stationName,
    source: e.source,
    sourceType: e.sourceType,
    sourceRef: e.sourceRef,
    message: e.message,
    openedByEmployeeId: e.openedByEmployeeId,
    closedByEmployeeId: e.closedByEmployeeId,
    closeMessage: e.closeMessage,
  };
}
