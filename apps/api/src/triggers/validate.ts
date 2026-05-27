import type * as z from "zod";
import { ACTION_SCHEMAS, EVENT_SCHEMAS } from "./catalog.js";
import { actionInputsToZod, formatZodError, payloadToZod } from "./schema-to-zod.js";
import type { EventType } from "./types.js";

export type ValidationResult = { ok: true; value: Record<string, unknown> } | { ok: false; error: string };

// Validators are derived from static catalog schemas, so build each once and reuse.
const actionValidators = new Map<string, z.ZodTypeAny>();
const payloadValidators = new Map<EventType, z.ZodTypeAny>();

/** Validate a trigger's action inputs against the derived schema for its action type. */
export function validateActionInputs(actionType: string, inputs: unknown): ValidationResult {
  const schema = ACTION_SCHEMAS[actionType];
  if (!schema) return { ok: false, error: `unknown action type: ${actionType}` };

  let validator = actionValidators.get(actionType);
  if (!validator) {
    validator = actionInputsToZod(schema.inputSchema);
    actionValidators.set(actionType, validator);
  }

  const result = validator.safeParse(inputs ?? {});
  if (!result.success) return { ok: false, error: formatZodError(result.error) };
  return { ok: true, value: result.data as Record<string, unknown> };
}

/** Validate an event payload against the derived schema for its event type. */
export function validateEventPayload(eventType: EventType, payload: unknown): ValidationResult {
  const schema = EVENT_SCHEMAS[eventType];
  if (!schema) return { ok: false, error: `unknown event type: ${eventType}` };

  let validator = payloadValidators.get(eventType);
  if (!validator) {
    validator = payloadToZod(schema.payload);
    payloadValidators.set(eventType, validator);
  }

  const result = validator.safeParse(payload ?? {});
  if (!result.success) return { ok: false, error: formatZodError(result.error) };
  return { ok: true, value: result.data as Record<string, unknown> };
}
