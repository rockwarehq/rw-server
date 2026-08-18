import type { JSONSchema } from "json-schema-to-ts";
import type { FastifyTypedInstance } from "../types/fastify.js";
import { workcenter } from "@rw/services/facility/index";
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

const parentSummarySchema = {
  type: "object",
  properties: {
    id: { type: "string", format: "uuid" },
    name: { type: "string" },
  },
  nullable: true,
} as const satisfies JSONSchema;

const workcenterCountsSchema = {
  type: "object",
  properties: {
    children: { type: "number" },
    stations: { type: "number" },
  },
} as const satisfies JSONSchema;

const workcenterProperties = {
  id: { type: "string", format: "uuid" },
  name: { type: "string" },
  description: { type: "string", nullable: true },
  attrs: { type: "object", additionalProperties: true },
  siteId: { type: "string", format: "uuid" },
  parentId: { type: ["string", "null"], format: "uuid" },
  createdAt: { type: "string", format: "date-time" },
  updatedAt: { type: "string", format: "date-time" },
} as const;

const workcenterSchema = {
  type: "object",
  properties: {
    ...workcenterProperties,
    site: siteSummarySchema,
    parent: parentSummarySchema,
    _count: workcenterCountsSchema,
  },
} as const satisfies JSONSchema;

const createBodySchema = {
  type: "object",
  properties: {
    name: { type: "string", minLength: 1 },
    description: { type: "string" },
    attrs: { type: "object", additionalProperties: true },
    siteId: { type: "string", format: "uuid" },
    parentId: { type: "string", format: "uuid" },
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
    parentId: { type: ["string", "null"], format: "uuid" },
  },
  required: ["parentId"],
} as const satisfies JSONSchema;

const listQuerySchema = {
  type: "object",
  properties: {
    siteId: { type: "string", format: "uuid" },
    parentId: { type: "string", format: "uuid" },
    name: { type: "string" },
    limit: { type: "number", default: 50 },
    offset: { type: "number", default: 0 },
  },
} as const satisfies JSONSchema;

const listResponseSchema = {
  type: "object",
  properties: {
    data: { type: "array", items: workcenterSchema },
    total: { type: "number" },
    limit: { type: "number" },
    offset: { type: "number" },
  },
} as const satisfies JSONSchema;

const getWorkcenterResponseSchema = {
  type: "object",
  properties: {
    ...workcenterProperties,
    site: siteSummarySchema,
    parent: parentSummarySchema,
    children: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          name: { type: "string" },
          description: { type: "string", nullable: true },
          _count: workcenterCountsSchema,
        },
      },
    },
    stations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          name: { type: "string" },
          description: { type: "string", nullable: true },
        },
      },
    },
    _count: workcenterCountsSchema,
  },
} as const satisfies JSONSchema;

// ============================================================================
// Helper
// ============================================================================

function getStatusForCode(code: string): 400 | 404 | 409 {
  switch (code) {
    case "SITE_NOT_FOUND":
    case "WORKCENTER_NOT_FOUND":
    case "PARENT_NOT_FOUND":
      return 404;
    case "SITE_MISMATCH":
    case "CIRCULAR_REFERENCE":
    case "HAS_CHILDREN":
    case "HAS_STATIONS":
      return 409;
    default:
      return 400;
  }
}

// ============================================================================
// Routes
// ============================================================================

export default async function workcenters(fastify: FastifyTypedInstance) {
  // Create workcenter
  fastify.route({
    method: "POST",
    url: "/",
    preHandler: [fastify.verifyAccessToken],
    schema: {
      tags: ["workcenters"],
      security: [{ bearerAuth: [] }],
      body: createBodySchema,
      response: {
        201: workcenterSchema,
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

      const result = await workcenter.create(request.body);
      if ("error" in result && typeof result.error === "string") {
        const status = getStatusForCode(result.code ?? "UNKNOWN");
        return reply.status(status).send({ error: result.error });
      }
      return reply.status(201).send(result.data);
    },
  });

  // List workcenters
  fastify.route({
    method: "GET",
    url: "/",
    preHandler: [fastify.verifyAccessToken],
    schema: {
      tags: ["workcenters"],
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

      return workcenter.list({ ...request.query, ...scopeFilter(scope) });
    },
  });

  // Get workcenter by ID
  fastify.route({
    method: "GET",
    url: "/:id",
    preHandler: [fastify.verifyAccessToken],
    schema: {
      tags: ["workcenters"],
      security: [{ bearerAuth: [] }],
      params: idParamsSchema,
      response: {
        200: getWorkcenterResponseSchema,
        401: errorSchema,
        403: errorSchema,
        404: errorSchema,
      },
    },
    handler: async (request, reply) => {
      const auth = await authorize(request.iam, {
        permission: "facility:read",
        site: { kind: "workcenter", id: request.params.id },
      });
      if (!auth.ok) return replyPolicyDenial(reply, auth);

      const result = await workcenter.getById(request.params.id, auth.workspaceId);
      if (!result || "error" in result) {
        return reply.status(404).send({ error: "Workcenter not found" });
      }
      return result.data;
    },
  });

  // Update workcenter
  fastify.route({
    method: "PUT",
    url: "/:id",
    preHandler: [fastify.verifyAccessToken],
    schema: {
      tags: ["workcenters"],
      security: [{ bearerAuth: [] }],
      params: idParamsSchema,
      body: updateBodySchema,
      response: {
        200: workcenterSchema,
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
        site: { kind: "workcenter", id: request.params.id },
      });
      if (!auth.ok) return replyPolicyDenial(reply, auth);

      const result = await workcenter.update(request.params.id, request.body, auth.workspaceId);
      if ("error" in result && typeof result.error === "string") {
        const status = getStatusForCode(result.code ?? "UNKNOWN");
        return reply.status(status).send({ error: result.error });
      }
      return result.data;
    },
  });

  // Move workcenter (change parent)
  fastify.route({
    method: "POST",
    url: "/:id/move",
    preHandler: [fastify.verifyAccessToken],
    schema: {
      tags: ["workcenters"],
      security: [{ bearerAuth: [] }],
      params: idParamsSchema,
      body: moveBodySchema,
      response: {
        200: workcenterSchema,
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
        site: { kind: "workcenter", id: request.params.id },
      });
      if (!auth.ok) return replyPolicyDenial(reply, auth);

      const result = await workcenter.move(request.params.id, request.body.parentId, auth.workspaceId);
      if ("error" in result && typeof result.error === "string") {
        const status = getStatusForCode(result.code ?? "UNKNOWN");
        return reply.status(status).send({ error: result.error });
      }
      return result.data;
    },
  });

  // Delete workcenter
  fastify.route({
    method: "DELETE",
    url: "/:id",
    preHandler: [fastify.verifyAccessToken],
    schema: {
      tags: ["workcenters"],
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
        site: { kind: "workcenter", id: request.params.id },
      });
      if (!auth.ok) return replyPolicyDenial(reply, auth);

      const result = await workcenter.remove(request.params.id, auth.workspaceId);
      if ("error" in result && typeof result.error === "string") {
        const status = getStatusForCode(result.code ?? "UNKNOWN");
        return reply.status(status).send({ error: result.error });
      }
      return { success: true };
    },
  });
}
