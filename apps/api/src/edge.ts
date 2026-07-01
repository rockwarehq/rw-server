import type { JSONSchema } from "json-schema-to-ts";
import type { FastifyTypedInstance } from "./types/fastify.js";
import type { FastifyRequest, FastifyReply } from "fastify";
import { gateway } from "./services/device/index.js";
import prisma from "@rw/db";
import { errorSchema } from "./api/schemas.js";
import { gatewayNatsConfig } from "./config.js";

async function validateGatewayToken(request: FastifyRequest, reply: FastifyReply) {
  const authHeader = request.headers.authorization;

  if (!authHeader?.startsWith("Bearer ")) {
    reply.status(401).send({ error: "Missing or invalid authorization header" });
    return null;
  }

  const token = authHeader.slice(7);
  const result = await gateway.tokens.validate(token);

  if (!result) {
    reply.status(401).send({ error: "Invalid or expired token" });
    return null;
  }

  if (result.gateway.status === "DISABLED") {
    reply.status(403).send({ error: "Gateway is disabled" });
    return null;
  }

  return result;
}

const claimBodySchema = {
  type: "object",
  properties: {
    serialNumber: { type: "string" },
    claimCode: { type: "string" },
  },
  required: ["serialNumber", "claimCode"],
} as const satisfies JSONSchema;

const connectBodySchema = {
  type: "object",
  properties: {
    version: { type: "string" },
    metadata: { type: "object", additionalProperties: true },
  },
} as const satisfies JSONSchema;

const syncBodySchema = {
  type: "object",
  properties: {
    version: { type: "number" },
    health: { type: "object", additionalProperties: true },
    metrics: { type: "object", additionalProperties: true },
  },
} as const satisfies JSONSchema;

const disconnectBodySchema = {
  type: "object",
  properties: { reason: { type: "string" } },
} as const satisfies JSONSchema;

const authHeaderSchema = {
  type: "object",
  properties: { authorization: { type: "string" } },
  required: ["authorization"],
} as const satisfies JSONSchema;

const claimResponseSchema = {
  type: "object",
  properties: {
    success: { type: "boolean" },
    gatewayId: { type: "string", format: "uuid" },
    token: { type: "string" },
  },
} as const satisfies JSONSchema;

const connectResponseSchema = {
  type: "object",
  properties: {
    success: { type: "boolean" },
    gatewayId: { type: "string", format: "uuid" },
    serialNumber: { type: "string" },
    status: { type: "string" },
    connectedAt: { type: "string", format: "date-time" },
    nats: {
      type: "object",
      properties: {
        servers: { type: "array", items: { type: "string" } },
        user: { type: "string" },
        pass: { type: "string" },
      },
    },
  },
} as const satisfies JSONSchema;

const syncResponseSchema = {
  type: "object",
  properties: {
    version: { type: "number" },
    spec: { type: "object", additionalProperties: true },
    upToDate: { type: "boolean" },
  },
} as const satisfies JSONSchema;

const disconnectResponseSchema = {
  type: "object",
  properties: {
    success: { type: "boolean" },
    gatewayId: { type: "string", format: "uuid" },
    disconnectedAt: { type: "string", format: "date-time" },
  },
} as const satisfies JSONSchema;

