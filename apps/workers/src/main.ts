// Workers binary. Dispatches on --worker flag to one of three modules.

process.env.TZ = "UTC";

import "dotenv/config";
import { startHostServer, onShutdown } from "@rw/runtime";

import { startRollups, stopRollups } from "./workers/rollups/index.js";
import { startProcessor, stopProcessor } from "./workers/processor/index.js";
import { startProcessorConsumer, stopProcessorConsumer } from "./workers/processor-consumer/index.js";

type WorkerName = "rollups" | "processor" | "processor-consumer";

const WORKERS: Record<WorkerName, { start: () => Promise<void>; stop: () => Promise<void> }> = {
  rollups: { start: startRollups, stop: stopRollups },
  processor: { start: startProcessor, stop: stopProcessor },
  "processor-consumer": { start: startProcessorConsumer, stop: stopProcessorConsumer },
};

function parseFlag(flag: string): string | null {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return null;
  return process.argv[idx + 1] ?? null;
}

async function main(): Promise<void> {
  const requested = parseFlag("--worker") ?? process.env.WORKER ?? null;
  if (!requested || !(requested in WORKERS)) {
    console.error(`[workers] usage: --worker <${Object.keys(WORKERS).join("|")}>`);
    console.error(`[workers] received: ${requested}`);
    process.exit(1);
  }

  const name = requested as WorkerName;
  const entry = WORKERS[name];

  const port = Number.parseInt(process.env.PORT ?? "", 10) || 9465;
  let ready = false;

  const host = startHostServer({
    port,
    isReady: () => ready,
    isHealthy: () => true,
  });

  console.log(`[workers] starting ${name} on port ${port}`);
  await entry.start();
  ready = true;
  console.log(`[workers] ${name} ready`);

  onShutdown(async () => {
    console.log(`[workers] stopping ${name}`);
    ready = false;
    await entry.stop();
    await host.close();
  });
}

main().catch((err) => {
  console.error("[workers] failed to start:", err);
  process.exit(1);
});
