import { asUser } from "@rw/auth/context";
import type { JSONSchema } from "json-schema-to-ts";
import type { FastifyTypedInstance } from "../types/fastify.js";
import { workspace } from "../services/account/index.js";
import { errorSchema, idParamsSchema, successResponseSchema } from "./schemas.js";
import { ownerRequired } from "../plugins/require-owner.js";

const workspaceSchema = {
  type: "object",
  properties: {
    id: { type: "string", format: "uuid" },
    name: { type: "string" },
    slug: { type: "string" },
    description: { type: "string", nullable: true },
    isDefault: { type: "boolean" },
    settings: { type: "object", additionalProperties: true },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
    _count: {
      type: "object",
      properties: {
        members: { type: "number" },
      },
    },
  },
} as const satisfies JSONSchema;

const bucketAccessSchema = {
  type: "object",
  properties: {
    bucketId: { type: "string", format: "uuid" },
    kind: { type: "string", enum: ["PLANT", "WORKCENTER"] },
    siteId: { type: ["string", "null"], format: "uuid" },
    workcenterId: { type: ["string", "null"], format: "uuid" },
    name: { type: "string" },
    level: { type: "string", enum: ["VIEW", "MANAGE", "ADMIN"] },
  },
} as const satisfies JSONSchema;

const employeeProfileSchema = {
  type: ["object", "null"],
  properties: {
    id: { type: "string", format: "uuid" },
    status: { type: "string", enum: ["ACTIVE", "INACTIVE"] },
    version: {
      type: ["object", "null"],
      properties: {
        id: { type: "string", format: "uuid" },
        version: { type: "number" },
        firstName: { type: "string" },
        lastName: { type: "string" },
        employeeNumber: { type: ["string", "null"] },
        badgeNumber: { type: ["string", "null"] },
      },
    },
  },
} as const satisfies JSONSchema;

const accessSchema = {
  type: "object",
  properties: {
    workspaceRole: { type: "string", enum: ["OWNER", "MEMBER"] },
    buckets: { type: "array", items: bucketAccessSchema },
    siteIds: { type: "array", items: { type: "string", format: "uuid" } },
  },
} as const satisfies JSONSchema;

const memberSchema = {
  type: "object",
  properties: {
    membershipId: { type: "string", format: "uuid" },
    joinedAt: { type: "string", format: "date-time" },
    employeeId: { type: ["string", "null"], format: "uuid" },
    user: {
      type: "object",
      properties: {
        id: { type: "string", format: "uuid" },
        email: { type: "string" },
        firstName: { type: "string", nullable: true },
        lastName: { type: "string", nullable: true },
        status: { type: "string", enum: ["PENDING", "ACTIVE", "DISABLED"] },
        lastLoginAt: { type: ["string", "null"], format: "date-time" },
        invitedBy: { type: ["string", "null"], format: "uuid" },
        invitedAt: { type: ["string", "null"], format: "date-time" },
        inviteExpiry: { type: ["string", "null"], format: "date-time" },
        mustChangePassword: { type: "boolean" },
      },
    },
    access: accessSchema,
  },
} as const satisfies JSONSchema;

const createBodySchema = {
  type: "object",
  properties: {
    name: { type: "string", minLength: 1 },
    slug: { type: "string" },
    description: { type: "string" },
    isDefault: { type: "boolean" },
    settings: { type: "object", additionalProperties: true },
  },
  required: ["name"],
} as const satisfies JSONSchema;

const updateBodySchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    slug: { type: "string" },
    description: { type: "string" },
    settings: { type: "object", additionalProperties: true },
  },
} as const satisfies JSONSchema;

const addMemberBodySchema = {
  type: "object",
  properties: {
    userId: { type: "string", format: "uuid" },
    bucketAccesses: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        properties: {
          bucketId: { type: "string", format: "uuid" },
          level: { type: "string", enum: ["VIEW", "MANAGE", "ADMIN"] },
        },
        required: ["bucketId", "level"],
      },
    },
  },
  required: ["userId", "bucketAccesses"],
} as const satisfies JSONSchema;

