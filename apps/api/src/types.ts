import type { FastifyBaseLogger } from "fastify";

export type IServerOptions = {
  host: string;
  port: number;
  graceDelay: number;
  loggerInstance?: FastifyBaseLogger;
};
