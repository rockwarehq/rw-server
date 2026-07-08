import type { FastifyTypedInstance } from "../types/fastify.js";
import { healthResponseSchema } from "./schemas.js";

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
