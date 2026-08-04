import { z } from "zod";
import type { ExecutionLocation } from "./types.js";
import type { IntegrationRegistry } from "./registry.js";

// The console renders integration forms from this catalog rather than from
// bespoke per-type editors: config fields become normal inputs, secret fields
// become password inputs, and action inputs drive the binding UI. Adding an
// integration type is then a server-only change.

export interface ActionCatalogEntry {
  key: string;
  displayName: string;
  description: string;
  latest: string;
  versions: Record<string, { inputSchema: unknown }>;
}

export interface IntegrationCatalogEntry {
  type: string;
  displayName: string;
  description: string;
  execution: ExecutionLocation;
  configSchema: unknown;
  secretSchema: unknown;
  actions: ActionCatalogEntry[];
}

// Schemas are authored in zod (one source of truth for validation) and
// serialized here for the wire.
function toJsonSchema(schema: z.ZodType): unknown {
  return z.toJSONSchema(schema, { io: "input" });
}

export function buildIntegrationCatalog(registry: IntegrationRegistry): IntegrationCatalogEntry[] {
  return registry.list().map((definition) => ({
    type: definition.type,
    displayName: definition.displayName,
    description: definition.description,
    execution: definition.execution,
    configSchema: toJsonSchema(definition.configSchema),
    secretSchema: toJsonSchema(definition.secretSchema),
    actions: definition.actions.map((action) => ({
      key: action.key,
      displayName: action.displayName,
      description: action.description,
      latest: action.latest,
      versions: Object.fromEntries(
        Object.entries(action.versions).map(([version, actionVersion]) => [
          version,
          { inputSchema: toJsonSchema(actionVersion.inputSchema) },
        ]),
      ),
    })),
  }));
}
