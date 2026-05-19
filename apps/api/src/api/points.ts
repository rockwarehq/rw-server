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

const updatePointBodySchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    description: { type: "string" },
    address: { type: "string" },
    dataType: { type: "string" },
    scaleFactor: { type: "number" },
    offset: { type: "number" },
    config: { type: "object", additionalProperties: true },
    groupId: { type: "string", format: "uuid", nullable: true },
  },
} as const satisfies JSONSchema;

const getPointResponseSchema = {
  type: "object",
  properties: {
    ...pointProperties,
    group: {
      type: "object",
      properties: pointGroupProperties,
      nullable: true,
    },
  },
} as const satisfies JSONSchema;

// Helper to map error codes to HTTP status
function getStatusForCode(code: string): 400 | 404 | 500 {
  switch (code) {
    case "NOT_FOUND":
    case "DATASOURCE_NOT_FOUND":
    case "GROUP_NOT_FOUND":
      return 404;
    case "VALIDATION_FAILED":
    case "GROUP_MISMATCH":
      return 400;
    default:
      return 500;
  }
}

export default async function points(fastify: FastifyTypedInstance) {
  // Get point by ID
  fastify.route({
    method: "GET",
    url: "/:id",
    schema: {
      tags: ["points"],
      params: idParamsSchema,
      response: {
        200: getPointResponseSchema,
        404: errorWithDetailsSchema,
      },
    },
    handler: async (request, reply) => {
      const { id } = request.params;
      const point = await datasource.points.getById(id);
      if (!point) {
        return reply.status(404).send({ error: "Point not found" });
      }
      return point;
    },
  });

  // Update point
  fastify.route({
    method: "PUT",
    url: "/:id",
    schema: {
      tags: ["points"],
      params: idParamsSchema,
      body: updatePointBodySchema,
      response: {
        200: pointSchema,
        400: errorWithDetailsSchema,
        404: errorWithDetailsSchema,
        500: errorWithDetailsSchema,
      },
    },
    handler: async (request, reply) => {
      const { id } = request.params;
      const body = request.body;

      const result = await datasource.points.update(id, body);
      if ("error" in result) {
        const status = getStatusForCode(result.code ?? "NOT_FOUND");
        return reply.status(status).send({ error: result.error, details: result.details });
      }
      return result.data;
    },
  });

  // Delete point
  fastify.route({
    method: "DELETE",
    url: "/:id",
    schema: {
      tags: ["points"],
      params: idParamsSchema,
      response: {
        200: successResponseSchema,
        404: errorWithDetailsSchema,
      },
    },
    handler: async (request, reply) => {
      const { id } = request.params;
      const result = await datasource.points.remove(id);
      if ("error" in result) {
        return reply.status(404).send({ error: result.error });
      }
      return { success: true };
    },
  });
}
