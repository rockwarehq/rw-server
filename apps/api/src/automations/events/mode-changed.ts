import { type ContextBuilder, type EventSchema, statelessContextBuilder } from "@rw/automations";
import { WORK_CONTEXT_PROPS, workContextPayload } from "./work-context.js";
import type { ModeEvent } from "@rw/runtime/mode-events";

/** `mode.changed` — a station was forced into or cleared from a production mode. Fed by the `modes.>` stream. */
export const schema: EventSchema = {
  type: "mode.changed",
  displayName: "Production Mode Changed",
  latest: "1",
  versions: {
    "1": {
      scopeKey: "stationId",
      cooldownKey: "stationId",
      payload: {
        siteId: { type: "string", title: "Site", matchable: false },
        action: { type: "string", title: "What happened", enum: ["forced", "cleared"] },
        stationId: { type: "string", title: "Station", ref: { source: "stations" } },
        stationName: { type: "string", title: "Station Name", matchable: false },
        ...WORK_CONTEXT_PROPS,
        modeId: { type: "string", title: "Production Mode", ref: { source: "productionModes" } },
        modeName: { type: "string", title: "Mode Name", matchable: false },
        logId: { type: "string", title: "Mode Log Id", matchable: false },
        source: { type: "string", title: "Triggered By", enum: ["MANUAL", "SYSTEM"], matchable: false },
        sourceType: { type: "string", title: "Trigger Type", matchable: false },
        sourceRef: { type: "string", title: "Source Ref", matchable: false },
      },
    },
  },
};

export const contextBuilder: ContextBuilder = statelessContextBuilder;

export function fromModeEvent(e: ModeEvent): Record<string, unknown> {
  return {
    ...workContextPayload(e),
    siteId: e.siteId,
    action: e.action,
    stationId: e.stationId,
    stationName: e.stationName,
    modeId: e.modeId,
    modeName: e.modeName,
    logId: e.logId,
    source: e.source,
    sourceType: e.sourceType,
    sourceRef: e.sourceRef,
  };
}
