/**
 * Report builder endpoints over the reporting catalog: `schema` feeds the
 * fact/measure/dimension/field pickers; `query` compiles one GROUP BY and
 * `rows` lists the rows themselves. Site scoping and workcenter-grant
 * narrowing are injected here — the compiler refuses to run without a scope.
 *
 * `rows` is `userRequired`, not `userOrDisplayRequired`: aggregates hide
 * individuals, detail rows don't, and display tokens are unattended
 * shop-floor screens. A wall board can have the totals, not the list.
 *
 * `summary` is the figures over everything `rows` would list — the totals a
 * log shows above its pages. It takes row-level filters, so it sits behind
 * the same `userRequired` as the list it summarises.
 */

import { FACTS, reportSchema, runReportQuery, runReportRows, runReportSummary } from "@rw/services/reporting/index";
import { reportQueryFields, reportRowsFields, reportSummaryFields } from "@rw/services/reporting/schema";
import { z } from "zod";
import { throwServiceError } from "./errors.js";
import { userRequired, userOrDisplayRequired } from "./middleware.js";

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD");

const querySchema = z.object({
  siteId: z.uuid(),
  ...reportQueryFields,
  dateFrom: dateString.optional(),
  dateTo: dateString.optional(),
  offset: z.number().int().min(0).optional(),
  // Group count, so an aggregate log paginates like a row log.
  includeTotal: z.boolean().optional(),
});

const rowsSchema = z.object({
  siteId: z.uuid(),
  ...reportRowsFields,
  dateFrom: dateString.optional(),
  dateTo: dateString.optional(),
  // Defaults to a grid page in the compiler; the ceiling is here for exports.
  limit: z.number().int().min(1).max(10000).optional(),
  offset: z.number().int().min(0).optional(),
  includeTotal: z.boolean().optional(),
});

const summarySchema = z.object({
  siteId: z.uuid(),
  ...reportSummaryFields,
  dateFrom: dateString.optional(),
  dateTo: dateString.optional(),
});

export const schema = userOrDisplayRequired
  .input(z.object({ siteId: z.uuid() }))
  .handler(async ({ input, context }) => {
    // Every fact is floor data behind the same check as query/rows.
    context.access.list("VIEW", input.siteId, "WORKCENTER");
    return { facts: reportSchema() };
  });

export const query = userOrDisplayRequired.input(querySchema).handler(async ({ input, context }) => {
  const fact = FACTS[input.fact];
  if (!fact) throwServiceError({ error: `Unknown fact: ${input.fact}`, code: "UNKNOWN_FACT" });
  const scope = context.access.list("VIEW", input.siteId, "WORKCENTER");

  const { siteId, ...reportQuery } = input;
  const result = await runReportQuery(reportQuery, scope);
  if ("error" in result) throwServiceError(result);
  return result;
});

export const rows = userRequired.input(rowsSchema).handler(async ({ input, context }) => {
  const fact = FACTS[input.fact];
  if (!fact) throwServiceError({ error: `Unknown fact: ${input.fact}`, code: "UNKNOWN_FACT" });
  const scope = context.access.list("VIEW", input.siteId, "WORKCENTER");

  const { siteId, ...rowsQuery } = input;
  const result = await runReportRows(rowsQuery, scope);
  if ("error" in result) throwServiceError(result);
  return result;
});

export const summary = userRequired.input(summarySchema).handler(async ({ input, context }) => {
  const fact = FACTS[input.fact];
  if (!fact) throwServiceError({ error: `Unknown fact: ${input.fact}`, code: "UNKNOWN_FACT" });
  const scope = context.access.list("VIEW", input.siteId, "WORKCENTER");

  const { siteId, ...summaryQuery } = input;
  const result = await runReportSummary(summaryQuery, scope);
  if ("error" in result) throwServiceError(result);
  return result;
});
