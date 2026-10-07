import { moduleLogger } from "../logger.js";
import { expireStale } from "./approvals.js";
import { setRunner } from "./queue.js";
import { recoverSessions, runSession } from "./runner.js";

// Wires the run queue to the runner and, every few minutes, takes over
// sessions whose node died and closes approvals nobody answered in time.

const log = moduleLogger("agent-runtime");
const SWEEP_MS = 5 * 60 * 1000;

export async function startAgentRuntime(): Promise<() => Promise<void>> {
  setRunner((sessionId) => runSession(sessionId));
  const sweep = () =>
    void Promise.all([recoverSessions(), expireStale()]).catch((err: unknown) => log.error({ err }, "sweep failed"));
  sweep();
  const timer = setInterval(sweep, SWEEP_MS);
  return async () => {
    clearInterval(timer);
    setRunner(null);
  };
}
