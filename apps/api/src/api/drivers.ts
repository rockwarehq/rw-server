import type { JSONSchema } from "json-schema-to-ts";
import type { FastifyTypedInstance } from "../types/fastify.js";
import { driver } from "../services/device/index.js";
import { errorSchema, idParamsSchema } from "./schemas.js";

const driverSummarySchema = {
  type: "object",
  properties: {
    id: { type: "string", format: "uuid" },
    name: { type: "string" },
    version: { type: "string" },
    displayName: { type: "string" },
    description: { type: "string" },
    vendor: { type: "string" },
    category: { type: "string" },
  },
} as const satisfies JSONSchema;

const driverDetailSchema = {
  type: "object",
  properties: {
    id: { type: "string", format: "uuid" },
    name: { type: "string" },
    version: { type: "string" },
    manifest: { type: "object", additionalProperties: true },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
  },
} as const satisfies JSONSchema;

const listQuerySchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    version: { type: "string" },
  },
} as const satisfies JSONSchema;

const listDriversResponseSchema = {
  type: "array",
  items: driverSummarySchema,
} as const satisfies JSONSchema;

const driverSchemasResponseSchema = {
  type: "object",
  properties: {
    connectionSchema: { type: "object", additionalProperties: true },
    pointSchema: { type: "object", additionalProperties: true, nullable: true },
    pointGroupSchema: { type: "object", additionalProperties: true, nullable: true },
  },
} as const satisfies JSONSchema;

export default async function drivers(fastify: FastifyTypedInstance) {
  // List all available drivers
  fastify.route({
    method: "GET",
    url: "/",
    schema: {
      tags: ["drivers"],
      querystring: listQuerySchema,
      response: {
        200: listDriversResponseSchema,
      },
    },
    handler: async (request) => {
      const { name, version } = request.query;
      return driver.list({ name, version });
    },
  });

  // Get driver by ID
  fastify.route({
    method: "GET",
    url: "/:id",
    schema: {
      tags: ["drivers"],
      params: idParamsSchema,
      response: {
        200: driverDetailSchema,
        404: errorSchema,
      },
    },
    handler: async (request, reply) => {
      const { id } = request.params;
      const result = await driver.getById(id);
      if (!result) {
        return reply.status(404).send({ error: "Driver not found" });
      }
      return result;
    },
  });

  // Get driver schemas by ID
  fastify.route({
    method: "GET",
    url: "/:id/schemas",
    schema: {
      tags: ["drivers"],
      params: idParamsSchema,
      response: {
        200: driverSchemasResponseSchema,
        404: errorSchema,
      },
    },
    handler: async (request, reply) => {
      const { id } = request.params;
      const schemas = await driver.getSchemas(id);
      if (!schemas) {
        return reply.status(404).send({ error: "Driver not found" });
      }
      return schemas;
    },
  });
}
