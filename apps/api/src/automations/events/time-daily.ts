import { type ContextBuilder, type EventSchema, type LocalTime, statelessContextBuilder } from "@rw/automations";

export const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * `time.daily` — a clock trigger. Each automation on this event carries a `schedule` (time of day +
 * days of the week, site-local); `src/nats/automation-clock.ts` fires the event at that automation
 * alone when the time comes.
 */
export const schema: EventSchema = {
  type: "time.daily",
  displayName: "Time of Day",
  latest: "1",
  versions: {
    "1": {
      payload: {
        siteId: { type: "string", title: "Site", matchable: false },
        time: { type: "string", title: "Time", matchable: false },
        dayOfWeek: { type: "string", title: "Day of Week", enum: DAY_NAMES },
        date: { type: "string", title: "Date", matchable: false },
        scheduledAt: { type: "string", title: "Scheduled At", matchable: false },
      },
    },
  },
};

export const contextBuilder: ContextBuilder = statelessContextBuilder;

export function fromClock(siteId: string, runAt: Date, local: LocalTime): Record<string, unknown> {
  return {
    siteId,
    time: local.time,
    dayOfWeek: DAY_NAMES[local.dayOfWeek],
    date: local.date,
    scheduledAt: runAt.toISOString(),
  };
}
