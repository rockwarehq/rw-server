import type { JSONSchema } from "json-schema-to-ts";
import type { FastifyTypedInstance } from "../types/fastify.js";
import { user } from "../services/account/index.js";
import { errorSchema, idParamsSchema, successResponseSchema } from "./schemas.js";
import { sensitiveRateLimit } from "../plugins/ratelimit.js";
import { requirePermission } from "../plugins/require-permission.js";

const userSchema = {
  type: "object",
  properties: {
    id: { type: "string", format: "uuid" },
    email: { type: "string", format: "email" },
    firstName: { type: "string", nullable: true },
    lastName: { type: "string", nullable: true },
    status: { type: "string", enum: ["PENDING", "ACTIVE", "DISABLED"] },
    lastLoginAt: { type: "string", format: "date-time", nullable: true },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
  },
} as const satisfies JSONSchema;

const updateMeBodySchema = {
  type: "object",
  properties: {
    firstName: { type: "string" },
    lastName: { type: "string" },
  },
} as const satisfies JSONSchema;

const changePasswordBodySchema = {
  type: "object",
  properties: {
    currentPassword: { type: "string", minLength: 1 },
    newPassword: { type: "string", minLength: 12 },
  },
  required: ["currentPassword", "newPassword"],
} as const satisfies JSONSchema;

const listUsersQuerySchema = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["PENDING", "ACTIVE", "DISABLED"] },
    search: { type: "string" },
    limit: { type: "number", default: 50 },
    offset: { type: "number", default: 0 },
  },
} as const satisfies JSONSchema;

const inviteBodySchema = {
  type: "object",
  properties: {
    email: { type: "string", format: "email" },
    // Role id for new invites. Required when creating a new invite, optional
    // when resending an existing pending invite.
    roleId: { type: "string", format: "uuid" },
    // Required for site-scoped roles unless the caller's token has site context.
    siteId: { type: "string", format: "uuid" },
  },
  required: ["email"],
} as const satisfies JSONSchema;

const verifyInviteBodySchema = {
  type: "object",
  properties: {
    token: { type: "string", minLength: 1 },
  },
  required: ["token"],
} as const satisfies JSONSchema;

const completeInviteBodySchema = {
  type: "object",
  properties: {
    token: { type: "string", minLength: 1 },
    password: { type: "string", minLength: 12 },
    firstName: { type: "string" },
    lastName: { type: "string" },
    employeeNumber: { type: "string", nullable: true },
    badgeNumber: { type: "string", nullable: true },
    pin: { type: "string", minLength: 4, maxLength: 8 },
  },
  required: ["token", "password"],
} as const satisfies JSONSchema;

const forgotPasswordBodySchema = {
  type: "object",
  properties: {
    email: { type: "string", format: "email" },
  },
  required: ["email"],
} as const satisfies JSONSchema;

const resetPasswordBodySchema = {
  type: "object",
  properties: {
    token: { type: "string", minLength: 1 },
    password: { type: "string", minLength: 12 },
  },
  required: ["token", "password"],
} as const satisfies JSONSchema;

const updateUserBodySchema = {
  type: "object",
  properties: {
    firstName: { type: "string" },
    lastName: { type: "string" },
    email: { type: "string", format: "email" },
  },
} as const satisfies JSONSchema;

const employeeProfileSchema = {
  type: "object",
  nullable: true,
  properties: {
    id: { type: "string", format: "uuid" },
    status: { type: "string", enum: ["ACTIVE", "INACTIVE"] },
    firstName: { type: "string" },
    lastName: { type: "string" },
    employeeNumber: { type: ["string", "null"] },
    badgeNumber: { type: ["string", "null"] },
  },
} as const satisfies JSONSchema;

const currentWorkspaceSchema = {
  type: "object",
  properties: {
    id: { type: "string", format: "uuid" },
    name: { type: "string" },
    slug: { type: "string" },
  },
} as const satisfies JSONSchema;

const currentSiteRefSchema = {
  type: "object",
  properties: {
    id: { type: "string", format: "uuid" },
    name: { type: "string" },
  },
} as const satisfies JSONSchema;

const currentSiteSchema = {
  ...currentSiteRefSchema,
  nullable: true,
} as const satisfies JSONSchema;

const accessRoleSchema = {
  type: "object",
  properties: {
    id: { type: "string", format: "uuid" },
    name: { type: "string" },
    scope: { type: "string", enum: ["WORKSPACE", "SITE"] },
  },
} as const satisfies JSONSchema;

