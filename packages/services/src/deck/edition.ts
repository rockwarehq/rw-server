import prisma from "@rw/db";
import { FACTS, reportSchema, runReportQuery, runReportRows, runReportSummary } from "../reporting/index.js";
import type { ReportFilter, ReportSummaryItem } from "../reporting/types.js";
import { addDays, dateOnly, deckDays, matchesShiftNames, type ShiftRow, toEditionShift } from "./days.js";
import type {
  DeckKind,
  DeckRange,
  DeckSlide,
  EditionPage,
  EditionSetup,
  QueryTemplate,
  StoredResult,
} from "./types.js";

// Making an edition (ADR-0018): the deck's days as of a moment and its pages
// over them. An edition keeps the question, never the answer — no query runs
// here and no result is stored. A page's saved queries are run when it is
// read (`runPageQuery`), with the deck's workcenter as the scope.

/** The most rows of a row list one read returns; the total comes with them. */
export const ROW_CAP = 1000;

/** How far back to look for the last finished business day. */
const LOOKBACK_DAYS = 45;

/** Pages a slide may split into at most. */
const MAX_PAGES = 31;

export interface DeckInput {
  siteId: string;
  kind: DeckKind;
  name: string;
  range: DeckRange;
  workcenterId: string;
  slides: DeckSlide[];
}

export interface BuiltEdition {
  asOf: Date;
  dateFrom: string | null;
  dateTo: string | null;
  setup: EditionSetup;
  pages: EditionPage[];
  facts: Record<string, unknown>;
}

async function scheduledShifts(workcenterId: string, asOf: Date): Promise<ShiftRow[]> {
  const today = dateOnly(asOf);
  const rows = await prisma.shiftInstance.findMany({
    where: {
      workCenterId: workcenterId,
      isScheduled: true,
      businessDate: { gte: new Date(addDays(today, -LOOKBACK_DAYS)), lte: new Date(addDays(today, 1)) },
    },
    select: { id: true, shiftName: true, businessDate: true, startTime: true, endTime: true },
  });
  return rows.map((row) => ({
    id: row.id,
    shiftName: row.shiftName,
    businessDate: dateOnly(row.businessDate),
    startMs: row.startTime.getTime(),
    endMs: row.endTime.getTime(),
  }));
}

type Scope = { siteId: string; workcenterIds: string[] };
type QueryError = { error: string; code: string };

/** A page's saved filters narrowed to the page's shifts, or why they can't be. */
function pageFilters(template: QueryTemplate, page: EditionPage): ReportFilter[] | QueryError {
  const fact = FACTS[template.fact];
  if (!fact) return { error: `Unknown dataset: ${template.fact}`, code: "UNKNOWN_FACT" };
  const filters = [...(template.filters ?? [])] as ReportFilter[];
  // The names as the calendar spells them: the slide's were matched ignoring case and spaces.
  const shiftNames = [...new Set((page.shifts ?? []).map((shift) => shift.shiftName))];
  if (shiftNames.length > 0) {
    if (!fact.dimensions.shiftName) {
      return { error: "This report can't be narrowed to shifts.", code: "SHIFT_UNSUPPORTED" };
    }
    filters.push({ dimension: "shiftName", op: "in", value: shiftNames });
  }
  return filters;
}

/** What a reader may ask of a row list: which rows of it, and in what order. Never which rows match. */
export interface PageRead {
  limit?: number;
  offset?: number;
  orderBy?: { field: string; dir: "asc" | "desc" };
}

/**
 * One query, as of the page's dates, narrowed to the deck's workcenter and
 * the page's shifts. A row list comes back at most ROW_CAP rows at a time;
 * `read` says which of them, and in what order.
 */
export async function runPageQuery(
  template: QueryTemplate,
  page: EditionPage,
  scope: Scope,
  read?: PageRead,
): Promise<StoredResult> {
  const filters = pageFilters(template, page);
  if ("error" in filters) return filters;
  const dates = { dateFrom: page.dateFrom, dateTo: page.dateTo };
  let result: Awaited<ReturnType<typeof runReportQuery>>;
  if (template.mode === "rows") {
    const { mode: _rows, ...rows } = template;
    result = await runReportRows(
      {
        ...rows,
        ...dates,
        filters,
        includeTotal: true,
        limit: Math.min(read?.limit ?? ROW_CAP, ROW_CAP),
        ...(read?.offset ? { offset: read.offset } : {}),
        ...(read?.orderBy ? { orderBy: read.orderBy } : {}),
      },
      scope,
    );
  } else {
    const { mode: _query, ...query } = template;
    result = await runReportQuery({ ...query, ...dates, filters }, scope);
  }
  return "error" in result ? { error: result.error, code: result.code } : result;
}

/**
 * Figures over every row a page's row list matches: the same dates,
 * workcenter, shifts and filters — and only over the columns the page saved,
 * so a reader learns nothing from a figure that the rows don't already show.
 * A row count names no column and is always allowed.
 */
