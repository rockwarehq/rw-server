import { type ContextBuilder, type EventSchema, statelessContextBuilder } from "@rw/automations";

/**
 * `job.changed` — fires when a job assignment changes at a station.
 *
 * The event's schema (versioned) and its context builder live together so they can't drift: a
 * future change to a `payload.X` shape adds a new entry to `versions` while keeping older versions
 * around for automations that pin to them. The builder is shared across versions today; if a future
 * version needs payload-shape-specific facts, the builder can become a `Record<version, ContextBuilder>`.
 */
export const schema: EventSchema = {
  type: "job.changed",
  displayName: "Job Changed",
  latest: "1",
  versions: {
    "1": {
      payload: {
        // Picker-typed payload fields: the condition builder renders a `RefRegistry.list(source)`
        // dropdown instead of a plain input. Stored value is the picked id — same `ref: { source }`
        // shape as action-input refs (see SchemaProperty.ref in @rw/automations).
        previousJobId: { type: "string", title: "Previous Job", ref: { source: "jobs" } },
        currentJobId: { type: "string", title: "Current Job", ref: { source: "jobs" } },
        stationId: { type: "string", title: "Station", ref: { source: "stations" } },
        workCenterId: { type: "string", title: "Work Center", ref: { source: "workCenters" } },
        // Free-text payload fields (no ref → querybuilder renders a plain input).
        department: { type: "string", title: "Department" },
        businessDate: { type: "string", title: "Business Date" },
        shift: { type: "string", title: "Shift" },
      },
    },
  },
};

export const contextBuilder: ContextBuilder = statelessContextBuilder;
