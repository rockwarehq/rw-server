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
      description: "Generic event emitted whenever a LiveStore hook condition matches.",
      contextFields: {},
    },
  ],
  graphTypeNamespaces: [],
} as const satisfies LivestoreCatalogFragment;
