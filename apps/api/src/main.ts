// API entry point. Phase 0 stub.
// Phase 1 (task #10) lifts the full HTTP server + in-process BullMQ workers
// (stale-gateway-check, replay-reconcile, station-detect, dev-cycle-simulator).

process.env.TZ = "UTC";

import "dotenv/config";
import { onShutdown } from "@rw/runtime";

async function main(): Promise<void> {
  console.log("[api] boot (Phase 0 stub)");
  onShutdown(async () => {
    console.log("[api] shutdown");
  });
}

main().catch((err) => {
  console.error("[api] failed to start:", err);
  process.exit(1);
});
