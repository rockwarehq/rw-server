process.env.TZ = "UTC";

import "dotenv/config";

import { createPrismaClient } from "@rw/db";
import { onShutdown } from "@rw/runtime";

import { connectNatsResources, stopNatsResources } from "./nats.js";
import { GraphRuntime } from "./runtime.js";
import { asLivestoreLogger, createLivestoreServer, registerGraphRoutes } from "./server.js";

async function main(): Promise<void> {
  const prisma = createPrismaClient("livestore");
  const nats = await connectNatsResources();

  // Build the server first so the engine logs through Fastify's Pino instance.
  const server = await createLivestoreServer();

  const runtime = new GraphRuntime({
    prisma,
    nc: nats.nc,
    kv: nats.kv,
    aggKv: nats.aggKv,
    logger: asLivestoreLogger(server),
    isNatsReady: nats.isReady,
  });
  await runtime.start();

  registerGraphRoutes(server, runtime);
  const port = Number.parseInt(process.env.PORT ?? "", 10) || 30100;
  const host = process.env.HOST || "::";
  await server.listen({ port, host });
  server.log.info({ port, host }, "livestore listening");

  onShutdown(async () => {
    await runtime.stop();
    await server.close();
    await stopNatsResources();
    await prisma.$disconnect();
  });
}

main().catch((err) => {
  console.error("[livestore] failed to start", err);
  process.exit(1);
});
