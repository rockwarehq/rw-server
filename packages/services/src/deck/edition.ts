import prisma from "@rw/db";
import { FACTS, reportSchema, runReportQuery, runReportRows } from "../reporting/index.js";
import type { ReportFilter } from "../reporting/types.js";
import { addDays, dateOnly, datesBetween, deckDays, matchesShiftNames, type ShiftRow, toEditionShift } from "./days.js";
import type { DeckRange, DeckSlide, EditionPage, EditionSetup, QueryTemplate, StoredResult } from "./types.js";

// Making an edition (ADR-0018): the deck's days as of a moment, every page's
// queries run with the deck's workcenter as the scope, and the results kept.

/** Row lists keep this many rows, with the total. */
export const ROW_CAP = 1000;

/** How far back to look for the last finished business day. */
const LOOKBACK_DAYS = 45;

/** Pages a slide may split into at most. */
const MAX_PAGES = 31;

export interface DeckInput {
  siteId: string;
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

/** One query, as of the page's dates, narrowed to the deck's workcenter and the page's shifts. */
async function runQuery(
  template: QueryTemplate,
  page: EditionPage,
  scope: { siteId: string; workcenterIds: string[] },
): Promise<StoredResult> {
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
  const dates = { dateFrom: page.dateFrom, dateTo: page.dateTo };
  let result: Awaited<ReturnType<typeof runReportQuery>>;
  if (template.mode === "rows") {
    const { mode: _rows, ...rows } = template;
    result = await runReportRows({ ...rows, ...dates, filters, limit: ROW_CAP, includeTotal: true }, scope);
  } else {
    const { mode: _query, ...query } = template;
    result = await runReportQuery({ ...query, ...dates, filters }, scope);
  }
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

/** The pages a slide makes over the deck's days: one, or one per day or shift for the kinds that show one at a time. */
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
  if (slide.kind === "daily-production") {
    const worked = new Set(shifts.map((shift) => shift.businessDate));
    return datesBetween(days.dateFrom, days.dateTo)
      .filter((date) => worked.has(date))
      .map((date) =>
        page(
          date,
          `${slide.title} · ${date}`,
          date,
          date,
          named ? shifts.filter((shift) => shift.businessDate === date) : null,
        ),
      );
  }
  return [page("all", slide.title, days.dateFrom, days.dateTo, named ? shifts : null)];
}

/** The days a deck with this range and workcenter covers as of `asOf`, without running anything. */
export async function deckSpan(range: DeckRange, workcenterId: string, asOf: Date) {
  const days = deckDays(range, await scheduledShifts(workcenterId, asOf), asOf.getTime());
  return days && { dateFrom: days.dateFrom, dateTo: days.dateTo, shifts: days.shifts.map(toEditionShift) };
}

/** Work out a deck as of `asOf` and run every page's queries. Nothing is saved. */
export async function buildEdition(deck: DeckInput, asOf: Date): Promise<BuiltEdition> {
  const workcenter = await prisma.workcenter.findUnique({ where: { id: deck.workcenterId }, select: { name: true } });
  const setup: EditionSetup = {
    name: deck.name,
    range: deck.range,
    workcenterId: deck.workcenterId,
    workcenterName: workcenter?.name ?? "",
    slides: deck.slides,
  };
  const days = deckDays(deck.range, await scheduledShifts(deck.workcenterId, asOf), asOf.getTime());
  if (!days) {
    const message = "No business day at this workcenter has finished yet.";
    const pages = deck.slides.map((slide) => emptyPage(slide, { dateFrom: "", dateTo: "" }, message));
    return { asOf, dateFrom: null, dateTo: null, setup, pages, facts: {} };
  }

  const scope = { siteId: deck.siteId, workcenterIds: [deck.workcenterId] };
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
    for (const page of split.slice(0, MAX_PAGES)) {
      for (const [slot, template] of Object.entries(slide.queries)) {
        page.results[slot] = await runQuery(template, page, scope);
      }
      pages.push(page);
    }
  }

  const used = new Set(deck.slides.flatMap((slide) => Object.values(slide.queries).map((query) => query.fact)));
  const facts = Object.fromEntries(reportSchema().flatMap((fact) => (used.has(fact.key) ? [[fact.key, fact]] : [])));
  return { asOf, dateFrom: days.dateFrom, dateTo: days.dateTo, setup, pages, facts };
}
