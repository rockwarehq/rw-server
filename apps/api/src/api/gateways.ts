import type { JSONSchema } from "json-schema-to-ts";
import type { FastifyTypedInstance } from "../types/fastify.js";
import { gateway } from "../services/device/index.js";
import { errorSchema, idParamsSchema, successResponseSchema } from "./schemas.js";

const siteSummarySchema = {
  type: "object",
  properties: {
    id: { type: "string", format: "uuid" },
    name: { type: "string" },
    workspaceId: { type: "string", format: "uuid" },
  },
  nullable: true,
} as const satisfies JSONSchema;

const gatewayProperties = {
  id: { type: "string", format: "uuid" },
  name: { type: "string" },
  description: { type: "string", nullable: true },
  serialNumber: { type: "string" },
  claimCode: { type: "string", nullable: true },
  hosting: { type: "string", enum: ["SELF", "ROCKWARE"] },
  status: { type: "string", enum: ["PROVISIONED", "ONLINE", "OFFLINE", "DISABLED"] },
  lastHeartbeat: { type: ["string", "null"], format: "date-time" },
  specVersion: { type: "number" },
  specUpdatedAt: { type: "string", format: "date-time" },
  health: { type: ["object", "null"], additionalProperties: true },
  metrics: { type: ["object", "null"], additionalProperties: true },
  metadata: { type: "object", additionalProperties: true },
  siteId: { type: ["string", "null"], format: "uuid" },
  createdAt: { type: "string", format: "date-time" },
  updatedAt: { type: "string", format: "date-time" },
} as const;

const gatewayWithSiteSchema = {
  type: "object",
  properties: {
    ...gatewayProperties,
    site: siteSummarySchema,
  },
} as const satisfies JSONSchema;

const commandSchema = {
  type: "object",
  properties: {
    id: { type: "string", format: "uuid" },
    command: { type: "string" },
    payload: { type: "object", additionalProperties: true },
    status: { type: "string", enum: ["PENDING", "ACK", "COMPLETED", "FAILED", "EXPIRED"] },
    result: { type: ["object", "null"], additionalProperties: true },
    createdAt: { type: "string", format: "date-time" },
    ackedAt: { type: ["string", "null"], format: "date-time" },
    completedAt: { type: ["string", "null"], format: "date-time" },
    expiresAt: { type: ["string", "null"], format: "date-time" },
    gatewayId: { type: "string", format: "uuid" },
  },
} as const satisfies JSONSchema;

const createBodySchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    description: { type: "string" },
    hosting: { type: "string", enum: ["SELF", "ROCKWARE"] },
    metadata: { type: "object", additionalProperties: true },
    siteId: { type: "string", format: "uuid" },
  },
  required: ["name", "siteId"],
} as const satisfies JSONSchema;

const listQuerySchema = {
  type: "object",
  properties: {
    siteId: { type: "string", format: "uuid" },
  },
} as const satisfies JSONSchema;

const updateBodySchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    description: { type: "string" },
    hosting: { type: "string", enum: ["SELF", "ROCKWARE"] },
    metadata: { type: "object", additionalProperties: true },
    siteId: { type: "string", format: "uuid" },
  },
} as const satisfies JSONSchema;

const createTokenBodySchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    expiresIn: { type: "number" },
  },
} as const satisfies JSONSchema;

const tokenIdParamsSchema = {
  type: "object",
  properties: {
    id: { type: "string", format: "uuid" },
    tokenId: { type: "string", format: "uuid" },
  },
  required: ["id", "tokenId"],
} as const satisfies JSONSchema;

const gatewayCommandSchema = {
  type: "string",
  enum: gateway.VALID_COMMANDS,
} as const satisfies JSONSchema;

const queueCommandBodySchema = {
  type: "object",
  properties: {
    command: gatewayCommandSchema,
    payload: { type: "object", additionalProperties: true },
    expiresIn: { type: "number" },
  },
  required: ["command"],
} as const satisfies JSONSchema;

