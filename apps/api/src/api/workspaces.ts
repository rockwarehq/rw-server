import { asUser } from "@rw/auth/context";
import type { JSONSchema } from "json-schema-to-ts";
import type { FastifyTypedInstance } from "../types/fastify.js";
import { workspace } from "../services/account/index.js";
import { errorSchema, idParamsSchema, successResponseSchema } from "./schemas.js";
import { accountAdminRequired } from "../plugins/require-account-admin.js";

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
    isAccountAdmin: { type: "boolean" },
    buckets: { type: "array", items: bucketAccessSchema },
    siteIds: { type: "array", items: { type: "string", format: "uuid" } },
  },
} as const satisfies JSONSchema;

const memberSchema = {
  type: "object",
  properties: {
    userId: { type: "string", format: "uuid" },
    createdAt: { type: "string", format: "date-time" },
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

const updateBodySchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    slug: { type: "string" },
    description: { type: "string" },
    settings: { type: "object", additionalProperties: true },
  },
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
    isAccountAdmin: { type: "boolean" },
  },
} as const satisfies JSONSchema;

// The account's workspace as a one-item list: the old membership-list shape,
// kept because shipped console builds read it at boot. `workspaceRole`
// mirrors isAccountAdmin for them.
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
      isAccountAdmin: { type: "boolean" },
      workspaceRole: { type: "string", enum: ["OWNER", "MEMBER"] },
      workspace: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          name: { type: "string" },
          slug: { type: "string" },
          description: { type: "string", nullable: true },
        },
      },
    },
  },
} as const satisfies JSONSchema;

const listMembersResponseSchema = {
  type: "array",
  items: memberSchema,
} as const satisfies JSONSchema;

export default async function workspaceRoutes(fastify: FastifyTypedInstance) {
  // The account's workspace, as a one-item list (see the schema note)
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

      return workspace.listForUser(userId);
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
      const me = asUser(request.current);
      if (!me) {
        return reply.status(401).send({ error: "Unauthorized" });
      }
      if (request.params.id !== me.workspaceId) {
        return reply.status(404).send({ error: "Workspace not found" });
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
    preHandler: [fastify.verifyAccessToken, accountAdminRequired({ workspaceParam: "id" })],
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
      const me = asUser(request.current);
      if (!me) {
        return reply.status(401).send({ error: "Unauthorized" });
      }
      if (request.params.id !== me.workspaceId) {
        return reply.status(403).send({ error: "Not a member of this workspace" });
      }
      request.access.requireSomewhere("ADMIN");

      return workspace.listMembers();
    },
  });

  // Change a member's access: plant ADMIN at each touched plant; making or
  // unmaking account admins needs an account admin.
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
        set: request.body.set,
        remove: request.body.remove,
        isAccountAdmin: request.body.isAccountAdmin,
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

  // Remove a member from the account (account admins): they are disabled
  // and lose every access; their user row stays for history.
  fastify.route({
    method: "DELETE",
    url: "/:id/members/:userId",
    preHandler: [fastify.verifyAccessToken, accountAdminRequired({ workspaceParam: "id" })],
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

      const result = await workspace.removeMember(request.params.userId);

      if (result.success) {
        return { success: true };
      }
      if (result.error === "MEMBER_NOT_FOUND") {
        return reply.status(404).send({ error: "Member not found" });
      }
      return reply.status(400).send({ error: "Cannot remove the last account admin" });
    },
  });

  // Remove a member's access to the caller's current site only (plant ADMIN
  // there suffices — the blast radius is one site). The site comes from the
  // token.
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

      const result = await workspace.removeSiteAccess(request.params.userId, siteId);

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
