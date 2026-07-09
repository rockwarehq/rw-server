import type { JSONSchema } from "json-schema-to-ts";
import type { FastifyTypedInstance } from "../types/fastify.js";
import * as auth from "../auth/index.js";
import { errorSchema, successResponseSchema } from "./schemas.js";
import { refreshRateLimit, sensitiveRateLimit } from "../plugins/ratelimit.js";

const tokenResponseSchema = {
  type: "object",
  properties: {
    accessToken: { type: "string" },
    refreshToken: { type: "string" },
    expiresAt: { type: "string", format: "date-time" },
  },
} as const satisfies JSONSchema;

const userSchema = {
  type: "object",
  properties: {
    id: { type: "string", format: "uuid" },
    email: { type: "string", format: "email" },
    firstName: { type: "string", nullable: true },
    lastName: { type: "string", nullable: true },
  },
} as const satisfies JSONSchema;

const loginBodySchema = {
  type: "object",
  properties: {
    email: { type: "string", format: "email" },
    password: { type: "string", minLength: 1 },
  },
  required: ["email", "password"],
} as const satisfies JSONSchema;

const logoutBodySchema = {
  type: "object",
  properties: {
    refreshToken: { type: "string" },
  },
  required: ["refreshToken"],
} as const satisfies JSONSchema;

const refreshBodySchema = {
  type: "object",
  properties: {
    refreshToken: { type: "string" },
    siteId: { type: "string", format: "uuid" },
  },
  required: ["refreshToken"],
} as const satisfies JSONSchema;

const displayLoginBodySchema = {
  type: "object",
  properties: {
    displayId: { type: "string", format: "uuid" },
    bootstrapSecret: { type: "string", minLength: 1 },
  },
  required: ["displayId", "bootstrapSecret"],
} as const satisfies JSONSchema;

const displaySchema = {
  type: "object",
  properties: {
    id: { type: "string", format: "uuid" },
    name: { type: "string", nullable: true },
    status: { type: "string" },
    siteId: { type: "string", format: "uuid" },
    dashboardId: { type: "string", format: "uuid", nullable: true },
    workcenterId: { type: "string", format: "uuid", nullable: true },
    stationId: { type: "string", format: "uuid", nullable: true },
    workspaceId: { type: "string", format: "uuid" },
  },
} as const satisfies JSONSchema;

const switchWorkspaceBodySchema = {
  type: "object",
  properties: {
    workspaceId: { type: "string", format: "uuid" },
  },
  required: ["workspaceId"],
} as const satisfies JSONSchema;

const switchSiteBodySchema = {
  type: "object",
  properties: {
    siteId: { type: "string", format: "uuid" },
  },
  required: ["siteId"],
} as const satisfies JSONSchema;

const loginResponseSchema = {
  type: "object",
  properties: {
    accessToken: { type: "string" },
    refreshToken: { type: "string" },
    expiresAt: { type: "string", format: "date-time" },
    user: userSchema,
  },
} as const satisfies JSONSchema;

const displayLoginResponseSchema = {
  type: "object",
  properties: {
    accessToken: { type: "string" },
    refreshToken: { type: "string" },
    expiresAt: { type: "string", format: "date-time" },
    display: displaySchema,
  },
} as const satisfies JSONSchema;

const switchWorkspaceResponseSchema = {
  type: "object",
  properties: {
    accessToken: { type: "string" },
  },
} as const satisfies JSONSchema;