const commandsQuerySchema = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["PENDING", "ACK", "COMPLETED", "FAILED", "EXPIRED"] },
    limit: { type: "number", default: 50 },
  },
} as const satisfies JSONSchema;

const commandIdParamsSchema = {
  type: "object",
  properties: {
    id: { type: "string", format: "uuid" },
    commandId: { type: "string", format: "uuid" },
  },
  required: ["id", "commandId"],
} as const satisfies JSONSchema;

const listGatewaysResponseSchema = {
  type: "array",
  items: gatewayWithSiteSchema,
} as const satisfies JSONSchema;

const getGatewayResponseSchema = {
  type: "object",
  properties: {
    ...gatewayProperties,
    site: siteSummarySchema,
    datasources: { type: "array", items: { type: "object", additionalProperties: true } },
    tokens: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          name: { type: "string", nullable: true },
          createdAt: { type: "string", format: "date-time" },
          expiresAt: { type: ["string", "null"], format: "date-time" },
          revokedAt: { type: ["string", "null"], format: "date-time" },
          lastUsed: { type: ["string", "null"], format: "date-time" },
        },
      },
    },
  },
} as const satisfies JSONSchema;

const getGatewaySpecResponseSchema = {
  type: "object",
  properties: {
    version: { type: "number" },
    updatedAt: { type: "string", format: "date-time" },
    spec: { type: "object", additionalProperties: true },
  },
} as const satisfies JSONSchema;

const createTokenResponseSchema = {
  type: "object",
  properties: {
    id: { type: "string", format: "uuid" },
    name: { type: "string", nullable: true },
    token: { type: "string" },
    createdAt: { type: "string", format: "date-time" },
    expiresAt: { type: ["string", "null"], format: "date-time" },
  },
} as const satisfies JSONSchema;

const revokeTokenResponseSchema = {
  type: "object",
  properties: {
    success: { type: "boolean" },
    revokedAt: { type: "string", format: "date-time" },
  },
} as const satisfies JSONSchema;

const listCommandsResponseSchema = {
  type: "array",
  items: commandSchema,
} as const satisfies JSONSchema;

// Helper to map error codes to HTTP status
function getStatusForCode(code: string): 401 | 404 | 400 | 500 {
  switch (code) {
    case "WORKSPACE_MISMATCH":
      return 401;
    case "SITE_NOT_FOUND":
    case "GATEWAY_NOT_FOUND":
      return 404;
    default:
      return 500;
  }
}

