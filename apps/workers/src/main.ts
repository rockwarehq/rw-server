// Workers binary. Dispatches on --worker flag to a worker module.

process.env.TZ = "UTC";

import "dotenv/config";
import { startHostServer, onShutdown } from "@rw/runtime";
import { createPrismaClient } from "@rw/db";
import client from "prom-client";

type WorkerName = "rollups" | "imm-events" | "gateway-health";
const WORKER_NAMES: readonly WorkerName[] = ["rollups", "imm-events", "gateway-health"];

function parseFlag(flag: string): string | null {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return null;
  return process.argv[idx + 1] ?? null;
}

async function loadWorker(name: WorkerName): Promise<{ start: () => Promise<void>; stop: () => Promise<void> }> {
  switch (name) {
    case "rollups": {
      const m = await import("./rollups.js");
      return { start: m.startRollups, stop: m.stopRollups };
    }
    case "imm-events": {
      const m = await import("./imm-events.js");
      return { start: m.startImmEvents, stop: m.stopImmEvents };
    }
    case "gateway-health": {
      const m = await import("./gateway-health.js");
      return { start: m.startGatewayHealth, stop: m.stopGatewayHealth };
    }
  }
}

async function main(): Promise<void> {
  const requested = parseFlag("--worker") ?? process.env.WORKER ?? null;
  if (!requested || !(WORKER_NAMES as readonly string[]).includes(requested)) {
    console.error(`[workers] usage: --worker <${WORKER_NAMES.join("|")}>`);
    console.error(`[workers] received: ${requested}`);
    process.exit(1);
  }

  const name = requested as WorkerName;

  // Per-mode DATABASE_URL override. Rollups want a DIRECT (port 5432, not
  // pgbouncer at 6432) connection because the rollup tick runs long CTE
  // queries that pgbouncer transaction-mode either breaks or holds open for
  // the whole transaction (defeating the pool).
  //
  // If DATABASE_URL_ROLLUPS is unset, rollups falls back to DATABASE_URL —
  // fine for local dev where both endpoints are the same Postgres.
  const ROLE_DB_URL: Partial<Record<WorkerName, string | undefined>> = {
    rollups: process.env.DATABASE_URL_ROLLUPS,
  };
  const override = ROLE_DB_URL[name];
  if (override) {
    process.env.DATABASE_URL = override;
    console.log(`[workers] DATABASE_URL_${name.toUpperCase().replaceAll("-", "_")} override applied`);
  }

  // Initialize Prisma with this worker's role BEFORE dynamic-importing the
  // worker module. The worker imports @rw/services transitively, which calls
  // createPrismaClient("api") at module-eval. The first call wins on pool
  // sizing, so we have to win the race here with the actual role.
  //
  // gateway-health touches no Postgres (NATS -> prom-client only), so it skips
  // Prisma entirely rather than opening an idle pool.
  if (name !== "gateway-health") createPrismaClient(name);

  const entry = await loadWorker(name);

  const port = Number.parseInt(process.env.PORT ?? "", 10) || 9465;
  let ready = false;

  // Default process metrics for every worker; the gateway-health worker also
  // registers its gateway_* gauges on this default registry. Fly's managed
  // Prometheus scrapes /metrics app-wide (see fly [metrics]).
  client.collectDefaultMetrics();

  const host = startHostServer({
    port,
    isReady: () => ready,
    isHealthy: () => true,
    getMetrics: () => client.register.metrics(),
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
