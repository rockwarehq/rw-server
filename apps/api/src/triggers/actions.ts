import { ACTION_SCHEMAS } from "./catalog.js";
import type { ActionInputSchema, Notify, Trigger } from "./types.js";

/** Everything an action handler receives when it runs. */
export interface ActionContext {
  trigger: Trigger;
  eventId: string;
  notify: Notify;
}

/**
 * SEAM C — a runnable action. `inputSchema` drives validation (and the editor UI); `run` does the
 * work. Register more handlers (createForm, sendEmail, …) in registry.ts — the engine resolves the
 * handler by `trigger.action.type`, so adding an action never touches the engine.
 */
export interface ActionHandler {
  type: string;
  inputSchema: ActionInputSchema;
  run(inputs: Record<string, unknown>, ctx: ActionContext): void | Promise<void>;
}

/** Returns the first missing required input key, or null if all required inputs are present. */
export function missingRequired(inputs: Record<string, unknown>, schema: ActionInputSchema): string | null {
  for (const key of schema.required) {
    const v = inputs[key];
    if (v == null) return key;
    if (typeof v === "string" && v === "") return key;
    if (Array.isArray(v) && v.filter((x) => x !== "" && x != null).length === 0) return key;
  }
  return null;
}

/**
 * Example action. "Execute" logs the interpolated message + recipients (no real email is sent —
 * this is the placeholder a real `sendEmail`/`createForm` handler would replace).
 */
export const sendAlertHandler: ActionHandler = {
  type: "sendAlert",
  inputSchema: ACTION_SCHEMAS.sendAlert?.inputSchema ?? { required: [], properties: {} },
  run(inputs, ctx) {
    const text = String(inputs.text ?? "");
    const emails = Array.isArray(inputs.emails) ? inputs.emails.map(String).filter((e) => e.length > 0) : [];

    console.log(`[triggers] ALERT (${ctx.trigger.label}): ${text} -> ${emails.join(", ") || "(no recipients)"}`);

    ctx.notify({ type: "actionRan", triggerId: ctx.trigger.id, action: "sendAlert", eventId: ctx.eventId });
  },
};

/** A registry of action handlers, keyed by `type`. */
export class ActionRegistry {
  private handlers = new Map<string, ActionHandler>();

  register(handler: ActionHandler): this {
    this.handlers.set(handler.type, handler);
    return this;
  }

  get(type: string): ActionHandler | undefined {
    return this.handlers.get(type);
  }
}
