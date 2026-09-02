import type { ActionHandler } from "@rw/automations";
import { productionMode } from "@rw/services/facility/index";
import { STATION_INPUT, stationFrom, systemSource, unwrapService } from "./shared.js";

export const handler: ActionHandler = {
  type: "forceMode",
  displayName: "Force Production Mode",
  latest: "1",
  versions: {
    "1": {
      inputSchema: {
        required: ["modeId"],
        properties: {
          modeId: { type: "string", title: "Production Mode", ref: { source: "productionModes" } },
          stationId: STATION_INPUT,
        },
      },
      async run(inputs, ctx) {
        unwrapService(
          await productionMode.force({
            stationId: stationFrom(inputs, ctx),
            modeId: String(inputs.modeId),
            ...systemSource(ctx),
          }),
        );
      },
    },
  },
};
