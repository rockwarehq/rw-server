import type { JSONSchema } from "json-schema-to-ts";
import type { FastifyTypedInstance } from "../types/fastify.js";
import { datasource } from "../services/device/index.js";
import { errorWithDetailsSchema, idParamsSchema, gatewaySummarySchema } from "./schemas.js";

const siteSummarySchema = {
  type: "object",
  properties: {
    id: { type: "string", format: "uuid" },
    name: { type: "string" },
    workspaceId: { type: "string", format: "uuid" },
  },
  nullable: true,
} as const satisfies JSONSchema;

const datasourceTypeEnum = ["DEVICE", "KIOSK", "SERVICE", "VIRTUAL"] as const;
const datasourceStatusEnum = ["DRAFT", "ACTIVE"] as const;

const datasourceProperties = {
  id: { type: "string", format: "uuid" },
  name: { type: "string" },
  type: { type: "string", enum: datasourceTypeEnum },
  status: { type: "string", enum: datasourceStatusEnum },
  attrs: { type: "object", additionalProperties: true },
  driver: { type: "string" },
  driverVersion: { type: "string" },
  connection: { type: "object", additionalProperties: true },
  gatewayId: { type: "string", format: "uuid", nullable: true },
  siteId: { type: ["string", "null"], format: "uuid" },
  createdAt: { type: "string", format: "date-time" },
  updatedAt: { type: "string", format: "date-time" },
} as const;

const datasourceSchema = {
  type: "object",
  properties: datasourceProperties,
} as const satisfies JSONSchema;

const paginatedDatasourceListSchema = {
  type: "object",
  properties: {
    data: {
      type: "array",
      items: {
        type: "object",
        properties: {
          ...datasourceProperties,
          gateway: gatewaySummarySchema,
          site: siteSummarySchema,
          _count: {
            type: "object",
            properties: {
              points: { type: "number" },
              pointGroups: { type: "number" },
            },
          },
        },
      },
    },
    total: { type: "number" },
    limit: { type: "number" },
    offset: { type: "number" },
  },
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

const datasourceIdParamsSchema = {
  type: "object",
  properties: {
    datasourceId: { type: "string", format: "uuid" },
  },
  required: ["datasourceId"],
} as const satisfies JSONSchema;

const createDatasourceBodySchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    type: { type: "string", enum: datasourceTypeEnum },
    attrs: { type: "object", additionalProperties: true },
    driver: { type: "string" },
    driverVersion: { type: "string" },
    connection: { type: "object", additionalProperties: true },
    gatewayId: { type: "string", format: "uuid" },
    siteId: { type: "string", format: "uuid" },
  },
  additionalProperties: false,
  required: ["name", "driver", "siteId"],
} as const satisfies JSONSchema;

const listDatasourcesQuerySchema = {
  type: "object",
  properties: {
    gatewayId: { type: "string", format: "uuid" },
    siteId: { type: "string", format: "uuid" },
    driver: { type: "string" },
    type: { type: "string", enum: datasourceTypeEnum },
    status: { type: "string", enum: datasourceStatusEnum },
    name: { type: "string" },
    unassigned: { type: "string", enum: ["true", "false"] },
    limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
    offset: { type: "integer", minimum: 0, default: 0 },
  },
} as const satisfies JSONSchema;

const updateDatasourceBodySchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    type: { type: "string", enum: datasourceTypeEnum },
    attrs: { type: "object", additionalProperties: true },
    connection: { type: "object", additionalProperties: true },
  },
} as const satisfies JSONSchema;

const assignBodySchema = {
  type: "object",
  properties: {
    gatewayId: { type: "string", format: "uuid", nullable: true },
  },
  required: ["gatewayId"],
} as const satisfies JSONSchema;

const createGroupBodySchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    description: { type: "string" },
    pollRateMs: { type: "number" },
    config: { type: "object", additionalProperties: true },
  },
  required: ["name"],
} as const satisfies JSONSchema;

const createPointBodySchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    description: { type: "string" },
    address: { type: "string" },
    dataType: { type: "string" },
    scaleFactor: { type: "number" },
    offset: { type: "number" },
    config: { type: "object", additionalProperties: true },
    groupId: { type: "string" },
  },
  required: ["name", "address", "dataType"],
} as const satisfies JSONSchema;

const listPointsQuerySchema = {
  type: "object",
  properties: {
    groupId: { type: "string", format: "uuid" },
    ungrouped: { type: "boolean" },
  },
} as const satisfies JSONSchema;

const bulkCreatePointsBodySchema = {
  type: "object",
  properties: {
    points: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          description: { type: "string" },
          address: { type: "string" },
          dataType: { type: "string" },
          scaleFactor: { type: "number" },
          offset: { type: "number" },
          config: { type: "object", additionalProperties: true },
          groupId: { type: "string" },
        },
        required: ["name", "address", "dataType"],
      },
    },
  },
  required: ["points"],
} as const satisfies JSONSchema;

const createDatasourceResponseSchema = {
  type: "object",
  properties: {
    ...datasourceProperties,
    gateway: gatewaySummarySchema,
    site: siteSummarySchema,
  },
} as const satisfies JSONSchema;

const getDatasourceResponseSchema = {
  type: "object",
  properties: {
    ...datasourceProperties,
    gateway: gatewaySummarySchema,
    site: siteSummarySchema,
    pointGroups: {
      type: "array",
      items: { type: "object" },
    },
    points: {
      type: "array",
      items: { type: "object" },
    },
  },
} as const satisfies JSONSchema;

const updateDatasourceResponseSchema = {
  type: "object",
  properties: {
    ...datasourceProperties,
    site: siteSummarySchema,
  },
} as const satisfies JSONSchema;

const deleteDatasourceResponseSchema = {
  type: "object",
  properties: {
    success: { type: "boolean" },
  },
} as const satisfies JSONSchema;

const listPointGroupsResponseSchema = {
  type: "array",
  items: {
    type: "object",
    properties: {
      ...pointGroupProperties,
      _count: {
        type: "object",
        properties: {
          points: { type: "number" },
        },
      },
    },
  },
} as const satisfies JSONSchema;

const listPointsResponseSchema = {
  type: "array",
  items: pointSchema,
} as const satisfies JSONSchema;

const bulkCreatePointsResponseSchema = {
  type: "object",
  properties: {
    created: { type: "number" },
    points: {
      type: "array",
      items: pointSchema,
    },
  },
} as const satisfies JSONSchema;

// Helper to map error codes to HTTP status
function getStatusForCode(code: string): 400 | 404 | 500 {
  switch (code) {
    case "NOT_FOUND":
    case "DATASOURCE_NOT_FOUND":
    case "GATEWAY_NOT_FOUND":
    case "GROUP_NOT_FOUND":
    case "DRIVER_NOT_FOUND":
    case "SITE_NOT_FOUND":
    case "WORKSPACE_MISMATCH": // Treat as 404 for REST (auth issues)
      return 404;
    case "VALIDATION_FAILED":
    case "GROUP_MISMATCH":
    case "INVALID_STATUS":
    case "CONNECTION_REQUIRED":
      return 400;
    default:
      return 500;
  }
}