const getMeResponseSchema = {
  type: "object",
  properties: {
    user: {
      type: "object",
      properties: {
        id: { type: "string", format: "uuid" },
        email: { type: "string", format: "email" },
        status: { type: "string", enum: ["PENDING", "ACTIVE", "DISABLED"] },
      },
    },
    employee: employeeProfileSchema,
    workspace: { ...currentWorkspaceSchema, nullable: true },
    site: currentSiteSchema,
    sites: {
      type: "array",
      items: currentSiteRefSchema,
    },
    access: {
      type: "object",
      properties: {
        roles: { type: "array", items: accessRoleSchema },
        permissions: { type: "array", items: { type: "string" } },
      },
    },
  },
} as const satisfies JSONSchema;

const listUsersResponseSchema = {
  type: "object",
  properties: {
    users: { type: "array", items: userSchema },
    total: { type: "number" },
    limit: { type: "number" },
    offset: { type: "number" },
  },
} as const satisfies JSONSchema;

// Updated: no longer returns inviteToken
const inviteResponseSchema = {
  type: "object",
  properties: {
    user: {
      type: "object",
      properties: {
        id: { type: "string", format: "uuid" },
        email: { type: "string" },
        status: { type: "string" },
      },
    },
    expiresAt: { type: "string", format: "date-time" },
    emailSent: { type: "boolean" },
  },
} as const satisfies JSONSchema;

const verifyInviteResponseSchema = {
  type: "object",
  properties: {
    valid: { type: "boolean" },
    user: {
      type: "object",
      properties: {
        id: { type: "string", format: "uuid" },
        email: { type: "string" },
      },
    },
    error: { type: "string" },
  },
} as const satisfies JSONSchema;

const completeInviteResponseSchema = {
  type: "object",
  properties: {
    id: { type: "string", format: "uuid" },
    email: { type: "string" },
  },
} as const satisfies JSONSchema;

// Updated: no longer returns resetToken
const forgotPasswordResponseSchema = {
  type: "object",
  properties: {
    message: { type: "string" },
  },
} as const satisfies JSONSchema;

const errorWithDetailsSchema = {
  type: "object",
  properties: {
    error: { type: "string" },
    details: {
      type: "array",
      items: { type: "string" },
    },
  },
} as const satisfies JSONSchema;

const lockStatusResponseSchema = {
  type: "object",
  properties: {
    isLocked: { type: "boolean" },
    failedAttempts: { type: "number" },
    lockedUntil: { type: "string", format: "date-time", nullable: true },
  },
} as const satisfies JSONSchema;

