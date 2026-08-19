import * as z from "zod";
import {
  METRIC_CATALOG_DEFAULT_AGGREGATIONS,
  METRIC_CATALOG_ENTITY_TYPES,
  METRIC_CATALOG_GRANULARITIES,
  METRIC_CATALOG_VALUE_TYPES,
  listMetrics,
} from "@rw/services/metric-catalog/index";
import { throwServiceError } from "./errors.js";
import { userOrDisplayRequired } from "./middleware.js";
import { authorize } from "@rw/auth/iam/policy";
import { grant } from "./authz.js";

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
    const { workspaceId } = grant(
      await authorize(context.iam, { permission: "facility:read", scope: { kind: "site", siteId: input.siteId } }),
    );

    const result = await listMetrics({
      siteId: input.siteId,
      workspaceId,
      entityType: input.entityType,
    });

    if (!result.success) {
      throwServiceError(result);
    }

    return { data: result.data };
  });
