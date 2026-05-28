import { type ContextBuilder, type EventSchema, statelessContextBuilder } from "@rw/triggers";

/**
 * `job.changed` — fires when a job assignment changes at a station.
 *
 * The event's schema and its context builder live together so they can't drift: a future change
 * to `payload.shape` is automatically visible to the builder that produces facts from it.
 * (Today the builder is the stateless flattener from @rw/triggers; a custom builder would slot in
 * here when this event needs joined data.)
 */
export const schema: EventSchema = {
  type: "job.changed",
  displayName: "Job Changed",
  payload: {
    previousJob: { type: "string", title: "Previous Job" },
    currentJob: { type: "string", title: "Current Job" },
    department: { type: "string", title: "Department" },
    station: { type: "string", title: "Station" },
    businessDate: { type: "string", title: "Business Date" },
    shift: { type: "string", title: "Shift" },
  },
};

export const contextBuilder: ContextBuilder = statelessContextBuilder;
