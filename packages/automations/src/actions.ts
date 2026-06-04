import type { ActionInputSchema, Automation } from "./types.js";

/** Everything an action handler receives when it runs. */
export interface ActionContext {
  automation: Automation;
  eventId: string;
}

/** One version's behavior: input shape + run function. Schema and run can't drift — they live in the same object. */
export interface ActionVersion {
  inputSchema: ActionInputSchema;
  run(inputs: Record<string, unknown>, ctx: ActionContext): void | Promise<void>;
}

export interface ActionHandler {
  type: string;
  displayName: string;
  latest: string;
  versions: Record<string, ActionVersion>;
}

export function missingRequired(inputs: Record<string, unknown>, schema: ActionInputSchema): string | null {
  for (const key of schema.required) {
    const v = inputs[key];
    if (v == null) return key;
    if (typeof v === "string" && v === "") return key;
    if (Array.isArray(v) && v.filter((x) => x !== "" && x != null).length === 0) return key;
  }
  return null;
}

export interface ActionRegistry {
  register(handler: ActionHandler): ActionRegistry;
  get(type: string, version: string): ActionVersion | undefined;
  latest(type: string): string | undefined;
  types(): string[];
  entries(): Array<{ type: string; version: string }>;
}

export function createActionRegistry(): ActionRegistry {
  const handlers = new Map<string, ActionHandler>();
  const registry: ActionRegistry = {
    register(handler) {
      handlers.set(handler.type, handler);
      return registry;
    },
    get(type, version) {
      return handlers.get(type)?.versions[version];
    },
    latest(type) {
      return handlers.get(type)?.latest;
    },
    types() {
      return [...handlers.keys()];
    },
    entries() {
      const out: Array<{ type: string; version: string }> = [];
      for (const [type, h] of handlers) {
        for (const v of Object.keys(h.versions)) out.push({ type, version: v });
      }
      return out;
    },
  };
  return registry;
}
