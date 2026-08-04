import type { LivestoreCatalogFragment } from "./registry.js";

// Integration-agnostic Livestore catalog entries.
export const coreLivestoreCatalog = {
  hookEvents: [
    {
      namespace: "livestore",
      name: "hook_triggered",
      version: "1",
      displayName: "LiveStore Hook Triggered",
      integration: "livestore",
      description:
        "Generic event emitted whenever a LiveStore hook condition matches. Carries whatever context fields the hook declares, so a consumer needing arbitrary values (e.g. stored procedure parameters) does not require a catalog change.",
      contextFields: {},
      dynamicContext: true,
    },
  ],
  graphTypeNamespaces: [],
} as const satisfies LivestoreCatalogFragment;