const memberParamsSchema = {
  type: "object",
  properties: {
    id: { type: "string", format: "uuid" },
    userId: { type: "string", format: "uuid" },
  },
  required: ["id", "userId"],
} as const satisfies JSONSchema;

const updateAccessBodySchema = {
  type: "object",
  properties: {
    set: {
      type: "array",
      items: {
        type: "object",
        properties: {
          bucketId: { type: "string", format: "uuid" },
          level: { type: "string", enum: ["VIEW", "MANAGE", "ADMIN"] },
        },
        required: ["bucketId", "level"],
      },
    },
    remove: { type: "array", items: { type: "string", format: "uuid" } },
    workspaceRole: { type: "string", enum: ["OWNER", "MEMBER"] },
  },
} as const satisfies JSONSchema;

const listWorkspacesResponseSchema = {
  type: "array",
  items: {
    type: "object",
    properties: {
      id: { type: "string", format: "uuid" },
      name: { type: "string" },
      slug: { type: "string" },
      description: { type: "string", nullable: true },
      joinedAt: { type: "string", format: "date-time" },
      employee: employeeProfileSchema,
      workspaceRole: { type: "string", enum: ["OWNER", "MEMBER"] },
    },
  },
} as const satisfies JSONSchema;

const listMembersResponseSchema = {
  type: "array",
  items: memberSchema,
} as const satisfies JSONSchema;

