import type { ActionHandler } from "@rw/automations";
import { call } from "@rw/services/facility/index";
import { STATION_INPUT, stationFrom, systemSource, unwrapService } from "./shared.js";

export const handler: ActionHandler = {
  type: "openCall",
  displayName: "Open Call",
  latest: "1",
  versions: {
    "1": {
      inputSchema: {
        required: ["definitionId"],
        properties: {
          definitionId: { type: "string", title: "Call", ref: { source: "callDefinitions" } },
          stationId: STATION_INPUT,
          message: { type: "string", title: "Message", description: "Supports {{event.payload.*}} variables." },
        },
      },
      async run(inputs, ctx) {
        unwrapService(
          await call.open({
            stationId: stationFrom(inputs, ctx),
            definitionId: String(inputs.definitionId),
            message: inputs.message ? String(inputs.message) : undefined,
            ...systemSource(ctx),
          }),
        );
      },
    },
  },
};
