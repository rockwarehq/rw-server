process.env.TZ = "UTC";

import "dotenv/config";

import { createPrismaClient } from "@rw/db";
import { onShutdown } from "@rw/runtime";

import Fastify from "fastify";

import {
  GraphRuntime,
  LivestoreAuthenticator,
  asLivestoreLogger,
  connectNatsResources,
  createLivestoreServer,
  registerGraphRoutes,
  registerMetricsRoute,
  stopNatsResources,
} from "@rw/livestore";

async function main(): Promise<void> {
  const prisma = createPrismaClient("livestore");
  const nats = await connectNatsResources();

  // Build the server first so the engine logs through Fastify's Pino instance.
  const server = await createLivestoreServer();

  // Backstop: without this, any unhandled rejection escalates to
  // uncaughtException and @rw/runtime's lifecycle handler exits the process
  // (same rationale as the api server's unhandledRejection logger).
  process.on("unhandledRejection", (reason) => {
    server.log.error({ err: reason }, "livestore unhandled promise rejection");
  });

  const runtime = new GraphRuntime({
    prisma,
    nc: nats.nc,
    jetstream: nats.jetstream,
    jetstreamManager: nats.jetstreamManager,
    kv: nats.kv,
    aggKv: nats.aggKv,
    logger: asLivestoreLogger(server),
    isNatsReady: nats.isReady,
  });
  await runtime.start();

  // Constructing the authenticator pulls in @rw/auth's env validation, so a
  // missing/weak JWT_SECRET fails the boot here rather than on first request.
  const authenticator = new LivestoreAuthenticator(prisma, asLivestoreLogger(server));
  registerGraphRoutes(server, runtime, authenticator);
  const port = Number.parseInt(process.env.PORT ?? "", 10) || 30100;
  const host = process.env.HOST || "::";
  await server.listen({ port, host });
  server.log.info({ port, host }, "livestore listening");

  // Metrics live on a separate listener that fly-proxy never routes to
  // (internal_port stays the public port), so /metrics is private-network-only
  // by construction. Fly's managed Prometheus scrapes it directly.
  const metricsServer = Fastify({ logger: false });
  registerMetricsRoute(metricsServer, runtime);
  const metricsPort = Number.parseInt(process.env.METRICS_PORT ?? "", 10) || 9091;
  await metricsServer.listen({ port: metricsPort, host });
  server.log.info({ metricsPort }, "livestore metrics listening");

  onShutdown(async () => {
    await runtime.stop();
    await server.close();
    await metricsServer.close();
    await stopNatsResources();
    await prisma.$disconnect();
  });
}

main().catch((err) => {
  console.error("[livestore] failed to start", err);
  process.exit(1);
});
