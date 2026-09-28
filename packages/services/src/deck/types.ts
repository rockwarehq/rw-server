import { z } from "zod";
import { FILTER_OPS } from "../reporting/types.js";

// What a deck is made of (ADR-0018). A page keeps the report's own state for
// drawing (`params`, the UI's business) and the queries it makes, without
// dates: the edition fills those in.

export const DECK_RANGES = ["yesterday", "yesterday-7"] as const;
export type DeckRange = (typeof DECK_RANGES)[number];

const filterSchema = z.object({
  dimension: z.string().min(1).max(64),
  op: z.enum(FILTER_OPS),
  value: z.union([z.string().max(256), z.array(z.string().max(256)).max(200)]).optional(),
});

const orderBySchema = z.object({ field: z.string().max(64), dir: z.enum(["asc", "desc"]) });

/** A report.query or report.rows input with no dates. */
export const queryTemplateSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("query"),
    fact: z.string().min(1).max(64),
    measures: z.array(z.string().max(64)).min(1).max(20),
    dimensions: z.array(z.string().max(64)).max(10),
    filters: z.array(filterSchema).max(20).optional(),
    dateGranularity: z.enum(["hour", "day", "week", "month", "year"]).optional(),
    orderBy: orderBySchema.optional(),
    limit: z.number().int().min(1).max(10000).optional(),
  }),
  z.object({
    mode: z.literal("rows"),
    fact: z.string().min(1).max(64),
    columns: z.array(z.string().max(64)).min(1).max(40),
    filters: z.array(filterSchema).max(20).optional(),
    orderBy: orderBySchema.optional(),
  }),
]);
export type QueryTemplate = z.infer<typeof queryTemplateSchema>;

export const slideSchema = z.object({
  id: z.string().min(1).max(64),
  kind: z.string().min(1).max(40),
  title: z.string().min(1).max(200),
  params: z.record(z.string(), z.unknown()).default({}),
  /** Only these shifts (by name); empty = every shift. */
  shiftNames: z.array(z.string().min(1).max(64)).max(10).default([]),
  /** Slot → query. A kind that draws from other data has none. */
  queries: z
    .record(z.string().min(1).max(40), queryTemplateSchema)
    .default({})
    .refine((queries) => Object.keys(queries).length <= 12, "At most 12 queries a page"),
});
export type DeckSlide = z.infer<typeof slideSchema>;

export const slidesSchema = z.array(slideSchema).max(30);

/** A shift an edition page covers. */
export interface EditionShift {
  id: string;
  shiftName: string;
  businessDate: string;
  startTime: string;
  endTime: string;
}

/** One query's stored outcome. */
export type StoredResult =
  | { rows: Record<string, unknown>[]; truncated: boolean; total?: number }
  | { error: string; code: string };

export interface EditionPage {
  key: string;
  slideId: string;
  /** The page's own title: the slide's, with the day or shift when a slide is several pages. */
  title: string;
  dateFrom: string;
  dateTo: string;
  /** The shifts it covers when it is narrowed to them or is one shift. */
  shifts: EditionShift[] | null;
  /** Why it has nothing to show, when it doesn't. */
  message?: string;
  results: Record<string, StoredResult>;
}

/** The deck as an edition keeps it. */
export interface EditionSetup {
  name: string;
  range: DeckRange;
  workcenterId: string;
  workcenterName: string;
  slides: DeckSlide[];
}
