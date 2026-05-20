import type { ZodType } from "zod";

export interface StationActionValidationError {
  path: string;
  message: string;
  keyword: string;
}

export interface StationActionExecutionContext {
  executionId: string;
  eventId: string;
  stationId: string;
  workspaceId: string;
  payload: Record<string, unknown>;
  actionId: string;
  actionIndex: number;
}

export interface StationActionDefinition<TInput = unknown> {
  key: string;
  displayName: string;
  description: string;
  inputSchema: ZodType<TInput>;
  execute: (context: StationActionExecutionContext, input: TInput) => Promise<void>;
}

export type StationActionValidationResult =
  | { valid: true }
  | {
      valid: false;
      code: "ACTION_NOT_FOUND" | "ACTION_INPUT_INVALID";
      message: string;
      errors?: StationActionValidationError[];
    };
