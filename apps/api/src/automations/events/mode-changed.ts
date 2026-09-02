import { type ContextBuilder, type EventSchema, statelessContextBuilder } from "@rw/automations";
import type { ModeEvent } from "@rw/runtime/mode-events";

/** `mode.changed` — a station was forced into or cleared from a production mode. Fed by the `modes.>` stream. */
export const schema: EventSchema = {
  type: "mode.changed",
  displayName: "Production Mode Changed",
  latest: "1",
  versions: {
    "1": {
      scopeKey: "stationId",
      payload: {
        siteId: { type: "string", title: "Site", matchable: false },
        action: { type: "string", title: "Action", enum: ["forced", "cleared"] },
        stationId: { type: "string", title: "Station", ref: { source: "stations" } },
        stationName: { type: "string", title: "Station Name", matchable: false },
        modeId: { type: "string", title: "Production Mode", ref: { source: "productionModes" } },
        modeName: { type: "string", title: "Mode Name", matchable: false },
        logId: { type: "string", title: "Mode Log Id", matchable: false },
        source: { type: "string", title: "Source", enum: ["MANUAL", "SYSTEM"] },
        sourceType: { type: "string", title: "Source Type" },
        sourceRef: { type: "string", title: "Source Ref", matchable: false },
      },
    },
  },
};

export const contextBuilder: ContextBuilder = statelessContextBuilder;

export function fromModeEvent(e: ModeEvent): Record<string, unknown> {
  return {
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