export default async function authRoutes(fastify: FastifyTypedInstance) {
  // Login - rate limited
  fastify.route({
    method: "POST",
    url: "/login",
    config: sensitiveRateLimit,
    schema: {
      tags: ["auth"],
      body: loginBodySchema,
      response: {
        200: loginResponseSchema,
        401: errorSchema,
      },
    },
    handler: async (request, reply) => {
      const { email, password } = request.body;
      const metadata = {
        userAgent: request.headers["user-agent"],
        ipAddress: request.ip,
      };

      const result = await auth.login(email, password, metadata);

      if (result.success) {
        return result.data;
      }

      return reply.status(401).send({ error: result.error });
    },
  });

  // Logout
  fastify.route({
    method: "POST",
    url: "/logout",
    schema: {
      tags: ["auth"],
      body: logoutBodySchema,
      response: {
        200: successResponseSchema,
      },
    },
    handler: async (request) => {
      const { refreshToken } = request.body;
      await auth.logout(refreshToken, {
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"],
      });
      return { success: true };
    },
  });

  // Refresh token
  fastify.route({
    method: "POST",
    url: "/refresh",
    config: refreshRateLimit,
    schema: {
      tags: ["auth"],
      body: refreshBodySchema,
      response: {
        200: tokenResponseSchema,
        401: errorSchema,
      },
    },
    handler: async (request, reply) => {
      const { refreshToken, siteId } = request.body;
      const metadata = {
        userAgent: request.headers["user-agent"],
        ipAddress: request.ip,
      };

      const result = await auth.refreshSession(refreshToken, siteId, metadata);

      if (result.success) {
        return result.data;
      }

      return reply.status(401).send({ error: result.error });
    },
  });

  // Display login - exchange bootstrap secret for session tokens
  fastify.route({
    method: "POST",
    url: "/display/login",
    config: sensitiveRateLimit,
    schema: {
      tags: ["auth"],
      body: displayLoginBodySchema,
      response: {
        200: displayLoginResponseSchema,
        401: errorSchema,
      },
    },
    handler: async (request, reply) => {
      const { displayId, bootstrapSecret } = request.body;
      const metadata = {
        userAgent: request.headers["user-agent"],
        ipAddress: request.ip,
      };

      const result = await auth.loginDisplay(displayId, bootstrapSecret, metadata);

      if (result.success) {
        return result.data;
      }

      return reply.status(401).send({ error: result.error });
    },
  });

  // Display refresh token
  fastify.route({
    method: "POST",
    url: "/display/refresh",
    config: refreshRateLimit,
    schema: {
      tags: ["auth"],
      body: refreshBodySchema,
      response: {
        200: tokenResponseSchema,
        401: errorSchema,
      },
    },
    handler: async (request, reply) => {
      const { refreshToken } = request.body;
      const metadata = {
        userAgent: request.headers["user-agent"],
        ipAddress: request.ip,
      };

      const result = await auth.refreshDisplaySession(refreshToken, metadata);

      if (result.success) {
        return result.data;
      }

      return reply.status(401).send({ error: result.error });
    },
  });

  // Display logout
  fastify.route({
    method: "POST",
    url: "/display/logout",
    schema: {
      tags: ["auth"],
      body: logoutBodySchema,
      response: {
        200: successResponseSchema,
      },
    },
    handler: async (request) => {
      const { refreshToken } = request.body;
      await auth.logoutDisplay(refreshToken);
      return { success: true };
    },
  });

  // Switch workspace (requires auth)
  fastify.route({
    method: "POST",
    url: "/switch-workspace",
    preHandler: [fastify.verifyAccessToken],
    schema: {
      tags: ["auth"],
      security: [{ bearerAuth: [] }],
      body: switchWorkspaceBodySchema,
      response: {
        200: switchWorkspaceResponseSchema,
        401: errorSchema,
        403: errorSchema,
      },
    },
    handler: async (request, reply) => {
      const { workspaceId } = request.body;
      const userId = request.iam?.id;

      if (!userId) {
        return reply.status(401).send({ error: "Unauthorized" });
      }

      const result = await auth.switchWorkspace(userId, workspaceId);

      if (result.success) {
        return result.data;
      }

      return reply.status(403).send({ error: result.error });
    },
  });

  // Switch selected site (requires auth)
  fastify.route({
    method: "POST",
    url: "/switch-site",
    preHandler: [fastify.verifyAccessToken],
    schema: {
      tags: ["auth"],
      security: [{ bearerAuth: [] }],
      body: switchSiteBodySchema,
      response: {
        200: switchWorkspaceResponseSchema,
        401: errorSchema,
        403: errorSchema,
      },
    },
    handler: async (request, reply) => {
      const { siteId } = request.body;
      const userId = request.iam?.id;

      if (!userId) {
        return reply.status(401).send({ error: "Unauthorized" });
      }

      const result = await auth.switchSite(userId, siteId);

      if (result.success) {
        return result.data;
      }

      return reply.status(403).send({ error: result.error });
    },
  });
}
