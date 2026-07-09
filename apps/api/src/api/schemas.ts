import type { JSONSchema } from "json-schema-to-ts";

// Common error schema (used in most API files)
export const errorSchema = {
  type: "object",
  properties: {
    error: { type: "string" },
  },
} as const satisfies JSONSchema;

// Error schema with details (used in datasources, groups, points)
export const errorWithDetailsSchema = {
  type: "object",
  properties: {
    error: { type: "string" },
    details: {
      type: "array",
      items: {
        type: "object",
        properties: {
          path: { type: "string" },
          message: { type: "string" },
        },
        required: ["path", "message"],
      },
    },
  },
} as const satisfies JSONSchema;

// Success response schema (used ~10 times across files)
export const successResponseSchema = {
  type: "object",
  properties: {
    success: { type: "boolean" },
  },
} as const satisfies JSONSchema;

// Common ID params schema (used in 9 files)
export const idParamsSchema = {
  type: "object",
  properties: {
    id: { type: "string", format: "uuid" },
  },
  required: ["id"],
} as const satisfies JSONSchema;

// Gateway summary schema (used in datasources)
export const gatewaySummarySchema = {
  type: "object",
  properties: {
    id: { type: "string", format: "uuid" },
    name: { type: "string" },
  },
  nullable: true,
} as const satisfies JSONSchema;

// Health check response schema
export const healthResponseSchema = {
  type: "object",
  properties: {
    status: { type: "string" },
  },
  required: ["status"],
} as const satisfies JSONSchema;

// Readiness response schema (GET /ready)
export const readinessResponseSchema = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["ready", "not_ready"] },
    checks: {
      type: "object",
      additionalProperties: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          critical: { type: "boolean" },
          latencyMs: { type: "number" },
          error: { type: "string" },
        },
        required: ["ok", "critical", "latencyMs"],
      },
    },
  },
  required: ["status", "checks"],
} as const satisfies JSONSchema;
