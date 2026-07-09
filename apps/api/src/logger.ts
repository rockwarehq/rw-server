import pino from "pino";
import { env } from "./config.js";

// One pino root for the whole process: Fastify gets a child (module: "http")
// in server.ts, and non-request modules (command bus, publishers, workers)
// get their own children via moduleLogger(). Everything shares one stream
// and format — JSON in production, pretty-printed in dev.
export const rootLogger = pino({
  level: env.logLevel,
  ...(env.isDevelopment ? { transport: { target: "pino-pretty" } } : {}),
});

export const moduleLogger = (module: string) => rootLogger.child({ module });
