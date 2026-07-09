import { runReadinessChecks } from "../readiness.js";
import type { FastifyTypedInstance } from "../types/fastify.js";
import { healthResponseSchema, readinessResponseSchema } from "./schemas.js";

import auth from "./auth.js";
import users from "./users.js";
import workspaces from "./workspaces.js";
import sites from "./sites.js";
import workcenters from "./workcenters.js";
import stations from "./stations.js";
import gateways from "./gateways.js";
import datasources from "./datasources.js";
import points from "./points.js";
import groups from "./groups.js";
import drivers from "./drivers.js";

export default async function api(fastify: FastifyTypedInstance) {
  // Health check endpoint
  fastify.route({
    method: "GET",
    url: "/health",
    // Liveness probe (fly healthchecks hit this): static on purpose — a
    // dependency blip must never make the orchestrator kill machines.
    // Exempt from rate limiting so probes never consume a caller's budget.
    config: { rateLimit: false },
    schema: {
      tags: ["Health"],
      response: {
        200: healthResponseSchema,
      },
    },
    handler: async () => {
      return { status: "ok" };
    },
  });

  // Alias matching apps/workers' http-host naming (/healthz).
  fastify.route({
    method: "GET",
    url: "/healthz",
    config: { rateLimit: false },
    schema: { tags: ["Health"], response: { 200: healthResponseSchema } },
    handler: async () => ({ status: "ok" }),
  });

  // Readiness: runs the registered dependency checks (db/redis/nats —
  // registered in main.ts where those connections live). 503 when any
  // critical check fails; non-critical checks are reported but never flip
  // readiness. Serves /ready and /readyz (http-host naming).
  for (const url of ["/ready", "/readyz"]) {
    fastify.route({
      method: "GET",
      url,
      config: { rateLimit: false },
      schema: {
        tags: ["Health"],
        response: {
          200: readinessResponseSchema,
          503: readinessResponseSchema,
        },
      },
      handler: async (_request, reply) => {
        const { ready, checks } = await runReadinessChecks();
        return reply.status(ready ? 200 : 503).send({
          status: ready ? "ready" : "not_ready",
          checks,
        });
      },
    });
  }

  await fastify.register(auth, { prefix: "/auth" });
  await fastify.register(users, { prefix: "/users" });
  await fastify.register(workspaces, { prefix: "/workspaces" });
  await fastify.register(sites, { prefix: "/sites" });
  await fastify.register(workcenters, { prefix: "/workcenters" });
  await fastify.register(stations, { prefix: "/stations" });
  await fastify.register(gateways, { prefix: "/gateways" });
  await fastify.register(datasources, { prefix: "/datasources" });
  await fastify.register(points, { prefix: "/points" });
  await fastify.register(groups, { prefix: "/groups" });
  await fastify.register(drivers, { prefix: "/drivers" });
}