export default async function gateways(fastify: FastifyTypedInstance) {
  // Create gateway
  fastify.route({
    method: "POST",
    url: "/",
    preHandler: [fastify.verifyAccessToken],
    schema: {
      tags: ["gateways"],
      security: [{ bearerAuth: [] }],
      body: createBodySchema,
      response: {
        201: gatewayWithSiteSchema,
        400: errorSchema,
        401: errorSchema,
        404: errorSchema,
        500: errorSchema,
      },
    },
    handler: async (request, reply) => {
      const workspaceId = (request.iam as { workspaceId?: string } | undefined)?.workspaceId;
      if (!workspaceId) {
        return reply.status(401).send({ error: "No workspace context" });
      }

      try {
        const result = await gateway.create({ ...request.body, workspaceId });
        if ("error" in result) {
          return reply.status(getStatusForCode(result.code ?? "UNKNOWN")).send({ error: result.error });
        }
        return reply.status(201).send(result.data);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Unknown error";
        return reply.status(500).send({ error: message });
      }
    },
  });

  // List gateways
  fastify.route({
    method: "GET",
    url: "/",
    preHandler: [fastify.verifyAccessToken],
    schema: {
      tags: ["gateways"],
      security: [{ bearerAuth: [] }],
      querystring: listQuerySchema,
      response: {
        200: listGatewaysResponseSchema,
        401: errorSchema,
      },
    },
    handler: async (request, reply) => {
      const workspaceId = (request.iam as { workspaceId?: string } | undefined)?.workspaceId;
      if (!workspaceId) {
        return reply.status(401).send({ error: "No workspace context" });
      }

      const { siteId } = request.query;
      return gateway.list({ siteId, workspaceId });
    },
  });

  // Get gateway by ID
  fastify.route({
    method: "GET",
    url: "/:id",
    preHandler: [fastify.verifyAccessToken],
    schema: {
      tags: ["gateways"],
      security: [{ bearerAuth: [] }],
      params: idParamsSchema,
      response: {
        200: getGatewayResponseSchema,
        401: errorSchema,
        404: errorSchema,
      },
    },
    handler: async (request, reply) => {
      const workspaceId = (request.iam as { workspaceId?: string } | undefined)?.workspaceId;
      if (!workspaceId) {
        return reply.status(401).send({ error: "No workspace context" });
      }

      const result = await gateway.getById(request.params.id, workspaceId);
      if (!result) {
        return reply.status(404).send({ error: "Gateway not found" });
      }
      if ("error" in result) {
        return reply.status(401).send({ error: result.error });
      }
      return result.data;
    },
  });

  // Get gateway spec
  fastify.route({
    method: "GET",
    url: "/:id/spec",
    preHandler: [fastify.verifyAccessToken],
    schema: {
      tags: ["gateways"],
      security: [{ bearerAuth: [] }],
      params: idParamsSchema,
      response: {
        200: getGatewaySpecResponseSchema,
        401: errorSchema,
        404: errorSchema,
      },
    },
    handler: async (request, reply) => {
      const result = await gateway.getGatewaySpec(request.params.id);
      if (!result) {
        return reply.status(404).send({ error: "Gateway not found" });
      }
      return result;
    },
  });

  // Update gateway
  fastify.route({
    method: "PUT",
    url: "/:id",
    preHandler: [fastify.verifyAccessToken],
    schema: {
      tags: ["gateways"],
      security: [{ bearerAuth: [] }],
      params: idParamsSchema,
      body: updateBodySchema,
      response: {
        200: gatewayWithSiteSchema,
        400: errorSchema,
        401: errorSchema,
        404: errorSchema,
        500: errorSchema,
      },
    },
    handler: async (request, reply) => {
      const workspaceId = (request.iam as { workspaceId?: string } | undefined)?.workspaceId;
      if (!workspaceId) {
        return reply.status(401).send({ error: "No workspace context" });
      }

      const result = await gateway.update(request.params.id, { ...request.body, workspaceId });
      if ("error" in result) {
        return reply.status(getStatusForCode(result.code ?? "UNKNOWN")).send({ error: result.error });
      }
      return result.data;
    },
  });

  // Delete gateway
  fastify.route({
    method: "DELETE",
    url: "/:id",
    preHandler: [fastify.verifyAccessToken],
    schema: {
      tags: ["gateways"],
      security: [{ bearerAuth: [] }],
      params: idParamsSchema,
      response: {
        200: successResponseSchema,
        401: errorSchema,
        404: errorSchema,
        500: errorSchema,
      },
    },
    handler: async (request, reply) => {
      const workspaceId = (request.iam as { workspaceId?: string } | undefined)?.workspaceId;
      if (!workspaceId) {
        return reply.status(401).send({ error: "No workspace context" });
      }

      const result = await gateway.remove(request.params.id, workspaceId);
      if ("error" in result) {
        // remove only returns GATEWAY_NOT_FOUND (404) or WORKSPACE_MISMATCH (401)
        const status = result.code === "WORKSPACE_MISMATCH" ? 401 : 404;
        return reply.status(status).send({ error: result.error });
      }
      return { success: true };
    },
  });

  // Create token
  fastify.route({
    method: "POST",
    url: "/:id/tokens",
    preHandler: [fastify.verifyAccessToken],
    schema: {
      tags: ["gateways"],
      security: [{ bearerAuth: [] }],
      params: idParamsSchema,
      body: createTokenBodySchema,
      response: {
        201: createTokenResponseSchema,
        401: errorSchema,
        404: errorSchema,
      },
    },
    handler: async (request, reply) => {
      if (!(await gateway.exists(request.params.id))) {
        return reply.status(404).send({ error: "Gateway not found" });
      }
      const result = await gateway.tokens.create({
        gatewayId: request.params.id,
        name: request.body?.name,
        expiresIn: request.body?.expiresIn,
      });
      return reply.status(201).send(result);
    },
  });

  // Revoke token
  fastify.route({
    method: "DELETE",
    url: "/:id/tokens/:tokenId",
    preHandler: [fastify.verifyAccessToken],
    schema: {
      tags: ["gateways"],
      security: [{ bearerAuth: [] }],
      params: tokenIdParamsSchema,
      response: {
        200: revokeTokenResponseSchema,
        401: errorSchema,
        404: errorSchema,
      },
    },
    handler: async (request, reply) => {
      const result = await gateway.tokens.revoke(request.params.id, request.params.tokenId);
      if (!result) {
        return reply.status(404).send({ error: "Token not found" });
      }
      if (result.alreadyRevoked) {
        return reply.status(404).send({ error: "Token already revoked" });
      }
      return result;
    },
  });

  // Queue command
  fastify.route({
    method: "POST",
    url: "/:id/commands",
    preHandler: [fastify.verifyAccessToken],
    schema: {
      tags: ["gateways"],
      security: [{ bearerAuth: [] }],
      params: idParamsSchema,
      body: queueCommandBodySchema,
      response: {
        201: commandSchema,
        401: errorSchema,
        404: errorSchema,
      },
    },
    handler: async (request, reply) => {
      if (!(await gateway.exists(request.params.id))) {
        return reply.status(404).send({ error: "Gateway not found" });
      }
      const cmd = await gateway.commands.queue({
        gatewayId: request.params.id,
        command: request.body.command,
        payload: request.body.payload,
        expiresIn: request.body.expiresIn,
      });
      return reply.status(201).send(cmd);
    },
  });

  // List commands
  fastify.route({
    method: "GET",
    url: "/:id/commands",
    preHandler: [fastify.verifyAccessToken],
    schema: {
      tags: ["gateways"],
      security: [{ bearerAuth: [] }],
      params: idParamsSchema,
      querystring: commandsQuerySchema,
      response: {
        200: listCommandsResponseSchema,
        401: errorSchema,
        404: errorSchema,
      },
    },
    handler: async (request, reply) => {
      if (!(await gateway.exists(request.params.id))) {
        return reply.status(404).send({ error: "Gateway not found" });
      }
      return gateway.commands.list(request.params.id, request.query);
    },
  });

  // Get command
  fastify.route({
    method: "GET",
    url: "/:id/commands/:commandId",
    preHandler: [fastify.verifyAccessToken],
    schema: {
      tags: ["gateways"],
      security: [{ bearerAuth: [] }],
      params: commandIdParamsSchema,
      response: {
        200: commandSchema,
        401: errorSchema,
        404: errorSchema,
      },
    },
    handler: async (request, reply) => {
      const cmd = await gateway.commands.getById(request.params.id, request.params.commandId);
      if (!cmd) {
        return reply.status(404).send({ error: "Command not found" });
      }
      return cmd;
    },
  });

  // Cancel command
  fastify.route({
    method: "DELETE",
    url: "/:id/commands/:commandId",
    preHandler: [fastify.verifyAccessToken],
    schema: {
      tags: ["gateways"],
      security: [{ bearerAuth: [] }],
      params: commandIdParamsSchema,
      response: {
        200: successResponseSchema,
        400: errorSchema,
        401: errorSchema,
        404: errorSchema,
      },
    },
    handler: async (request, reply) => {
      const result = await gateway.commands.cancel(request.params.id, request.params.commandId);
      if (result.error === "not_found") {
        return reply.status(404).send({ error: "Command not found" });
      }
      if (result.error === "not_pending") {
        return reply.status(400).send({ error: "Can only cancel pending commands" });
      }
      return { success: true };
    },
  });
}
