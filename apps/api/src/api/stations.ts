import type { JSONSchema } from "json-schema-to-ts";
import type { FastifyTypedInstance } from "../types/fastify.js";
import { station } from "@rw/services/facility/index";
import { errorSchema, idParamsSchema, successResponseSchema } from "./schemas.js";
import { authorize, authorizeList, scopeFilter } from "@rw/auth/iam/policy";
import { replyPolicyDenial } from "./authz.js";

// ============================================================================
// Schemas
// ============================================================================

const siteSummarySchema = {
  type: "object",
  properties: {
    id: { type: "string", format: "uuid" },
    name: { type: "string" },
    workspaceId: { type: "string", format: "uuid" },
  },
} as const satisfies JSONSchema;

const workcenterSummarySchema = {
  type: "object",
  nullable: true,
  properties: {
    id: { type: "string", format: "uuid" },
    name: { type: "string" },
  },
} as const satisfies JSONSchema;

const stationProperties = {
  id: { type: "string", format: "uuid" },
  name: { type: "string" },
  description: { type: "string", nullable: true },
  attrs: { type: "object", additionalProperties: true },
  siteId: { type: "string", format: "uuid" },
  workcenterId: { type: "string", format: "uuid", nullable: true },
  createdAt: { type: "string", format: "date-time" },
  updatedAt: { type: "string", format: "date-time" },
} as const;

const stationSchema = {
  type: "object",
  properties: {
    ...stationProperties,
    site: siteSummarySchema,
    workcenter: workcenterSummarySchema,
  },
} as const satisfies JSONSchema;

const createBodySchema = {
  type: "object",
  properties: {
    name: { type: "string", minLength: 1 },
    description: { type: "string" },
    attrs: { type: "object", additionalProperties: true },
    siteId: { type: "string", format: "uuid" },
    workcenterId: { type: "string", format: "uuid" },
  },
  required: ["name", "siteId"],
} as const satisfies JSONSchema;

const updateBodySchema = {
  type: "object",
  properties: {
    name: { type: "string", minLength: 1 },
    description: { type: "string" },
    attrs: { type: "object", additionalProperties: true },
  },
} as const satisfies JSONSchema;

const moveBodySchema = {
  type: "object",
  properties: {
    workcenterId: { type: ["string", "null"], format: "uuid" },
  },
  required: ["workcenterId"],
} as const satisfies JSONSchema;

const listQuerySchema = {
  type: "object",
  properties: {
    siteId: { type: "string", format: "uuid" },
    workcenterId: { type: "string", format: "uuid" },
    name: { type: "string" },
    limit: { type: "number", default: 50 },
    offset: { type: "number", default: 0 },
  },
} as const satisfies JSONSchema;

const listResponseSchema = {
  type: "object",
  properties: {
    data: { type: "array", items: stationSchema },
    total: { type: "number" },
    limit: { type: "number" },
    offset: { type: "number" },
  },
} as const satisfies JSONSchema;

// ============================================================================
// Helper
// ============================================================================

function getStatusForCode(code: string): 400 | 404 | 409 {
  switch (code) {
    case "STATION_NOT_FOUND":
    case "WORKCENTER_NOT_FOUND":
    case "SITE_NOT_FOUND":
      return 404;
    case "SITE_MISMATCH":
      return 409;
    default:
      return 400;
  }
}

// ============================================================================
// Routes
// ============================================================================

