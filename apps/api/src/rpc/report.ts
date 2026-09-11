/**
 * Report builder endpoints over the reporting catalog: `schema` feeds the
 * fact/measure/dimension pickers; `query` compiles one GROUP BY against the
 * star-stamped fact tables. Site scoping and workcenter-grant narrowing are
 * injected here — the compiler refuses to run without a scope.
 */

import { authorizeList, type Permission } from "@rw/auth/iam/policy";
import { FACTS, reportSchema, runReportQuery } from "@rw/services/reporting/index";
import { z } from "zod";
import { grant } from "./authz.js";
import { throwServiceError } from "./errors.js";
import { userOrDisplayRequired } from "./middleware.js";

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD");

const querySchema = z.object({
  siteId: z.uuid(),
  fact: z.string().max(64),
  measures: z.array(z.string().max(64)).min(1).max(20),
  dimensions: z.array(z.string().max(64)).max(10).default([]),
  filters: z
    .array(
      z.object({
        dimension: z.string().max(64),
        op: z.enum(["eq", "neq", "in"]),
        value: z.union([z.string().max(256), z.array(z.string().max(256)).max(200)]),
      }),
    )
    .max(20)
    .optional(),
  dateFrom: dateString.optional(),
  dateTo: dateString.optional(),
  dateGranularity: z.enum(["hour", "day", "week", "month", "year"]).optional(),
  orderBy: z.object({ field: z.string().max(64), dir: z.enum(["asc", "desc"]) }).optional(),
  limit: z.number().int().min(1).max(10000).optional(),
  offset: z.number().int().min(0).optional(),
});

export const schema = userOrDisplayRequired
  .input(z.object({ siteId: z.uuid() }))
  .handler(async ({ input, context }) => {
    // Each fact is gated by the permission its sibling routers use for the
    // same tables; the schema lists only facts the caller can actually query.
    const permissions = [...new Set(Object.values(FACTS).map((fact) => fact.permission))];
    const granted = new Set<string>();
    for (const permission of permissions) {
      const result = await authorizeList(context.iam, {
        permission: permission as Permission,
        requestedSiteId: input.siteId,
      });
      if (result.ok) granted.add(permission);
    }
    if (granted.size === 0) {
      // No catalog access at all — surface the denial instead of an empty list.
      grant(await authorizeList(context.iam, { permission: "job:read", requestedSiteId: input.siteId }));
    }
    return { facts: reportSchema(granted) };
  });

export const query = userOrDisplayRequired.input(querySchema).handler(async ({ input, context }) => {
  const fact = FACTS[input.fact];
  if (!fact) throwServiceError({ error: `Unknown fact: ${input.fact}`, code: "UNKNOWN_FACT" });
  const scope = grant(
    await authorizeList(context.iam, { permission: fact.permission as Permission, requestedSiteId: input.siteId }),
  );

  const { siteId, ...reportQuery } = input;
  const result = await runReportQuery(reportQuery, { siteId, workcenterIds: scope.workcenterIds });
  if ("error" in result) throwServiceError(result);
  return result;
});
