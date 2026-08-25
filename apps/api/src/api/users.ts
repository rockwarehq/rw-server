import type { JSONSchema } from "json-schema-to-ts";
import type { FastifyTypedInstance } from "../types/fastify.js";
import { user } from "../services/account/index.js";
import { validHttpOrigin } from "@rw/services/email/index";
import { errorSchema, idParamsSchema, successResponseSchema } from "./schemas.js";
import { sensitiveRateLimit } from "../plugins/ratelimit.js";
import { requirePermission } from "../plugins/require-permission.js";
import { authorize } from "@rw/auth/iam/policy";
import { replyPolicyDenial } from "./authz.js";

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
    firstName: { type: "string" },
    lastName: { type: "string" },
  },
  required: ["email"],
} as const satisfies JSONSchema;

const forgotPasswordBodySchema = {
  type: "object",
  properties: {
    email: { type: "string", format: "email" },
  },
  required: ["email"],
} as const satisfies JSONSchema;

const verifyResetCodeBodySchema = {
  type: "object",
  properties: {
    email: { type: "string", format: "email" },
    code: { type: "string", minLength: 6 },
  },
  required: ["email", "code"],
} as const satisfies JSONSchema;

const verifyResetCodeResponseSchema = {
  type: "object",
  properties: {
    valid: { type: "boolean" },
  },
} as const satisfies JSONSchema;

const resetPasswordBodySchema = {
  type: "object",
  properties: {
    email: { type: "string", format: "email" },
    code: { type: "string", minLength: 6 },
    password: { type: "string", minLength: 12 },
  },
  required: ["email", "code", "password"],
} as const satisfies JSONSchema;

const adminSetPasswordBodySchema = {
  type: "object",
  properties: {
    // Omit to have the server generate a temporary password
    password: { type: "string", minLength: 12 },
    // Temporary passwords must be changed at next login
    mode: { type: "string", enum: ["temporary", "permanent"], default: "temporary" },
  },
} as const satisfies JSONSchema;

