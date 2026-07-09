import type { FastifyBaseLogger } from "fastify";

export type IServerOptions = {
  host: string;
  port: number;
  graceDelay: number;
  loggerInstance?: FastifyBaseLogger;
  /** Register the swagger plugin (/docs). Defaults to true in development, false in production. */
  swagger?: boolean;
  /** Install closeWithGrace + unhandledRejection process handlers. Default true; tests and scripts opt out. */
  installShutdownHandlers?: boolean;
};
