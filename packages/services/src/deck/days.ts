import type { DeckRange, EditionShift } from "./types.js";

// Which business dates a deck covers as of a moment (ADR-0018). Pure: the
// caller lists the workcenter's scheduled shifts around that moment.
//
// "Yesterday" is the latest business date whose scheduled shifts had all
// ended by then, so a weekend is never it. "Previous 7 days" is the seven
// calendar business dates ending on that day.

export interface ShiftRow {
  id: string;
  shiftName: string;
  businessDate: string;
  startMs: number;
  endMs: number;
}

const DAY_MS = 86_400_000;

export const dateOnly = (date: Date) => date.toISOString().slice(0, 10);

export const addDays = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

export function datesBetween(from: string, to: string): string[] {
  const dates: string[] = [];
  for (let date = from; date <= to; date = addDays(date, 1)) dates.push(date);
  return dates;
}

const RANGE_DAYS: Record<DeckRange, number> = { yesterday: 1, "yesterday-7": 7 };

export interface DeckDays {
  dateFrom: string;
  dateTo: string;
  /** The scheduled shifts in those dates that had ended, oldest first. */
  shifts: ShiftRow[];
}

/** The deck's days as of `asOfMs`, or null when no business day has finished in the listing. */
export function deckDays(range: DeckRange, shifts: readonly ShiftRow[], asOfMs: number): DeckDays | null {
  const endsBy = new Map<string, number>();
  for (const shift of shifts) {
    endsBy.set(shift.businessDate, Math.max(endsBy.get(shift.businessDate) ?? 0, shift.endMs));
  }
  const dateTo = [...endsBy]
    .filter(([, endMs]) => endMs <= asOfMs)
    .map(([date]) => date)
    .sort()
    .at(-1);
  if (!dateTo) return null;
  const dateFrom = addDays(dateTo, 1 - RANGE_DAYS[range]);
  return {
    dateFrom,
    dateTo,
    shifts: shifts
      .filter((shift) => shift.businessDate >= dateFrom && shift.businessDate <= dateTo && shift.endMs <= asOfMs)
      .sort((a, b) => a.startMs - b.startMs),
  };
}

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export const matchesShiftNames = (shift: { shiftName: string }, names: readonly string[]) =>
  names.length === 0 || names.some((name) => sameName(shift.shiftName, name));

export const toEditionShift = (shift: ShiftRow): EditionShift => ({
  id: shift.id,
  shiftName: shift.shiftName,
  businessDate: shift.businessDate,
  startTime: new Date(shift.startMs).toISOString(),
  endTime: new Date(shift.endMs).toISOString(),
});
