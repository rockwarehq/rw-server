import type { ActionHandler } from "@rw/automations";
import { call } from "@rw/services/facility/index";
import { STATION_INPUT, stationFrom, systemSource, unwrapService } from "./shared.js";

/** Closes the open call of a definition at a station. No open call = nothing to do. */
export const handler: ActionHandler = {
  type: "closeCall",
  displayName: "Close Call",
  latest: "1",
  versions: {
    "1": {
      inputSchema: {
        required: ["definitionId"],
        properties: {
          definitionId: { type: "string", title: "Call", ref: { source: "callDefinitions" } },
          stationId: STATION_INPUT,
          closeMessage: {
            type: "string",
            title: "Close Message",
            description: "Supports {{event.payload.*}} variables.",
          },
        },
      },
      async run(inputs, ctx) {
        const { data } = await call.listActive({
          stationId: stationFrom(inputs, ctx),
          definitionId: String(inputs.definitionId),
          limit: 1,
        });
        const open = data[0];
        if (!open) return;
        const { cause } = systemSource(ctx);
        unwrapService(
          await call.close({
            id: open.id,
            closeMessage: inputs.closeMessage ? String(inputs.closeMessage) : undefined,
            bypassAnswerRoles: true,
            cause,
          }),
        );
      },
    },
  },
};