export default async function userRoutes(fastify: FastifyTypedInstance) {
  // Get current user (me)
  fastify.route({
    method: "GET",
    url: "/me",
    preHandler: [fastify.verifyAccessToken],
    schema: {
      tags: ["users"],
      security: [{ bearerAuth: [] }],
      response: {
        200: getMeResponseSchema,
        401: errorSchema,
      },
    },
    handler: async (request, reply) => {
      const userId = request.iam?.id;
      if (!userId) {
        return reply.status(401).send({ error: "Unauthorized" });
      }

      const result = await user.getMe(userId, request.iam?.workspaceId, request.iam?.siteId);
      if (!result) {
        return reply.status(401).send({ error: "User not found" });
      }

      return result;
    },
  });

  // Update current user
  fastify.route({
    method: "PUT",
    url: "/me",
    preHandler: [fastify.verifyAccessToken],
    schema: {
      tags: ["users"],
      security: [{ bearerAuth: [] }],
      body: updateMeBodySchema,
      response: {
        200: userSchema,
        401: errorSchema,
      },
    },
    handler: async (request, reply) => {
      const userId = request.iam?.id;
      if (!userId) {
        return reply.status(401).send({ error: "Unauthorized" });
      }

      return user.update(userId, request.body);
    },
  });

  // Change password
  fastify.route({
    method: "PUT",
    url: "/me/password",
    preHandler: [fastify.verifyAccessToken],
    schema: {
      tags: ["users"],
      security: [{ bearerAuth: [] }],
      body: changePasswordBodySchema,
      response: {
        200: successResponseSchema,
        400: errorWithDetailsSchema,
        401: errorSchema,
      },
    },
    handler: async (request, reply) => {
      const userId = request.iam?.id;
      if (!userId) {
        return reply.status(401).send({ error: "Unauthorized" });
      }

      const { currentPassword, newPassword } = request.body;
      const result = await user.changePassword(userId, currentPassword, newPassword, {
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"],
      });

      if (result.success) {
        return { success: true };
      }

      if ("details" in result && result.details) {
        return reply.status(400).send({ error: result.error, details: result.details });
      }
      return reply.status(400).send({ error: result.error });
    },
  });

  // List users (requires user:read)
  fastify.route({
    method: "GET",
    url: "/",
    preHandler: [fastify.verifyAccessToken, requirePermission("user:read", { scope: "workspace" })],
    schema: {
      tags: ["users"],
      security: [{ bearerAuth: [] }],
      querystring: listUsersQuerySchema,
      response: {
        200: listUsersResponseSchema,
        401: errorSchema,
        403: errorSchema,
      },
    },
    handler: async (request) => {
      return user.list(request.query);
    },
  });

  // Invite user (requires user:write)
  fastify.route({
    method: "POST",
    url: "/invite",
    preHandler: [fastify.verifyAccessToken],
    schema: {
      tags: ["users"],
      security: [{ bearerAuth: [] }],
      body: inviteBodySchema,
      response: {
        201: inviteResponseSchema,
        400: errorSchema,
        401: errorSchema,
        403: errorSchema,
      },
    },
    handler: async (request, reply) => {
      const workspaceId = request.iam?.workspaceId;
      const inviterId = request.iam?.id;

      if (!inviterId || !workspaceId) {
        return reply.status(401).send({ error: "Unauthorized" });
      }

      const { email, roleId, siteId } = request.body;
      const result = await user.createInvite({
        email,
        inviterId,
        workspaceId,
        roleId,
        siteId,
        fallbackSiteId: request.iam?.siteId,
        context: {
          ipAddress: request.ip,
          userAgent: request.headers["user-agent"],
        },
      });

      if (result.success) {
        return reply.status(201).send(result.data);
      }

      return reply.status(result.error === "Forbidden" ? 403 : 400).send({ error: result.error });
    },
  });

  // Verify invite token (public) - rate limited
  fastify.route({
    method: "POST",
    url: "/invite/verify",
    config: sensitiveRateLimit,
    schema: {
      tags: ["users"],
      body: verifyInviteBodySchema,
      response: {
        200: verifyInviteResponseSchema,
      },
    },
    handler: async (request) => {
      const { token } = request.body;
      return user.verifyInviteToken(token, {
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"],
      });
    },
  });

  // Complete invite (public) - rate limited
  fastify.route({
    method: "POST",
    url: "/invite/complete",
    config: sensitiveRateLimit,
    schema: {
      tags: ["users"],
      body: completeInviteBodySchema,
      response: {
        200: completeInviteResponseSchema,
        400: errorWithDetailsSchema,
      },
    },
    handler: async (request, reply) => {
      const result = await user.completeInvite(request.body, {
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"],
      });

      if (result.success) {
        return result.data;
      }

      if ("details" in result && result.details) {
        return reply.status(400).send({ error: result.error, details: result.details });
      }
      return reply.status(400).send({ error: result.error });
    },
  });

  // Password reset request (public) - rate limited
  fastify.route({
    method: "POST",
    url: "/password/forgot",
    config: sensitiveRateLimit,
    schema: {
      tags: ["users"],
      body: forgotPasswordBodySchema,
      response: {
        200: forgotPasswordResponseSchema,
      },
    },
    handler: async (request) => {
      const { email } = request.body;
      await user.initiateReset(email, {
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"],
      });

      // Always return same message to prevent email enumeration
      return { message: "If an account exists with this email, a password reset link has been sent." };
    },
  });

  // Password reset (public) - rate limited
  fastify.route({
    method: "POST",
    url: "/password/reset",
    config: sensitiveRateLimit,
    schema: {
      tags: ["users"],
      body: resetPasswordBodySchema,
      response: {
        200: successResponseSchema,
        400: errorWithDetailsSchema,
      },
    },
    handler: async (request, reply) => {
      const { token, password } = request.body;
      const result = await user.resetPassword(token, password, {
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"],
      });

      if (result.success) {
        return { success: true };
      }

      if ("details" in result && result.details) {
        return reply.status(400).send({ error: result.error, details: result.details });
      }
      return reply.status(400).send({ error: result.error });
    },
  });

  // Get user by ID (requires user:read)
  fastify.route({
    method: "GET",
    url: "/:id",
    preHandler: [fastify.verifyAccessToken, requirePermission("user:read", { scope: "workspace" })],
    schema: {
      tags: ["users"],
      security: [{ bearerAuth: [] }],
      params: idParamsSchema,
      response: {
        200: userSchema,
        401: errorSchema,
        403: errorSchema,
        404: errorSchema,
      },
    },
    handler: async (request, reply) => {
      const result = await user.getById(request.params.id);
      if (!result) {
        return reply.status(404).send({ error: "User not found" });
      }
      return result;
    },
  });

  // Get user lock status (requires user:read)
  fastify.route({
    method: "GET",
    url: "/:id/lock-status",
    preHandler: [fastify.verifyAccessToken, requirePermission("user:read", { scope: "workspace" })],
    schema: {
      tags: ["users"],
      security: [{ bearerAuth: [] }],
      params: idParamsSchema,
      response: {
        200: lockStatusResponseSchema,
        401: errorSchema,
        403: errorSchema,
        404: errorSchema,
      },
    },
    handler: async (request, reply) => {
      const result = await user.getLockStatus(request.params.id);
      if (!result) {
        return reply.status(404).send({ error: "User not found" });
      }
      return result;
    },
  });

  // Update user (requires user:write)
  fastify.route({
    method: "PUT",
    url: "/:id",
    preHandler: [fastify.verifyAccessToken, requirePermission("user:write", { scope: "workspace" })],
    schema: {
      tags: ["users"],
      security: [{ bearerAuth: [] }],
      params: idParamsSchema,
      body: updateUserBodySchema,
      response: {
        200: userSchema,
        401: errorSchema,
        403: errorSchema,
        404: errorSchema,
      },
    },
    handler: async (request, reply) => {
      if (!(await user.exists(request.params.id))) {
        return reply.status(404).send({ error: "User not found" });
      }
      return user.update(request.params.id, request.body);
    },
  });

  // Disable user (requires user:admin)
  fastify.route({
    method: "POST",
    url: "/:id/disable",
    preHandler: [fastify.verifyAccessToken, requirePermission("user:admin", { scope: "workspace" })],
    schema: {
      tags: ["users"],
      security: [{ bearerAuth: [] }],
      params: idParamsSchema,
      response: {
        200: successResponseSchema,
        400: errorSchema,
        401: errorSchema,
        403: errorSchema,
        404: errorSchema,
      },
    },
    handler: async (request, reply) => {
      const userId = request.iam?.id;
      if (!userId) {
        return reply.status(401).send({ error: "Unauthorized" });
      }

      if (!(await user.exists(request.params.id))) {
        return reply.status(404).send({ error: "User not found" });
      }

      if (request.params.id === userId) {
        return reply.status(400).send({ error: "Cannot disable yourself" });
      }

      await user.disable(request.params.id, {
        actorId: userId,
        workspaceId: request.iam?.workspaceId,
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"],
      });
      return { success: true };
    },
  });

  // Enable user (requires user:admin)
  fastify.route({
    method: "POST",
    url: "/:id/enable",
    preHandler: [fastify.verifyAccessToken, requirePermission("user:admin", { scope: "workspace" })],
    schema: {
      tags: ["users"],
      security: [{ bearerAuth: [] }],
      params: idParamsSchema,
      response: {
        200: successResponseSchema,
        401: errorSchema,
        403: errorSchema,
        404: errorSchema,
      },
    },
    handler: async (request, reply) => {
      const userId = request.iam?.id;
      if (!userId) {
        return reply.status(401).send({ error: "Unauthorized" });
      }

      if (!(await user.exists(request.params.id))) {
        return reply.status(404).send({ error: "User not found" });
      }
      await user.enable(request.params.id, {
        actorId: userId,
        workspaceId: request.iam?.workspaceId,
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"],
      });
      return { success: true };
    },
  });

  // Unlock user account (requires user:admin)
  fastify.route({
    method: "POST",
    url: "/:id/unlock",
    preHandler: [fastify.verifyAccessToken, requirePermission("user:admin", { scope: "workspace" })],
    schema: {
      tags: ["users"],
      security: [{ bearerAuth: [] }],
      params: idParamsSchema,
      response: {
        200: successResponseSchema,
        400: errorSchema,
        401: errorSchema,
        403: errorSchema,
        404: errorSchema,
      },
    },
    handler: async (request, reply) => {
      const userId = request.iam?.id;
      if (!userId) {
        return reply.status(401).send({ error: "Unauthorized" });
      }

      const result = await user.unlockAccount(request.params.id, {
        actorId: userId,
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"],
      });

      if (result.success) {
        return { success: true };
      }
      if (result.error === "User not found") {
        return reply.status(404).send({ error: result.error });
      }
      return reply.status(400).send({ error: result.error });
    },
  });
}
