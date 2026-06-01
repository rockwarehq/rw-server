import { type ContextBuilder, type EventSchema, statelessContextBuilder } from "@rw/automations";

/**
 * `job.changed` — fires when a job assignment changes at a station.
 */
export const schema: EventSchema = {
  type: "job.changed",
  displayName: "Job Changed",
  latest: "1",
  versions: {
    "1": {
      payload: {
        previousJobId: { type: "string", title: "Previous Job", ref: { source: "jobs" } },
        currentJobId: { type: "string", title: "Current Job", ref: { source: "jobs" } },
        stationId: { type: "string", title: "Station", ref: { source: "stations" } },
        workCenterId: { type: "string", title: "Work Center", ref: { source: "workCenters" } },
        previousJobName: { type: "string", title: "Previous Job Name", matchable: false },
        currentJobName: { type: "string", title: "Current Job Name", matchable: false },
        stationName: { type: "string", title: "Station Name", matchable: false },
        workCenterName: { type: "string", title: "Work Center Name", matchable: false },
      },
    },
  },
};

export const contextBuilder: ContextBuilder = statelessContextBuilder;