const adminSetPasswordResponseSchema = {
  type: "object",
  properties: {
    success: { type: "boolean" },
    mustChangePassword: { type: "boolean" },
    // Present only when the server generated the password - shown once
    temporaryPassword: { type: "string" },
  },
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
        mustChangePassword: { type: "boolean" },
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

const inviteResponseSchema = {
  type: "object",
  properties: {
    user: {
      type: "object",
      properties: {
        id: { type: "string", format: "uuid" },
        email: { type: "string" },
        status: { type: "string" },
        firstName: { type: ["string", "null"] },
        lastName: { type: ["string", "null"] },
      },
    },
    // Shown once to the inviting admin; the invite email is the other channel
    temporaryPassword: { type: "string" },
    expiresAt: { type: "string", format: "date-time" },
    emailSent: { type: "boolean" },
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
    config: sensitiveRateLimit,
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
    preHandler: [fastify.verifyAccessToken],
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
    handler: async (request, reply) => {
      // Roster reads align with RPC workspace.listMembers: user:read held at
      // any site suffices (site Factory Administrators manage their people).
      const auth = await authorize(request.iam, { permission: "user:read", scope: { kind: "anySite" } });
      if (!auth.ok) return replyPolicyDenial(reply, auth);

      return user.list(request.query);
    },
  });

  // Invite user (requires user:write; checks live in the service)
  fastify.route({
    method: "POST",
    url: "/invite",
    preHandler: [fastify.verifyAccessToken],
    config: sensitiveRateLimit,
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

      const { email, roleId, siteId, firstName, lastName } = request.body;
      const result = await user.createInvite({
        email,
        inviterId,
        workspaceId,
        roleId,
        siteId,
        fallbackSiteId: request.iam?.siteId,
        firstName,
        lastName,
        // Safe here because this route is authenticated: the origin comes
        // from the inviting admin's own browser. Never reuse on public routes.
        appUrl: validHttpOrigin(request.headers.origin),
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

  // Revoke a pending invite: deletes the invited user so the email can be
  // re-invited. Permission checks live in the service (mirrors invite rights).
  fastify.route({
    method: "DELETE",
    url: "/invite/:id",
    preHandler: [fastify.verifyAccessToken],
    config: sensitiveRateLimit,
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
        409: errorSchema,
      },
    },
    handler: async (request, reply) => {
      const actorId = request.iam?.id;
      const workspaceId = request.iam?.workspaceId;
      if (!actorId || !workspaceId) {
        return reply.status(401).send({ error: "Unauthorized" });
      }

      const result = await user.revokeInvite({
        targetUserId: request.params.id,
        actorId,
        workspaceId,
        context: {
          ipAddress: request.ip,
          userAgent: request.headers["user-agent"],
        },
      });

      if (result.success) {
        return { success: true };
      }

      switch (result.error) {
        case "USER_NOT_FOUND":
          return reply.status(404).send({ error: "Invite not found" });
        case "NOT_PENDING":
          return reply.status(409).send({ error: "User is not a pending invite" });
        case "SELF_REVOKE":
          return reply.status(400).send({ error: "Cannot revoke your own account" });
        case "SYSTEM_USER":
          return reply.status(403).send({ error: "Cannot revoke a system user" });
        case "FORBIDDEN":
          return reply.status(403).send({ error: "Forbidden" });
      }
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
      return { message: "If an account exists with this email, a password reset code has been sent." };
    },
  });

  // Verify password reset code (public) - rate limited
  fastify.route({
    method: "POST",
    url: "/password/verify",
    config: sensitiveRateLimit,
    schema: {
      tags: ["users"],
      body: verifyResetCodeBodySchema,
      response: {
        200: verifyResetCodeResponseSchema,
      },
    },
    handler: async (request) => {
      const { email, code } = request.body;
      return user.verifyResetCode(email, code, {
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"],
      });
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
      const { email, code, password } = request.body;
      const result = await user.resetPassword(email, code, password, {
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
    preHandler: [fastify.verifyAccessToken],
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
      const auth = await authorize(request.iam, { permission: "user:read", scope: { kind: "anySite" } });
      if (!auth.ok) return replyPolicyDenial(reply, auth);

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
    preHandler: [fastify.verifyAccessToken],
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
      const auth = await authorize(request.iam, { permission: "user:read", scope: { kind: "anySite" } });
      if (!auth.ok) return replyPolicyDenial(reply, auth);

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

  // Set a user's password (requires user:admin). Generated passwords are
  // always temporary; permanent mode requires an explicit password.
  fastify.route({
    method: "POST",
    url: "/:id/password",
    preHandler: [fastify.verifyAccessToken, requirePermission("user:admin", { scope: "workspace" })],
    schema: {
      tags: ["users"],
      security: [{ bearerAuth: [] }],
      params: idParamsSchema,
      body: adminSetPasswordBodySchema,
      response: {
        200: adminSetPasswordResponseSchema,
        400: errorWithDetailsSchema,
        401: errorSchema,
        403: errorSchema,
        404: errorSchema,
      },
    },
    handler: async (request, reply) => {
      const actorId = request.iam?.id;
      const workspaceId = request.iam?.workspaceId;
      if (!actorId || !workspaceId) {
        return reply.status(401).send({ error: "Unauthorized" });
      }

      const { password, mode } = request.body;
      const result = await user.adminSetPassword(
        {
          targetUserId: request.params.id,
          actorId,
          workspaceId,
          password,
          mode: mode ?? "temporary",
        },
        {
          ipAddress: request.ip,
          userAgent: request.headers["user-agent"],
        },
      );

      if (result.success) {
        return { success: true, ...result.data };
      }

      switch (result.error) {
        case "USER_NOT_FOUND":
          return reply.status(404).send({ error: "User not found" });
        case "SYSTEM_USER":
          return reply.status(403).send({ error: "Cannot set a system user's password" });
        case "OWNER_PERMISSION_REQUIRED":
          return reply.status(403).send({ error: "Only a workspace owner can reset an owner's password" });
        case "SELF_RESET":
          return reply.status(400).send({ error: "Use the change password endpoint for your own account" });
        case "PERMANENT_REQUIRES_PASSWORD":
          return reply.status(400).send({ error: "A permanent password must be provided explicitly" });
        case "WEAK_PASSWORD":
          return reply.status(400).send({ error: "Password does not meet requirements", details: result.details });
      }
    },
  });
}
