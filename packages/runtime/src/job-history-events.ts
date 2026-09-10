// Job history amendment event contract — a retroactive correction of which job a
// station ran over a window. Mirrors job-events; dependency-free by design.

import { type EventCause, isOptionalCause, isOptionalString, sanitizeSubjectToken } from "./domain-events.js";

export const JOB_HISTORY_EVENT_STREAM = "RW_JOB_HISTORY_EVENTS";
export const JOB_HISTORY_EVENT_SUBJECT_PREFIX = "job-history";
export const JOB_HISTORY_EVENT_SUBJECT_FILTER = `${JOB_HISTORY_EVENT_SUBJECT_PREFIX}.>`;

export type JobHistoryEventAction = "amended";

/// One event per amendment, published after the facts are rewritten. Consumers
/// query the window themselves; the payload names the amendment, not the rows.
export interface JobHistoryAmendedEvent {
  id: string; // event id — published as msgID for JetStream dedup
  action: JobHistoryEventAction;
  workspaceId: string;
  siteId: string;
  stationId: string;
  stationName: string;
  amendmentId: string;
  /** The job asserted over the window; absent = the station ran no job. */
  jobId?: string;
  jobName?: string;
  jobVersionId?: string;
  /** Jobs whose logs were trimmed or removed by the rewrite. */
  displacedJobIds: string[];
  from: string;
  /** Absent = through now; Station.currentJobId changed. */
  to?: string;
  changedByEmployeeId?: string;
  changedByEmployeeName?: string;
  source: "MANUAL" | "SYSTEM";
  cause?: EventCause;
  emittedAt: string;
}

export function deriveJobHistoryEventSubject(input: {
  siteId: string;
  stationId: string;
  action: JobHistoryEventAction;
}): string {
  const site = sanitizeSubjectToken(input.siteId);
  const station = sanitizeSubjectToken(input.stationId);
  const action = sanitizeSubjectToken(input.action);
  if (!site || !station || !action) {
    throw new Error("job history event subject requires siteId, stationId, and action");
  }
  return `${JOB_HISTORY_EVENT_SUBJECT_PREFIX}.${site}.${station}.${action}`;
}

export function isJobHistoryAmendedEvent(value: unknown): value is JobHistoryAmendedEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const event = value as Partial<JobHistoryAmendedEvent>;
  return (
    typeof event.id === "string" &&
    event.action === "amended" &&
    typeof event.workspaceId === "string" &&
    typeof event.siteId === "string" &&
    typeof event.stationId === "string" &&
    typeof event.stationName === "string" &&
    typeof event.amendmentId === "string" &&
    isOptionalString(event.jobId) &&
    isOptionalString(event.jobName) &&
    isOptionalString(event.jobVersionId) &&
    Array.isArray(event.displacedJobIds) &&
    event.displacedJobIds.every((id) => typeof id === "string") &&
    typeof event.from === "string" &&
    isOptionalString(event.to) &&
    isOptionalString(event.changedByEmployeeId) &&
    isOptionalString(event.changedByEmployeeName) &&
    (event.source === "MANUAL" || event.source === "SYSTEM") &&
    isOptionalCause(event.cause) &&
    typeof event.emittedAt === "string"
  );
}

export function parseJobHistoryAmendedEvent(value: unknown): JobHistoryAmendedEvent | null {
  return isJobHistoryAmendedEvent(value) ? value : null;
}
