import type { ActionHandler } from "@rw/automations";
import { productionMode } from "@rw/services/facility/index";
import { STATION_INPUT, stationFrom, systemSource, unwrapService } from "./shared.js";

export const handler: ActionHandler = {
  type: "clearMode",
  displayName: "Clear Production Mode",
  latest: "1",
  versions: {
    "1": {
      inputSchema: { required: [], properties: { stationId: STATION_INPUT } },
      async run(inputs, ctx) {
        unwrapService(await productionMode.clear({ stationId: stationFrom(inputs, ctx), ...systemSource(ctx) }));
      },
    },
  },
};
