import type { JSONSchema } from "json-schema-to-ts";
import type { FastifyTypedInstance } from "../types/fastify.js";
import { datasource } from "../services/device/index.js";
import { errorWithDetailsSchema, idParamsSchema, successResponseSchema } from "./schemas.js";

const pointProperties = {
  id: { type: "string", format: "uuid" },
  name: { type: "string" },
  description: { type: "string", nullable: true },
  address: { type: "string" },
  dataType: { type: "string" },
  scaleFactor: { type: "number" },
  offset: { type: "number" },
  config: { type: "object", additionalProperties: true },
  datasourceId: { type: "string", format: "uuid" },
  groupId: { type: "string", format: "uuid", nullable: true },
  createdAt: { type: "string", format: "date-time" },
  updatedAt: { type: "string", format: "date-time" },
} as const;

const pointSchema = {
  type: "object",
  properties: pointProperties,
} as const satisfies JSONSchema;

const pointGroupProperties = {
  id: { type: "string", format: "uuid" },
  name: { type: "string" },
  description: { type: "string", nullable: true },
  pollRateMs: { type: "number" },
  config: { type: "object", additionalProperties: true },
  datasourceId: { type: "string", format: "uuid" },
  createdAt: { type: "string", format: "date-time" },
  updatedAt: { type: "string", format: "date-time" },
} as const;

const pointGroupSchema = {
  type: "object",
  properties: pointGroupProperties,
} as const satisfies JSONSchema;

const updateGroupBodySchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    description: { type: "string" },
    pollRateMs: { type: "number" },
    config: { type: "object", additionalProperties: true },
  },
} as const satisfies JSONSchema;

const getGroupResponseSchema = {
  type: "object",
  properties: {
    ...pointGroupProperties,
    points: {
      type: "array",
      items: pointSchema,
    },
  },
} as const satisfies JSONSchema;

// Helper to map error codes to HTTP status
function getStatusForCode(code: string): 404 | 400 | 500 {
  switch (code) {
    case "NOT_FOUND":
    case "DATASOURCE_NOT_FOUND":
      return 404;
    case "VALIDATION_FAILED":
      return 400;
    default:
      return 500;
  }
}

export default async function groups(fastify: FastifyTypedInstance) {
  // Get point group by ID
  fastify.route({
    method: "GET",
    url: "/:id",
    schema: {
      tags: ["groups"],
      params: idParamsSchema,
      response: {
        200: getGroupResponseSchema,
        404: errorWithDetailsSchema,
      },
    },
    handler: async (request, reply) => {
      const { id } = request.params;
      const group = await datasource.groups.getById(id);
      if (!group) {
        return reply.status(404).send({ error: "Point group not found" });
      }
      return group;
    },
  });

  // Update point group
  fastify.route({
    method: "PUT",
    url: "/:id",
    schema: {
      tags: ["groups"],
      params: idParamsSchema,
      body: updateGroupBodySchema,
      response: {
        200: pointGroupSchema,
        404: errorWithDetailsSchema,
        400: errorWithDetailsSchema,
        500: errorWithDetailsSchema,
      },
    },
    handler: async (request, reply) => {
      const { id } = request.params;
      const body = request.body;

      const result = await datasource.groups.update(id, body);
      if ("error" in result) {
        return reply
          .status(getStatusForCode(result.code ?? "NOT_FOUND"))
          .send({ error: result.error, details: result.details });
      }
      return result.data;
    },
  });

  // Delete point group
  fastify.route({
    method: "DELETE",
    url: "/:id",
    schema: {
      tags: ["groups"],
      params: idParamsSchema,
      response: {
        200: successResponseSchema,
        404: errorWithDetailsSchema,
      },
    },
    handler: async (request, reply) => {
      const { id } = request.params;
      const result = await datasource.groups.remove(id);
      if ("error" in result) {
        return reply.status(404).send({ error: result.error });
      }
      return { success: true };
    },
  });
}
