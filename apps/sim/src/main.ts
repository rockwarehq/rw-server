// rw-sim: makes stations look like real machines by publishing cycle signals
// on the tags their cycle hooks watch — paced off each station's live standard,
// in auto (great / normal / slow / stops) or a program. Needs DATABASE_URL
// (read-only use), NATS_URL, and SIM_API_URL (sign-in goes through the API).

import "dotenv/config";

import { connect } from "@nats-io/transport-node";
import { createPrismaClient } from "@rw/db";
import { onShutdown } from "@rw/runtime";

import { ConfigStore } from "./config.js";
import { discoverStations } from "./discovery.js";
import { SimEngine } from "./engine.js";
import { createServer } from "./server.js";

// Re-read stations, jobs and standards so job changes made in the app reach the runners.
const DISCOVERY_MS = Number.parseInt(process.env.SIM_DISCOVERY_MS ?? "", 10) || 15_000;

async function main(): Promise<void> {
  const prisma = createPrismaClient("sim");
  const nc = await connect({
    servers: (process.env.NATS_URL ?? "nats://127.0.0.1:4222").split(","),
    name: process.env.NATS_CLIENT_NAME || "rw-sim",
    maxReconnectAttempts: -1,
    waitOnFirstConnect: true,
  });

  const store = new ConfigStore(process.env.SIM_CONFIG_PATH ?? "./data/sim.json");
  await store.load();

  const engine = new SimEngine(nc, store, { info: console.log, warn: console.warn });
  const server = createServer(engine, { apiUrl: process.env.SIM_API_URL ?? "http://localhost:3000" });

  // Also on demand from the UI (page load / Refresh) so new stations show up immediately.
  const refresh = async () => engine.updateStations(await discoverStations(prisma));
  const refreshQuietly = () => refresh().catch((err) => server.log.error({ err }, "station discovery failed"));
  await refreshQuietly();
  const poll = setInterval(refreshQuietly, DISCOVERY_MS);
  server.post("/api/refresh", async () => {
    await refresh();
    return { ok: true };
  });

  await server.listen({ host: process.env.HOST ?? "::", port: Number(process.env.PORT ?? 30200) });

  onShutdown(async () => {
    clearInterval(poll);
    engine.stop();
    await server.close();
    await nc.drain();
    await prisma.$disconnect();
  });
}

main().catch((err) => {
  console.error("[sim] fatal", err);
  process.exit(1);
});