export default async function edge(fastify: FastifyTypedInstance) {
  // Claim - exchange serial number + claim code for a token
  fastify.route({
    method: "POST",
    url: "/claim",
    schema: {
      tags: ["edge"],
      body: claimBodySchema,
      response: {
        200: claimResponseSchema,
        400: errorSchema,
        404: errorSchema,
      },
    },
    handler: async (request, reply) => {
      const { serialNumber, claimCode } = request.body;

      const gw = await gateway.crud.getBySerialNumber(serialNumber);

      if (!gw) {
        return reply.status(404).send({ error: "Gateway not found" });
      }

      if (!gw.claimCode) {
        return reply.status(400).send({ error: "Gateway already claimed" });
      }

      if (gw.claimCode !== claimCode) {
        return reply.status(400).send({ error: "Invalid claim code" });
      }

      if (gw.status === "DISABLED") {
        return reply.status(400).send({ error: "Gateway is disabled" });
      }

      // Create token and clear claim code in a transaction
      const token = await gateway.tokens.createClaimToken(gw.id);
      await gateway.tokens.clearClaimCode(gw.id);

      return {
        success: true,
        gatewayId: gw.id,
        token,
      };
    },
  });

  // Connect
  fastify.route({
    method: "POST",
    url: "/connect",
    schema: {
      tags: ["edge"],
      security: [{ bearerAuth: [] }],
      headers: authHeaderSchema,
      body: connectBodySchema,
      response: {
        200: connectResponseSchema,
        401: errorSchema,
        403: errorSchema,
      },
    },
    handler: async (request, reply) => {
      const auth = await validateGatewayToken(request, reply);
      if (!auth) return;

      const { version, metadata } = request.body || {};
      const connectedAt = new Date();

      const existingMetadata = (auth.gateway.metadata || {}) as Record<string, unknown>;
      const newMetadata = {
        ...existingMetadata,
        ...(metadata || {}),
        lastConnectVersion: version,
        lastConnectAt: connectedAt.toISOString(),
      };

      const gw = await gateway.updateStatus(auth.gateway.id, "ONLINE", {
        lastHeartbeat: connectedAt,
        metadata: newMetadata,
      });

      return {
        success: true,
        gatewayId: gw.id,
        serialNumber: gw.serialNumber,
        status: gw.status,
        connectedAt,
        nats: {
          servers: gatewayNatsConfig.servers,
          user: gatewayNatsConfig.user,
          pass: gatewayNatsConfig.pass,
        },
      };
    },
  });

  // Sync - heartbeat + get spec + get commands
  fastify.route({
    method: "POST",
    url: "/sync",
    schema: {
      tags: ["edge"],
      security: [{ bearerAuth: [] }],
      headers: authHeaderSchema,
      body: syncBodySchema,
      response: {
        200: syncResponseSchema,
        401: errorSchema,
        403: errorSchema,
      },
    },
    handler: async (request, reply) => {
      const auth = await validateGatewayToken(request, reply);
      if (!auth) return;

      const { version, health, metrics } = request.body || {};

      // Update heartbeat, health, metrics
      await gateway.updateStatus(auth.gateway.id, "ONLINE", {
        lastHeartbeat: new Date(),
        ...(health && { health }),
        ...(metrics && { metrics }),
      });

      // Check if spec is up to date
      const gw = await prisma.gateway.findUnique({
        where: { id: auth.gateway.id },
        select: { specVersion: true },
      });

      const isUpToDate = version === gw?.specVersion;

      // Only compute spec if gateway needs it
      const spec = isUpToDate ? undefined : await gateway.buildSpec(auth.gateway.id);

      // Commands no longer ride the sync poll — they are delivered over
      // JetStream (RW_COMMANDS) and ack/result flow back over core NATS.
      // See apps/api/src/command-bus.ts.
      return {
        version: gw?.specVersion,
        ...(isUpToDate ? { upToDate: true } : { spec }),
      };
    },
  });

  // Disconnect
  fastify.route({
    method: "POST",
    url: "/disconnect",
    schema: {
      tags: ["edge"],
      security: [{ bearerAuth: [] }],
      headers: authHeaderSchema,
      body: disconnectBodySchema,
      response: {
        200: disconnectResponseSchema,
        401: errorSchema,
        403: errorSchema,
      },
    },
    handler: async (request, reply) => {
      const auth = await validateGatewayToken(request, reply);
      if (!auth) return;

      const { reason } = request.body || {};
      const disconnectedAt = new Date();

      const existingMetadata = (auth.gateway.metadata || {}) as Record<string, unknown>;
      const newMetadata = {
        ...existingMetadata,
        lastDisconnectAt: disconnectedAt.toISOString(),
        lastDisconnectReason: reason,
      };

      await gateway.updateStatus(auth.gateway.id, "OFFLINE", {
        metadata: newMetadata,
      });

      return {
        success: true,
        gatewayId: auth.gateway.id,
        disconnectedAt,
      };
    },
  });
}
