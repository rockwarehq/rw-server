import { z } from "zod";
import { reportQueryFields, reportRowsFields } from "../reporting/schema.js";

// What a deck is made of (ADR-0018). A page keeps the report's own state for
// drawing (`params`, the UI's business) and the queries it makes, without
// dates: the edition fills those in.

/**
 * "yesterday" and "yesterday-7" are a DECK's; "last-shift" is a SHIFT_RECAP's:
 * the latest finished shift with its page's shift name.
 */
export const DECK_RANGES = ["yesterday", "yesterday-7", "last-shift"] as const;
export type DeckRange = (typeof DECK_RANGES)[number];

export const DECK_KINDS = ["DECK", "SHIFT_RECAP"] as const;
export type DeckKind = (typeof DECK_KINDS)[number];

/** The slide kind a SHIFT_RECAP's one page is. */
export const SHIFT_RECAP_SLIDE = "shift-recap";

/** A report.query or report.rows input with no dates. */
export const queryTemplateSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("query"), ...reportQueryFields }),
  z.object({ mode: z.literal("rows"), ...reportRowsFields }),
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
  /** Absent on editions made before deck kinds: a DECK. */
  kind?: DeckKind;
  name: string;
  range: DeckRange;
  workcenterId: string;
  workcenterName: string;
  slides: DeckSlide[];
}

/**
 * Why a deck of this kind can't have this range and these pages, or null.
 * A SHIFT_RECAP is one shift-recap page for one shift name over "last-shift";
 * a DECK never uses "last-shift", which covers one shift, not days.
 */
export function deckShapeProblem(kind: DeckKind, range: DeckRange, slides: readonly DeckSlide[]): string | null {
  if (kind === "DECK") {
    return range === "last-shift" ? "A deck covers days: yesterday, or the previous 7 days." : null;
  }
  if (range !== "last-shift") return "A shift recap covers the last shift.";
  const [page, ...rest] = slides;
  if (!page || rest.length > 0 || page.kind !== SHIFT_RECAP_SLIDE) return "A shift recap is one shift recap page.";
  if (page.shiftNames.length !== 1) return "A shift recap names one shift.";
  return null;
}