export async function runPageSummary(
  template: QueryTemplate,
  page: EditionPage,
  scope: Scope,
  items: ReportSummaryItem[],
): Promise<{ values: (number | null)[] } | QueryError> {
  if (template.mode !== "rows") return { error: "Only a row list has a summary.", code: "INVALID_QUERY" };
  const unsaved = items.find((item) => item.agg !== "count" && !(item.key && template.columns.includes(item.key)));
  if (unsaved) {
    return { error: `${unsaved.key ?? "A figure"} is not a column of this page.`, code: "COLUMN_NOT_SAVED" };
  }
  const filters = pageFilters(template, page);
  if ("error" in filters) return filters;
  const result = await runReportSummary(
    { fact: template.fact, items, filters, dateFrom: page.dateFrom, dateTo: page.dateTo },
    scope,
  );
  return "error" in result ? { error: result.error, code: result.code } : result;
}

const emptyPage = (slide: DeckSlide, dates: { dateFrom: string; dateTo: string }, message: string): EditionPage => ({
  key: slide.id,
  slideId: slide.id,
  title: slide.title,
  ...dates,
  shifts: null,
  message,
  results: {},
});

/** The pages a slide makes over the deck's days: one, or one per shift for a shift recap, which shows one at a time. */
function slidePages(slide: DeckSlide, days: NonNullable<ReturnType<typeof deckDays>>): EditionPage[] {
  const shifts = days.shifts.filter((shift) => matchesShiftNames(shift, slide.shiftNames));
  const named = slide.shiftNames.length > 0;
  const page = (key: string, title: string, dateFrom: string, dateTo: string, on: ShiftRow[] | null) => ({
    key: `${slide.id}:${key}`,
    slideId: slide.id,
    title,
    dateFrom,
    dateTo,
    shifts: on ? on.map(toEditionShift) : null,
    results: {},
  });

  if (slide.kind === "shift-recap") {
    return shifts.map((shift) =>
      page(
        shift.id,
        `${slide.title} · ${shift.shiftName} ${shift.businessDate}`,
        shift.businessDate,
        shift.businessDate,
        [shift],
      ),
    );
  }
  return [page("all", slide.title, days.dateFrom, days.dateTo, named ? shifts : null)];
}

/** The shift names a "last-shift" range picks among: its pages'. */
const rangeShiftNames = (slides: readonly DeckSlide[]) => [...new Set(slides.flatMap((slide) => slide.shiftNames))];

/** The days a deck with this range and workcenter covers as of `asOf`, without running anything. */
export async function deckSpan(range: DeckRange, workcenterId: string, asOf: Date, shiftNames: string[] = []) {
  const days = deckDays(range, await scheduledShifts(workcenterId, asOf), asOf.getTime(), shiftNames);
  return days && { dateFrom: days.dateFrom, dateTo: days.dateTo, shifts: days.shifts.map(toEditionShift) };
}

/**
 * Work out a deck as of `asOf`: its days and its pages over them. No query
 * runs and nothing is saved; a page's `results` are always empty.
 */
export async function buildEdition(deck: DeckInput, asOf: Date): Promise<BuiltEdition> {
  const workcenter = await prisma.workcenter.findUnique({ where: { id: deck.workcenterId }, select: { name: true } });
  const setup: EditionSetup = {
    kind: deck.kind,
    name: deck.name,
    range: deck.range,
    workcenterId: deck.workcenterId,
    workcenterName: workcenter?.name ?? "",
    slides: deck.slides,
  };
  const days = deckDays(
    deck.range,
    await scheduledShifts(deck.workcenterId, asOf),
    asOf.getTime(),
    rangeShiftNames(deck.slides),
  );
  if (!days) {
    const names = rangeShiftNames(deck.slides);
    const message =
      deck.range === "last-shift"
        ? `No ${names.join(" or ")} shift at this workcenter has finished yet.`
        : "No business day at this workcenter has finished yet.";
    const pages = deck.slides.map((slide) => emptyPage(slide, { dateFrom: "", dateTo: "" }, message));
    return { asOf, dateFrom: null, dateTo: null, setup, pages, facts: {} };
  }

  const pages: EditionPage[] = [];
  for (const slide of deck.slides) {
    const split = slidePages(slide, days);
    if (split.length === 0) {
      const named = slide.shiftNames.length > 0;
      pages.push(
        emptyPage(
          slide,
          days,
          named ? `No ${slide.shiftNames.join(" or ")} shift in these days.` : "No shifts in these days.",
        ),
      );
      continue;
    }
    pages.push(...split.slice(0, MAX_PAGES));
  }

  const used = new Set(deck.slides.flatMap((slide) => Object.values(slide.queries).map((query) => query.fact)));
  const facts = Object.fromEntries(reportSchema().flatMap((fact) => (used.has(fact.key) ? [[fact.key, fact]] : [])));
  return { asOf, dateFrom: days.dateFrom, dateTo: days.dateTo, setup, pages, facts };
}
