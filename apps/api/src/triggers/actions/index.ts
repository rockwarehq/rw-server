import { type ActionHandler, type ActionRegistry, type ActionSchema, createActionRegistry } from "@rw/triggers";
import * as sendAlert from "./send-alert.js";

/**
 * Action aggregator. Each action module exports `schema` + `handler`; this file collects them into
 * the maps the framework consumes. Add a new action = drop a module in this folder, add one import
 * + one entry below. Schema and handler can't drift because they're declared in the same module.
 */

type ActionModule = { schema: ActionSchema; handler: ActionHandler };

const modules: readonly ActionModule[] = [sendAlert] as const;

/** Every action the app understands, keyed by type. */
export const ACTION_SCHEMAS: Record<string, ActionSchema> = Object.fromEntries(
  modules.map((m) => [m.schema.type, m.schema]),
);

/** Registered action handlers (SEAM C). One per action module. */
export function buildActionRegistry(): ActionRegistry {
  const reg = createActionRegistry();
  for (const m of modules) reg.register(m.handler);
  return reg;
}
