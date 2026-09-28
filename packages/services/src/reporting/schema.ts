import { z } from "zod";
import { FILTER_OPS } from "./types.js";

// The wire shape of a report query, shared by report.query / report.rows and
// the queries a deck page keeps (ADR-0018), so the two can't drift.

export const reportFiltersSchema = z
  .array(
    z.object({
      // A dimension, a detail field, or a measure — the catalog resolves it and
      // refuses operators the target's type doesn't accept.
      dimension: z.string().max(64),
      op: z.enum(FILTER_OPS),
      // Omitted for isNull/notNull; two values for between/notBetween.
      value: z.union([z.string().max(256), z.array(z.string().max(256)).max(200)]).optional(),
    }),
  )
  .max(20)
  .optional();

const orderBy = z.object({ field: z.string().max(64), dir: z.enum(["asc", "desc"]) }).optional();

/** A grouped query, without its dates. */
export const reportQueryFields = {
  fact: z.string().max(64),
  measures: z.array(z.string().max(64)).min(1).max(20),
  // A grouped report can legitimately carry every dimension a fact has;
  // the row limit is what bounds the result, not the width.
  dimensions: z.array(z.string().max(64)).max(25).default([]),
  filters: reportFiltersSchema,
  dateGranularity: z.enum(["hour", "day", "week", "month", "year"]).optional(),
  orderBy,
  limit: z.number().int().min(1).max(10000).optional(),
};

/** A row listing, without its dates or paging. */
export const reportRowsFields = {
  fact: z.string().max(64),
  // Dimension, field or measure keys, in the caller's own display order.
  columns: z.array(z.string().max(64)).min(1).max(40),
  filters: reportFiltersSchema,
  orderBy,
};