export default async function datasources(fastify: FastifyTypedInstance) {
  // ============================================
  // DATASOURCE CRUD
  // ============================================

  // Create datasource
  fastify.route({
    method: "POST",
    url: "/",
    schema: {
      tags: ["datasources"],
      body: createDatasourceBodySchema,
      response: {
        201: createDatasourceResponseSchema,
        400: errorWithDetailsSchema,
        404: errorWithDetailsSchema,
        500: errorWithDetailsSchema,
      },
    },
    preHandler: fastify.verifyAccessToken,
    handler: async (request, reply) => {
      const body = request.body;
      const workspaceId = (request.iam as { workspaceId?: string } | undefined)?.workspaceId;

      if (!workspaceId) {
        return reply.status(400).send({ error: "Workspace context required" });
      }

      const result = await datasource.create({ ...body, workspaceId });
      if ("error" in result) {
        return reply.status(getStatusForCode(result.code ?? "UNKNOWN")).send({ error: result.error });
      }
      return reply.status(201).send(result.data);
    },
  });

  // List datasources
  fastify.route({
    method: "GET",
    url: "/",
    schema: {
      tags: ["datasources"],
      querystring: listDatasourcesQuerySchema,
      response: {
        200: paginatedDatasourceListSchema,
      },
    },
    handler: async (request) => {
      const { gatewayId, siteId, driver, type, status, name, unassigned, limit = 50, offset = 0 } = request.query;

      return datasource.list({
        gatewayId,
        siteId,
        driver,
        type,
        status,
        name,
        unassigned: unassigned === "true",
        limit,
        offset,
      });
    },
  });

  // Get datasource by ID
  fastify.route({
    method: "GET",
    url: "/:id",
    schema: {
      tags: ["datasources"],
      params: idParamsSchema,
      response: {
        200: getDatasourceResponseSchema,
        404: errorWithDetailsSchema,
      },
    },
    handler: async (request, reply) => {
      const { id } = request.params;
      const result = await datasource.getById(id);
      if (!result) {
        return reply.status(404).send({ error: "Datasource not found" });
      }
      return result;
    },
  });

  // Update datasource
  fastify.route({
    method: "PUT",
    url: "/:id",
    schema: {
      tags: ["datasources"],
      params: idParamsSchema,
      body: updateDatasourceBodySchema,
      response: {
        200: updateDatasourceResponseSchema,
        400: errorWithDetailsSchema,
        404: errorWithDetailsSchema,
        500: errorWithDetailsSchema,
      },
    },
    preHandler: fastify.verifyAccessToken,
    handler: async (request, reply) => {
      const { id } = request.params;
      const body = request.body;
      const workspaceId = (request.iam as { workspaceId?: string } | undefined)?.workspaceId;

      const result = await datasource.update(id, body, workspaceId);
      if ("error" in result) {
        return reply.status(getStatusForCode(result.code ?? "UNKNOWN")).send({ error: result.error });
      }
      return result.data;
    },
  });

  // Delete datasource
  fastify.route({
    method: "DELETE",
    url: "/:id",
    schema: {
      tags: ["datasources"],
      params: idParamsSchema,
      response: {
        200: deleteDatasourceResponseSchema,
        400: errorWithDetailsSchema,
        404: errorWithDetailsSchema,
        500: errorWithDetailsSchema,
      },
    },
    preHandler: fastify.verifyAccessToken,
    handler: async (request, reply) => {
      const { id } = request.params;
      const workspaceId = (request.iam as { workspaceId?: string } | undefined)?.workspaceId;

      const result = await datasource.remove(id, workspaceId);
      if ("error" in result) {
        return reply.status(getStatusForCode(result.code ?? "UNKNOWN")).send({ error: result.error });
      }
      return { success: true };
    },
  });

  // Assign datasource to gateway
  fastify.route({
    method: "POST",
    url: "/:id/assign",
    schema: {
      tags: ["datasources"],
      params: idParamsSchema,
      body: assignBodySchema,
      response: {
        200: datasourceSchema,
        400: errorWithDetailsSchema,
        404: errorWithDetailsSchema,
        500: errorWithDetailsSchema,
      },
    },
    handler: async (request, reply) => {
      const { id } = request.params;
      const { gatewayId } = request.body;

      const result = await datasource.assign(id, gatewayId);
      if ("error" in result) {
        return reply.status(getStatusForCode(result.code ?? "UNKNOWN")).send({ error: result.error });
      }
      return result.data;
    },
  });

  // ============================================
  // POINT GROUPS
  // ============================================

  // Create point group
  fastify.route({
    method: "POST",
    url: "/:datasourceId/groups",
    schema: {
      tags: ["datasources"],
      params: datasourceIdParamsSchema,
      body: createGroupBodySchema,
      response: {
        201: pointGroupSchema,
        400: errorWithDetailsSchema,
        404: errorWithDetailsSchema,
        500: errorWithDetailsSchema,
      },
    },
    handler: async (request, reply) => {
      const { datasourceId } = request.params;
      const body = request.body;

      const result = await datasource.groups.create(datasourceId, body);
      if ("error" in result) {
        return reply
          .status(getStatusForCode(result.code ?? "UNKNOWN"))
          .send({ error: result.error, details: result.details });
      }
      return reply.status(201).send(result.data);
    },
  });

  // List point groups
  fastify.route({
    method: "GET",
    url: "/:datasourceId/groups",
    schema: {
      tags: ["datasources"],
      params: datasourceIdParamsSchema,
      response: {
        200: listPointGroupsResponseSchema,
        400: errorWithDetailsSchema,
        404: errorWithDetailsSchema,
        500: errorWithDetailsSchema,
      },
    },
    handler: async (request, reply) => {
      const { datasourceId } = request.params;
      const result = await datasource.groups.list(datasourceId);
      if ("error" in result) {
        return reply.status(getStatusForCode(result.code ?? "UNKNOWN")).send({ error: result.error });
      }
      return result.data;
    },
  });

  // ============================================
  // POINTS
  // ============================================

  // Create point
  fastify.route({
    method: "POST",
    url: "/:datasourceId/points",
    schema: {
      tags: ["datasources"],
      params: datasourceIdParamsSchema,
      body: createPointBodySchema,
      response: {
        201: pointSchema,
        400: errorWithDetailsSchema,
        404: errorWithDetailsSchema,
        500: errorWithDetailsSchema,
      },
    },
    handler: async (request, reply) => {
      const { datasourceId } = request.params;
      const body = request.body;

      const result = await datasource.points.create(datasourceId, body);
      if ("error" in result) {
        return reply
          .status(getStatusForCode(result.code ?? "UNKNOWN"))
          .send({ error: result.error, details: result.details });
      }
      return reply.status(201).send(result.data);
    },
  });

  // List points
  fastify.route({
    method: "GET",
    url: "/:datasourceId/points",
    schema: {
      tags: ["datasources"],
      params: datasourceIdParamsSchema,
      querystring: listPointsQuerySchema,
      response: {
        200: listPointsResponseSchema,
        400: errorWithDetailsSchema,
        404: errorWithDetailsSchema,
        500: errorWithDetailsSchema,
      },
    },
    handler: async (request, reply) => {
      const { datasourceId } = request.params;
      const { groupId, ungrouped } = request.query;

      const result = await datasource.points.list(datasourceId, { groupId, ungrouped });
      if ("error" in result) {
        return reply.status(getStatusForCode(result.code ?? "UNKNOWN")).send({ error: result.error });
      }
      return result.data;
    },
  });

  // Bulk create points
  fastify.route({
    method: "POST",
    url: "/:datasourceId/points/bulk",
    schema: {
      tags: ["datasources"],
      params: datasourceIdParamsSchema,
      body: bulkCreatePointsBodySchema,
      response: {
        201: bulkCreatePointsResponseSchema,
        400: errorWithDetailsSchema,
        404: errorWithDetailsSchema,
        500: errorWithDetailsSchema,
      },
    },
    handler: async (request, reply) => {
      const { datasourceId } = request.params;
      const { points } = request.body;

      const result = await datasource.points.bulkCreate(datasourceId, points);
      if ("error" in result) {
        return reply
          .status(getStatusForCode(result.code ?? "UNKNOWN"))
          .send({ error: result.error, details: result.details });
      }
      return reply.status(201).send(result.data);
    },
  });
}
