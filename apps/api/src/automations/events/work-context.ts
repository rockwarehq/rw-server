import type { SchemaProperty } from "@rw/automations";
import type { WorkContext } from "@rw/runtime/domain-events";

// Condition facts shared by every shop-floor event: where it happened. Ids are matchable via
// pickers; names and the raw business date are template variables only; the business day of
// week is derived so "not on Saturday" is one rule.

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export const WORK_CONTEXT_PROPS: Record<string, SchemaProperty> = {
  workcenterId: { type: "string", title: "Work Center", ref: { source: "workCenters" } },
  workcenterName: { type: "string", title: "Work Center Name", matchable: false },
  jobId: { type: "string", title: "Job", ref: { source: "jobs" } },
  jobName: { type: "string", title: "Job Name", matchable: false },
  shiftName: { type: "string", title: "Shift", ref: { source: "shiftNames" } },
  businessDay: { type: "string", title: "Business Day", enum: DAYS },
  businessDate: { type: "string", title: "Business Date", matchable: false },
};

export function workContextPayload(e: WorkContext): Record<string, unknown> {
  return {
    workcenterId: e.workcenterId,
    workcenterName: e.workcenterName,
    jobId: e.jobId,
    jobName: e.jobName,
    shiftName: e.shiftName,
    businessDay: e.businessDate ? DAYS[new Date(`${e.businessDate}T00:00:00Z`).getUTCDay()] : undefined,
    businessDate: e.businessDate,
  };
}
