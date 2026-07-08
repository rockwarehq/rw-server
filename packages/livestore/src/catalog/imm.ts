import { IMM_GRAPH_TYPE_NAMESPACE } from "./graph-types.js";
import type { LivestoreCatalogFragment } from "./registry.js";

// Rockware IMM catalog entries.
export const immLivestoreCatalog = {
  hookEvents: [
    {
      namespace: "imm",
      name: "cycle_completed",
      version: "1",
      displayName: "IMM Cycle Completed",
      integration: "rockware-imm",
      description: "Rockware IMM event emitted when a configured cycle-complete condition matches.",
      contextFields: {
        stationId: {
          label: "Station",
          type: "string",
          required: true,
          description: "Station entity id where the cycle completed.",
          sourceTypes: ["property"],
        },
        jobId: {
          label: "Job",
          type: "string",
          required: false,
          description: "Current job id when the cycle completed.",
          sourceTypes: ["property"],
        },
        cycleTime: {
          label: "Cycle Time",
          type: "number",
          required: false,
          description: "Cycle time captured from the graph when the event is emitted.",
          sourceTypes: ["property"],
        },
      },
    },
  ],
  graphTypeNamespaces: [IMM_GRAPH_TYPE_NAMESPACE],
} as const satisfies LivestoreCatalogFragment;
