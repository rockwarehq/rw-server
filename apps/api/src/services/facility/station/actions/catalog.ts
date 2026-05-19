import type { ZodIssue } from "zod";
import type { StationActionDefinition, StationActionValidationError, StationActionValidationResult } from "./types.js";

interface RegisteredStationAction {
  definition: StationActionDefinition<unknown>;
}

const actionRegistry: Map<string, RegisteredStationAction> = new Map();

function toErrorPath(path: ReadonlyArray<PropertyKey>): string {
  if (path.length === 0) {
    return "/";
  }

  return `/${path.map((segment) => String(segment)).join("/")}`;
}

function formatErrors(errors: ZodIssue[] | undefined): StationActionValidationError[] {
  if (!errors) {
    return [];
  }

  return errors.map((error) => ({
    path: toErrorPath(error.path),
    message: error.message,
    keyword: error.code,
  }));
}

export function registerAction<TInput>(definition: StationActionDefinition<TInput>) {
  if (actionRegistry.has(definition.key)) {
    throw new Error(`Station action already registered: ${definition.key}`);
  }

  actionRegistry.set(definition.key, {
    definition: definition as StationActionDefinition<unknown>,
  });
}

export function hasAction(actionKey: string) {
  return actionRegistry.has(actionKey);
}

export function getAction(actionKey: string): StationActionDefinition<unknown> | undefined {
  return actionRegistry.get(actionKey)?.definition;
}

export function listActions(): StationActionDefinition<unknown>[] {
  return Array.from(actionRegistry.values()).map((entry) => entry.definition);
}

export function validateActionInput(actionKey: string, input: unknown): StationActionValidationResult {
  const action = actionRegistry.get(actionKey);
  if (!action) {
    return {
      valid: false,
      code: "ACTION_NOT_FOUND",
      message: `Unknown station action: ${actionKey}`,
    };
  }

  const parsed = action.definition.inputSchema.safeParse(input);
  if (parsed.success) {
    return { valid: true };
  }

  return {
    valid: false,
    code: "ACTION_INPUT_INVALID",
    message: `Invalid input for station action: ${actionKey}`,
    errors: formatErrors(parsed.error.issues),
  };
}
