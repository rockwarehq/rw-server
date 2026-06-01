import type { AppEvent } from "./types.js";

/**
 * Audit sink for automation runs. The engine calls a recorder at three moments per `fire()`:
 *   1. `startRun(event)` — before dispatch evaluates conditions. Returns an opaque `runId` the
 *      engine threads through subsequent calls. Anything the recorder needs to write is up to it
 *      (a DB row, a log line, nothing); the engine doesn't care.
 *   2. `recordAction(...)` — after each action attempt (success or failure).
 *   3. `finishRun(runId, ...)` — when dispatch settles, with the matched-automation list and the
 *      terminal status. Called even on failure (the error is passed alongside).
 */
export interface RunRecorder {
  startRun(input: StartRunInput): Promise<string>;
  recordAction(input: RecordActionInput): Promise<void>;
  finishRun(runId: string, input: FinishRunInput): Promise<void>;
}

export interface StartRunInput {
  event: AppEvent;
}

export interface RecordActionInput {
  runId: string;
  automationId: string;
  actionIdx: number;
  actionType: string;
  actionVersion: string;
  status: "SUCCESS" | "FAILED";
  error?: string;
  startedAt: string;
  finishedAt: string;
}

export interface FinishRunInput {
  matched: string[];
  status: "SUCCESS" | "FAILED";
  error?: string;
}

/** Default no-op. Used when the consumer didn't supply a recorder (file-backed dev, tests). */
export const noopRunRecorder: RunRecorder = {
  startRun: async () => "noop",
  recordAction: async () => {},
  finishRun: async () => {},
};