export default async function workspaceRoutes(fastify: FastifyTypedInstance) {
  // List user's workspaces
  fastify.route({
    method: "GET",
    url: "/",
    preHandler: [fastify.verifyAccessToken],
    schema: {
      tags: ["workspaces"],
      security: [{ bearerAuth: [] }],
      response: {
        200: listWorkspacesResponseSchema,
        401: errorSchema,
      },
    },
    handler: async (request, reply) => {
      const userId = asUser(request.current)?.user.id;
      if (!userId) {
        return reply.status(401).send({ error: "Unauthorized" });
      }

      return workspace.getUserWorkspaces(userId);
    },
  });

  // Create workspace (admin only in current workspace)
  fastify.route({
    method: "POST",
    url: "/",
    preHandler: [fastify.verifyAccessToken],
    schema: {
      tags: ["workspaces"],
      security: [{ bearerAuth: [] }],
      body: createBodySchema,
      response: {
        201: workspaceSchema,
        400: errorSchema,
        401: errorSchema,
        403: errorSchema,
      },
    },
    handler: async (request, reply) => {
      const workspaceId = asUser(request.current)?.workspaceId;
      const userId = asUser(request.current)?.user.id;

      if (!userId) {
        return reply.status(401).send({ error: "Unauthorized" });
      }

      // Spinning up another workspace is an ownership-level privilege:
      // reserved company ownership (owner:all) in the caller's workspace. A
      // token without workspace context cannot prove it, so it is denied
      // (fail-closed).
      if (!workspaceId) {
        return reply.status(401).send({ error: "No workspace context" });
      }
      if (!asUser(request.current)?.access.person.owner) {
        return reply.status(403).send({ error: "forbidden", required: "owner" });
      }

      if (request.body.slug && (await workspace.slugExists(request.body.slug))) {
        return reply.status(400).send({ error: "Workspace slug already exists" });
      }

      const newWorkspace = await workspace.create(request.body);

      return reply.status(201).send(newWorkspace);
    },
  });

  // Get workspace by ID
  fastify.route({
    method: "GET",
    url: "/:id",
    preHandler: [fastify.verifyAccessToken],
    schema: {
      tags: ["workspaces"],
      security: [{ bearerAuth: [] }],
      params: idParamsSchema,
      response: {
        200: workspaceSchema,
        401: errorSchema,
        403: errorSchema,
        404: errorSchema,
      },
    },
    handler: async (request, reply) => {
      const userId = asUser(request.current)?.user.id;
      if (!userId) {
        return reply.status(401).send({ error: "Unauthorized" });
      }

      const isMember = await workspace.isMember(request.params.id, userId);
      if (!isMember) {
        return reply.status(403).send({ error: "Not a member of this workspace" });
      }

      const result = await workspace.getById(request.params.id);
      if (!result) {
        return reply.status(404).send({ error: "Workspace not found" });
      }

      return result;
    },
  });

  // Update workspace (requires settings:write)
  fastify.route({
    method: "PUT",
    url: "/:id",
    preHandler: [fastify.verifyAccessToken, ownerRequired({ workspaceParam: "id" })],
    schema: {
      tags: ["workspaces"],
      security: [{ bearerAuth: [] }],
      params: idParamsSchema,
      body: updateBodySchema,
      response: {
        200: workspaceSchema,
        401: errorSchema,
        403: errorSchema,
        404: errorSchema,
      },
    },
    handler: async (request, reply) => {
      if (!(await workspace.exists(request.params.id))) {
        return reply.status(404).send({ error: "Workspace not found" });
      }
      return workspace.update(request.params.id, request.body);
    },
  });

  // Delete workspace (ownership-level destructive op)
  fastify.route({
    method: "DELETE",
    url: "/:id",
    preHandler: [fastify.verifyAccessToken, ownerRequired({ workspaceParam: "id", allowStaff: false })],
    schema: {
      tags: ["workspaces"],
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
      if (!(await workspace.exists(request.params.id))) {
        return reply.status(404).send({ error: "Workspace not found" });
      }
      await workspace.remove(request.params.id);
      return { success: true };
    },
  });

  // List workspace members
  fastify.route({
    method: "GET",
    url: "/:id/members",
    preHandler: [fastify.verifyAccessToken],
    schema: {
      tags: ["workspaces"],
      security: [{ bearerAuth: [] }],
      params: idParamsSchema,
      response: {
        200: listMembersResponseSchema,
        401: errorSchema,
        403: errorSchema,
        404: errorSchema,
      },
    },
    handler: async (request, reply) => {
      const userId = asUser(request.current)?.user.id;
      if (!userId) {
        return reply.status(401).send({ error: "Unauthorized" });
      }

      const isMember = await workspace.isMember(request.params.id, userId);
      if (!isMember) {
        return reply.status(403).send({ error: "Not a member of this workspace" });
      }
      request.access.requireSomewhere("ADMIN");

      return workspace.listMembers(request.params.id);
    },
  });

  // Add workspace member (requires user:write)
  fastify.route({
    method: "POST",
    url: "/:id/members",
    preHandler: [fastify.verifyAccessToken, ownerRequired({ workspaceParam: "id" })],
    schema: {
      tags: ["workspaces"],
      security: [{ bearerAuth: [] }],
      params: idParamsSchema,
      body: addMemberBodySchema,
      response: {
        201: memberSchema,
        400: errorSchema,
        401: errorSchema,
        403: errorSchema,
        404: errorSchema,
      },
    },
    handler: async (request, reply) => {
      const existingMember = await workspace.getUserAccess(request.params.id, request.body.userId);
      if (existingMember) {
        return reply.status(400).send({ error: "User is already a member" });
      }

      try {
        const member = await workspace.addMember(request.params.id, request.body.userId, request.body.bucketAccesses);
        return reply.status(201).send(member);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Invalid bucket access";
        return reply.status(400).send({ error: message });
      }
    },
  });

  // Update member role (requires user:write or user:admin)
  fastify.route({
    method: "PUT",
    url: "/:id/members/:userId",
    preHandler: [fastify.verifyAccessToken],
    schema: {
      tags: ["workspaces"],
      security: [{ bearerAuth: [] }],
      params: memberParamsSchema,
      body: updateAccessBodySchema,
      response: {
        200: memberSchema,
        400: errorSchema,
        401: errorSchema,
        403: errorSchema,
        404: errorSchema,
      },
    },
    handler: async (request, reply) => {
      const me = asUser(request.current);
      if (!me) return reply.status(401).send({ error: "Unauthorized" });

      if (request.params.id !== me.workspaceId) {
        return reply.status(403).send({ error: "Not in requested workspace context" });
      }

      const result = await workspace.updateAccess({
        actor: me.access,
        targetUserId: request.params.userId,
        workspaceId: me.workspaceId,
        set: request.body.set,
        remove: request.body.remove,
        workspaceRole: request.body.workspaceRole,
      });

      if (result.success) {
        return result.access;
      }

      switch (result.code) {
        case "FORBIDDEN":
          return reply.status(403).send({ error: result.error });
        case "MEMBER_NOT_FOUND":
        case "BUCKET_NOT_FOUND":
          return reply.status(404).send({ error: result.error });
        default:
          return reply.status(400).send({ error: result.error });
      }
    },
  });

  // Remove member (requires workspace-scoped user:admin — this deletes the
  // whole membership across every site, so a site-scoped grant must not pass)
  fastify.route({
    method: "DELETE",
    url: "/:id/members/:userId",
    preHandler: [fastify.verifyAccessToken, ownerRequired({ workspaceParam: "id" })],
    schema: {
      tags: ["workspaces"],
      security: [{ bearerAuth: [] }],
      params: memberParamsSchema,
      response: {
        200: successResponseSchema,
        400: errorSchema,
        401: errorSchema,
        403: errorSchema,
        404: errorSchema,
      },
    },
    handler: async (request, reply) => {
      const currentUserId = asUser(request.current)?.user.id;
      if (!currentUserId) {
        return reply.status(401).send({ error: "Unauthorized" });
      }

      if (request.params.userId === currentUserId) {
        return reply.status(400).send({ error: "Cannot remove yourself" });
      }

      const result = await workspace.removeMember(request.params.id, request.params.userId, {
        actorId: currentUserId,
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"],
      });

      if (result.success) {
        return { success: true };
      }
      if (result.error === "MEMBER_NOT_FOUND") {
        return reply.status(404).send({ error: "Member not found" });
      }
      return reply.status(400).send({ error: "Cannot remove the last workspace owner" });
    },
  });

  // Remove a member's access to the caller's current site only (site-scoped
  // user:admin suffices — the blast radius is one site). The site comes from
  // the token, mirroring PUT /:id/members/:userId. If no role assignments
  // remain afterwards, the membership itself is removed (see removeSiteAccess).
  fastify.route({
    method: "DELETE",
    url: "/:id/members/:userId/site-access",
    preHandler: [fastify.verifyAccessToken],
    schema: {
      tags: ["workspaces"],
      security: [{ bearerAuth: [] }],
      params: memberParamsSchema,
      response: {
        200: successResponseSchema,
        400: errorSchema,
        401: errorSchema,
        403: errorSchema,
        404: errorSchema,
      },
    },
    handler: async (request, reply) => {
      const me = asUser(request.current);
      const siteId = me?.siteId;
      if (!me || !siteId) {
        return reply.status(401).send({ error: "Unauthorized" });
      }
      // ADMIN at the token's site plant.
      if (!me.access.can("ADMIN", { site: siteId })) {
        return reply.status(403).send({ error: "forbidden", required: "ADMIN" });
      }
      const currentUserId = me.user.id;

      if (request.params.id !== me.workspaceId) {
        return reply.status(403).send({ error: "Not in requested workspace context" });
      }

      if (request.params.userId === currentUserId) {
        return reply.status(400).send({ error: "Cannot remove yourself" });
      }

      const result = await workspace.removeSiteAccess(request.params.id, request.params.userId, siteId, {
        actorId: currentUserId,
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"],
      });

      if (result.success) {
        return { success: true };
      }
      switch (result.error) {
        case "MEMBER_NOT_FOUND":
          return reply.status(404).send({ error: "Member not found" });
        case "LAST_PLANT_ADMIN":
          return reply.status(400).send({ error: "Cannot remove the last plant admin" });
      }
    },
  });
}