export default async function stations(fastify: FastifyTypedInstance) {
  // Create station
  fastify.route({
    method: "POST",
    url: "/",
    preHandler: [fastify.verifyAccessToken],
    schema: {
      tags: ["stations"],
      security: [{ bearerAuth: [] }],
      body: createBodySchema,
      response: {
        201: stationSchema,
        400: errorSchema,
        401: errorSchema,
        403: errorSchema,
        404: errorSchema,
        409: errorSchema,
      },
    },
    handler: async (request, reply) => {
      const auth = await authorize(request.iam, {
        permission: "facility:write",
        site: { kind: "site", siteId: request.body.siteId },
      });
      if (!auth.ok) return replyPolicyDenial(reply, auth);

      const result = await station.create(request.body);
      if ("error" in result && typeof result.error === "string") {
        const status = getStatusForCode(result.code ?? "UNKNOWN");
        return reply.status(status).send({ error: result.error });
      }
      return reply.status(201).send(result.data);
    },
  });

  // List stations
  fastify.route({
    method: "GET",
    url: "/",
    preHandler: [fastify.verifyAccessToken],
    schema: {
      tags: ["stations"],
      security: [{ bearerAuth: [] }],
      querystring: listQuerySchema,
      response: {
        200: listResponseSchema,
        401: errorSchema,
        403: errorSchema,
      },
    },
    handler: async (request, reply) => {
      const scope = await authorizeList(request.iam, {
        permission: "facility:read",
        requestedSiteId: request.query.siteId,
      });
      if (!scope.ok) return replyPolicyDenial(reply, scope);

      return station.list({ ...request.query, ...scopeFilter(scope) });
    },
  });

  // Get station by ID
  fastify.route({
    method: "GET",
    url: "/:id",
    preHandler: [fastify.verifyAccessToken],
    schema: {
      tags: ["stations"],
      security: [{ bearerAuth: [] }],
      params: idParamsSchema,
      response: {
        200: stationSchema,
        401: errorSchema,
        403: errorSchema,
        404: errorSchema,
      },
    },
    handler: async (request, reply) => {
      const auth = await authorize(request.iam, {
        permission: "facility:read",
        site: { kind: "station", stationId: request.params.id },
      });
      if (!auth.ok) return replyPolicyDenial(reply, auth);

      const result = await station.getById(request.params.id, auth.workspaceId);
      if (!result || "error" in result) {
        return reply.status(404).send({ error: "Station not found" });
      }
      return result.data;
    },
  });

  // Update station
  fastify.route({
    method: "PUT",
    url: "/:id",
    preHandler: [fastify.verifyAccessToken],
    schema: {
      tags: ["stations"],
      security: [{ bearerAuth: [] }],
      params: idParamsSchema,
      body: updateBodySchema,
      response: {
        200: stationSchema,
        400: errorSchema,
        401: errorSchema,
        403: errorSchema,
        404: errorSchema,
        409: errorSchema,
      },
    },
    handler: async (request, reply) => {
      const auth = await authorize(request.iam, {
        permission: "facility:write",
        site: { kind: "station", stationId: request.params.id },
      });
      if (!auth.ok) return replyPolicyDenial(reply, auth);

      const result = await station.update(request.params.id, request.body, auth.workspaceId);
      if ("error" in result && typeof result.error === "string") {
        const status = getStatusForCode(result.code ?? "UNKNOWN");
        return reply.status(status).send({ error: result.error });
      }
      return result.data;
    },
  });

  // Move station (change workcenter)
  fastify.route({
    method: "POST",
    url: "/:id/move",
    preHandler: [fastify.verifyAccessToken],
    schema: {
      tags: ["stations"],
      security: [{ bearerAuth: [] }],
      params: idParamsSchema,
      body: moveBodySchema,
      response: {
        200: stationSchema,
        400: errorSchema,
        401: errorSchema,
        403: errorSchema,
        404: errorSchema,
        409: errorSchema,
      },
    },
    handler: async (request, reply) => {
      const auth = await authorize(request.iam, {
        permission: "facility:write",
        site: { kind: "station", stationId: request.params.id },
      });
      if (!auth.ok) return replyPolicyDenial(reply, auth);

      const result = await station.move(request.params.id, request.body.workcenterId, auth.workspaceId);
      if ("error" in result && typeof result.error === "string") {
        const status = getStatusForCode(result.code ?? "UNKNOWN");
        return reply.status(status).send({ error: result.error });
      }
      return result.data;
    },
  });

  // Delete station
  fastify.route({
    method: "DELETE",
    url: "/:id",
    preHandler: [fastify.verifyAccessToken],
    schema: {
      tags: ["stations"],
      security: [{ bearerAuth: [] }],
      params: idParamsSchema,
      response: {
        200: successResponseSchema,
        400: errorSchema,
        401: errorSchema,
        403: errorSchema,
        404: errorSchema,
        409: errorSchema,
      },
    },
    handler: async (request, reply) => {
      const auth = await authorize(request.iam, {
        permission: "facility:admin",
        site: { kind: "station", stationId: request.params.id },
      });
      if (!auth.ok) return replyPolicyDenial(reply, auth);

      const result = await station.remove(request.params.id, auth.workspaceId);
      if ("error" in result && typeof result.error === "string") {
        const status = getStatusForCode(result.code ?? "UNKNOWN");
        return reply.status(status).send({ error: result.error });
      }
      return { success: true };
    },
  });
}
