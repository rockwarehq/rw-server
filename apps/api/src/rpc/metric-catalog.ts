import { ORPCError } from "@orpc/server";
import * as z from "zod";
import {
  METRIC_CATALOG_DEFAULT_AGGREGATIONS,
  METRIC_CATALOG_ENTITY_TYPES,
  METRIC_CATALOG_GRANULARITIES,
  METRIC_CATALOG_VALUE_TYPES,
  listMetrics,
} from "@rw/domain/services/metric-catalog/index";
import { Principal } from "../services/auth/index.js";
import { userOrDisplayRequired } from "./middleware.js";

const metricCatalogItemSchema = z.object({
  key: z.string(),
  label: z.string(),
  description: z.string().nullable().optional(),
  unit: z.string().nullable().optional(),
  valueType: z.enum(METRIC_CATALOG_VALUE_TYPES),
  granularities: z.array(z.enum(METRIC_CATALOG_GRANULARITIES)).min(1),
  entityTypes: z.array(z.enum(METRIC_CATALOG_ENTITY_TYPES)).min(1),
  defaultAggregation: z.enum(METRIC_CATALOG_DEFAULT_AGGREGATIONS).optional(),
});

const listInputSchema = z.object({
  siteId: z.uuid(),
  entityType: z.enum(METRIC_CATALOG_ENTITY_TYPES).optional(),
});

const listOutputSchema = z.object({
  data: z.array(metricCatalogItemSchema),
});

export const list = userOrDisplayRequired
  .input(listInputSchema)
  .output(listOutputSchema)
  .handler(async ({ context, input }) => {
    const workspaceId = context.iam.workspaceId;
    if (!workspaceId) {
      throw new ORPCError("BAD_REQUEST", { message: "Workspace context required" });
    }

    if (context.iam.principal === Principal.DISPLAY && input.siteId !== context.iam.siteId) {
      throw new ORPCError("FORBIDDEN", { message: "Display can only access metric catalog for its site" });
    }

    const result = await listMetrics({
      siteId: input.siteId,
      workspaceId,
      entityType: input.entityType,
    });

    if (!result.success) {
      if (result.code === "SITE_NOT_FOUND") {
        throw new ORPCError("NOT_FOUND", { message: result.error, cause: result });
      }

      if (result.code === "WORKSPACE_MISMATCH") {
        throw new ORPCError("FORBIDDEN", { message: result.error, cause: result });
      }

      throw new ORPCError("BAD_REQUEST", { message: result.error, cause: result });
    }

    return { data: result.data };
  });
