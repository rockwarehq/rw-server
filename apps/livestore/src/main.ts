process.env.TZ = "UTC";

import "dotenv/config";

import { createPrismaClient } from "@rw/db";
import { onShutdown } from "@rw/runtime";

import { connectNatsResources } from "./nats.js";
import { GraphRuntime } from "./runtime.js";
import { createLivestoreServer } from "./server.js";

async function main(): Promise<void> {
  const prisma = createPrismaClient("livestore");
  const nats = await connectNatsResources();

  const runtimeLogger = {
    info: (obj: Record<string, unknown>, msg?: string) => console.log(msg ?? "livestore", obj),
    warn: (obj: Record<string, unknown>, msg?: string) => console.warn(msg ?? "livestore", obj),
    error: (obj: Record<string, unknown>, msg?: string) => console.error(msg ?? "livestore", obj),
  };

  const runtime = new GraphRuntime({ prisma, nc: nats.nc, kv: nats.kv, logger: runtimeLogger });
  await runtime.start();

  const server = await createLivestoreServer(runtime);
  const port = Number.parseInt(process.env.PORT ?? "", 10) || 30100;
  const host = process.env.HOST || "::";
  await server.listen({ port, host });
  server.log.info({ port, host }, "livestore listening");

  onShutdown(async () => {
    runtime.stop();
    await server.close();
    await nats.nc.drain();
    await prisma.$disconnect();
  });
}

main().catch((err) => {
  console.error("[livestore] failed to start", err);
  process.exit(1);
});
