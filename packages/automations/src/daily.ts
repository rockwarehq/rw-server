import type { DailySchedule } from "./types.js";

/** A moment as seen on a wall clock in some timezone. `dayOfWeek` is 0 = Sunday … 6 = Saturday. */
export interface LocalTime {
  date: string; // YYYY-MM-DD
  time: string; // HH:MM
  dayOfWeek: number;
}

function wallClock(at: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value);
  return { y: get("year"), m: get("month"), d: get("day"), h: get("hour"), mi: get("minute"), s: get("second") };
}

/** Milliseconds the timezone's wall clock is ahead of UTC at `at`. */
function offsetMs(at: Date, timeZone: string): number {
  const w = wallClock(at, timeZone);
  return Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s) - Math.floor(at.getTime() / 1000) * 1000;
}

export function localTime(at: Date, timeZone: string): LocalTime {
  const w = wallClock(at, timeZone);
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    date: `${w.y}-${pad(w.m)}-${pad(w.d)}`,
    time: `${pad(w.h)}:${pad(w.mi)}`,
    dayOfWeek: new Date(Date.UTC(w.y, w.m - 1, w.d)).getUTCDay(),
  };
}

/** Whether a wall-clock moment is one the schedule fires at. */
export function scheduleMatches(schedule: DailySchedule, local: LocalTime): boolean {
  return local.time === schedule.time && (schedule.days.length === 0 || schedule.days.includes(local.dayOfWeek));
}

/**
 * The first instant strictly after `after` when the schedule fires in `timeZone`. A time skipped by a
 * spring-forward change lands an hour later; a time repeated by a fall-back change fires once.
 */
export function nextDailyRun(schedule: DailySchedule, timeZone: string, after: Date): Date {
  const [h, mi] = schedule.time.split(":").map(Number) as [number, number];
  const today = wallClock(after, timeZone);
  for (let i = 0; i <= 7; i++) {
    const day = new Date(Date.UTC(today.y, today.m - 1, today.d + i));
    if (schedule.days.length > 0 && !schedule.days.includes(day.getUTCDay())) continue;
    const asUtc = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), h, mi);
    const guess = asUtc - offsetMs(new Date(asUtc), timeZone);
    const at = new Date(asUtc - offsetMs(new Date(guess), timeZone));
    if (at > after) return at;
  }
  throw new Error(`schedule ${JSON.stringify(schedule)} has no run in the week after ${after.toISOString()}`);
}
