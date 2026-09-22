/**
 * Report builder endpoints over the reporting catalog: `schema` feeds the
 * fact/measure/dimension/field pickers; `query` compiles one GROUP BY and
 * `rows` lists the rows themselves. Site scoping and workcenter-grant
 * narrowing are injected here — the compiler refuses to run without a scope.
 *
 * `rows` is `authRequired`, not `userOrDisplayRequired`: aggregates hide
 * individuals, detail rows don't, and display tokens are unattended
 * shop-floor screens. A wall board can have the totals, not the list.
 */

import { authorizeList } from "@rw/auth/iam/policy";
import { FACTS, reportSchema, runReportQuery, runReportRows } from "@rw/services/reporting/index";
import { z } from "zod";
import { grant } from "./authz.js";
import { throwServiceError } from "./errors.js";
import { authRequired, userOrDisplayRequired } from "./middleware.js";

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD");

const filterSchema = z
  .array(
    z.object({
      // A dimension, a detail field, or a measure — the catalog resolves it and
      // refuses operators the target's type doesn't accept.
      dimension: z.string().max(64),
      op: z.enum([
        "eq",
        "neq",
        "in",
        "notIn",
        "gt",
        "gte",
        "lt",
        "lte",
        "between",
        "notBetween",
        "contains",
        "beginsWith",
        "isNull",
        "notNull",
        "hasLabel",
        "notHasLabel",
      ]),
      // Omitted for isNull/notNull; two values for between/notBetween.
      value: z.union([z.string().max(256), z.array(z.string().max(256)).max(200)]).optional(),
    }),
  )
  .max(20)
  .optional();

const querySchema = z.object({
  siteId: z.uuid(),
  fact: z.string().max(64),
  measures: z.array(z.string().max(64)).min(1).max(20),
  // A grouped report can legitimately carry every dimension a fact has;
  // the row limit is what bounds the result, not the width.
  dimensions: z.array(z.string().max(64)).max(25).default([]),
  filters: filterSchema,
  dateFrom: dateString.optional(),
  dateTo: dateString.optional(),
  dateGranularity: z.enum(["hour", "day", "week", "month", "year"]).optional(),
  orderBy: z.object({ field: z.string().max(64), dir: z.enum(["asc", "desc"]) }).optional(),
  limit: z.number().int().min(1).max(10000).optional(),
  offset: z.number().int().min(0).optional(),
  // Group count, so an aggregate log paginates like a row log.
  includeTotal: z.boolean().optional(),
});

const rowsSchema = z.object({
  siteId: z.uuid(),
  fact: z.string().max(64),
  // Dimension, field or measure keys, in the caller's own display order.
  columns: z.array(z.string().max(64)).min(1).max(40),
  filters: filterSchema,
  dateFrom: dateString.optional(),
  dateTo: dateString.optional(),
  orderBy: z.object({ field: z.string().max(64), dir: z.enum(["asc", "desc"]) }).optional(),
  // Defaults to a grid page in the compiler; the ceiling is here for exports.
  limit: z.number().int().min(1).max(10000).optional(),
  offset: z.number().int().min(0).optional(),
  includeTotal: z.boolean().optional(),
});

export const schema = userOrDisplayRequired
  .input(z.object({ siteId: z.uuid() }))
  .handler(async ({ input, context }) => {
    const scope = grant(
      await authorizeList(context.iam, { permission: "production:read", requestedSiteId: input.siteId }),
    );
    return {
      facts: reportSchema(new Set(["production:read"])).filter(
        (fact) => !scope.workcenterIds || FACTS[fact.key].workcenterColumn || FACTS[fact.key].workcenterPredicate,
      ),
    };
  });

export const query = userOrDisplayRequired.input(querySchema).handler(async ({ input, context }) => {
  const fact = FACTS[input.fact];
  if (!fact) throwServiceError({ error: `Unknown fact: ${input.fact}`, code: "UNKNOWN_FACT" });
  const scope = grant(
    await authorizeList(context.iam, { permission: "production:read", requestedSiteId: input.siteId }),
  );

  const { siteId, ...reportQuery } = input;
  const result = await runReportQuery(reportQuery, { siteId, workcenterIds: scope.workcenterIds });
  if ("error" in result) throwServiceError(result, { WORKCENTER_RESTRICTED: "FORBIDDEN" });
  return result;
});

export const rows = authRequired.input(rowsSchema).handler(async ({ input, context }) => {
  const fact = FACTS[input.fact];
  if (!fact) throwServiceError({ error: `Unknown fact: ${input.fact}`, code: "UNKNOWN_FACT" });
  const scope = grant(
    await authorizeList(context.iam, { permission: "production:read", requestedSiteId: input.siteId }),
  );

  const { siteId, ...rowsQuery } = input;
  const result = await runReportRows(rowsQuery, { siteId, workcenterIds: scope.workcenterIds });
  if ("error" in result) throwServiceError(result, { WORKCENTER_RESTRICTED: "FORBIDDEN" });
  return result;
});
