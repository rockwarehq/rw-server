import { type ContextBuilder, type EventSchema, statelessContextBuilder } from "@rw/automations";
import type { JobEvent } from "@rw/runtime/job-events";
import { WORK_CONTEXT_PROPS, workContextPayload } from "./work-context.js";

/** `job.changed` — the job at a station changed. Fed by the `jobs.>` stream via the automation event consumer. */
export const schema: EventSchema = {
  type: "job.changed",
  displayName: "Job Changed",
  latest: "1",
  versions: {
    "1": {
      scopeKey: "stationId",
      cooldownKey: "stationId",
      payload: {
        siteId: { type: "string", title: "Site", matchable: false },
        stationId: { type: "string", title: "Station", ref: { source: "stations" } },
        stationName: { type: "string", title: "Station Name", matchable: false },
        previousJobId: { type: "string", title: "Previous Job", ref: { source: "jobs" } },
        previousJobName: { type: "string", title: "Previous Job Name", matchable: false },
        // The new job is the shared work-context `jobId` / `jobName` (empty when the job was cleared).
        ...WORK_CONTEXT_PROPS,
        source: { type: "string", title: "Triggered By", enum: ["MANUAL", "SYSTEM"], matchable: false },
        sourceType: { type: "string", title: "Trigger Type", matchable: false },
        sourceRef: { type: "string", title: "Source Ref", matchable: false },
        changedByEmployeeId: { type: "string", title: "Changed By (Employee Id)", matchable: false },
      },
    },
  },
};

export const contextBuilder: ContextBuilder = statelessContextBuilder;

export function fromJobEvent(e: JobEvent): Record<string, unknown> {
  return {
    ...workContextPayload(e),
    siteId: e.siteId,
    stationId: e.stationId,
    stationName: e.stationName,
    previousJobId: e.previousJobId,
    previousJobName: e.previousJobName,
    source: e.source,
    sourceType: e.sourceType,
    sourceRef: e.sourceRef,
    changedByEmployeeId: e.changedByEmployeeId,
  };
}
