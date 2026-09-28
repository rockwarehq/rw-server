// Date ranges the way people say them ("last week", "this month"), turned into
// real work days in the site's time zone.
//
// Keep RELATIVE_PRESETS and the rules below the same as rw-ui
// apps/rw-imm/src/reports/explorer/definition.ts, so a saved report shows the
// same days on the server and in the browser. Weeks start on Monday.

export const RELATIVE_PRESETS = [
  "today",
  "yesterday",
  "this-week",
  "last-week",
  "last-7-days",
  "this-month",
  "last-month",
  "last-30-days",
  "this-quarter",
  "last-90-days",
] as const;
export type RelativePreset = (typeof RELATIVE_PRESETS)[number];

export type ReportDateRange =
  | { kind: "all" }
  | { kind: "relative"; preset: RelativePreset }
  | { kind: "absolute"; from: string; to: string };

/** The calendar date (YYYY-MM-DD) at `nowMs` in `timezone`. */
export function siteDate(nowMs: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(nowMs);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/** Move a YYYY-MM-DD date by some days. */
export function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/** Days since the last Monday (0 on a Monday). */
function mondayOffset(date: string): number {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return (day + 6) % 7;
}

/** The first day of the month `months` away from the month holding `date`. */
function monthStart(date: string, months = 0): string {
  const value = new Date(`${date.slice(0, 8)}01T00:00:00Z`);
  value.setUTCMonth(value.getUTCMonth() + months);
  return value.toISOString().slice(0, 10);
}

/** Turn a date range into from/to work days. "all" has no bounds. */
export function resolveDateRange(
  range: ReportDateRange,
  timezone: string,
  nowMs: number,
): { dateFrom?: string; dateTo?: string } {
  if (range.kind === "all") return {};
  if (range.kind === "absolute") return { dateFrom: range.from, dateTo: range.to };
  const today = siteDate(nowMs, timezone);
  switch (range.preset) {
    case "today":
      return { dateFrom: today, dateTo: today };
    case "yesterday": {
      const date = addDays(today, -1);
      return { dateFrom: date, dateTo: date };
    }
    case "this-week":
      return { dateFrom: addDays(today, -mondayOffset(today)), dateTo: today };
    case "last-week": {
      const monday = addDays(today, -mondayOffset(today) - 7);
      return { dateFrom: monday, dateTo: addDays(monday, 6) };
    }
    case "last-7-days":
      return { dateFrom: addDays(today, -6), dateTo: today };
    case "this-month":
      return { dateFrom: monthStart(today), dateTo: today };
    case "last-month":
      return { dateFrom: monthStart(today, -1), dateTo: addDays(monthStart(today), -1) };
    case "last-30-days":
      return { dateFrom: addDays(today, -29), dateTo: today };
    case "this-quarter": {
      const month = Number(today.slice(5, 7));
      const back = (month - 1) % 3;
      return { dateFrom: monthStart(today, -back), dateTo: today };
    }
    case "last-90-days":
      return { dateFrom: addDays(today, -89), dateTo: today };
  }
}
