import { type ActionHandler, type ActionRegistry, type ActionSchema, createActionRegistry } from "@rw/automations";
import * as clearMode from "./clear-mode.js";
import * as closeCall from "./close-call.js";
import * as forceMode from "./force-mode.js";
import * as notify from "./notify.js";
import * as openCall from "./open-call.js";

const modules: readonly { handler: ActionHandler }[] = [notify, openCall, closeCall, forceMode, clearMode] as const;

/** Catalog view: strip `run` from each version so schemas are serializable + don't leak code. */
function toActionSchema(h: ActionHandler): ActionSchema {
  return {
    type: h.type,
    displayName: h.displayName,
    latest: h.latest,
    versions: Object.fromEntries(Object.entries(h.versions).map(([v, av]) => [v, { inputSchema: av.inputSchema }])),
  };
}

/** Every action the app understands */
export const ACTION_SCHEMAS: Record<string, ActionSchema> = Object.fromEntries(
  modules.map((m) => [m.handler.type, toActionSchema(m.handler)]),
);

export function buildActionRegistry(): ActionRegistry {
  const reg = createActionRegistry();
  for (const m of modules) reg.register(m.handler);
  return reg;
}
