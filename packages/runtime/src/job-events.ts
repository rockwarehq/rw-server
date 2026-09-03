// Station job-change event contract — subject derivation, payload shape, and
// type guards shared by the publisher (apps/api) and any NATS consumers.
// Mirrors call-events; dependency-free by design.

import {
  type EventCause,
  isOptionalCause,
  isOptionalString,
  isOptionalWorkContext,
  sanitizeSubjectToken,
  type WorkContext,
} from "./domain-events.js";

export const JOB_EVENT_STREAM = "RW_JOB_EVENTS";
export const JOB_EVENT_SUBJECT_PREFIX = "jobs";
export const JOB_EVENT_SUBJECT_FILTER = `${JOB_EVENT_SUBJECT_PREFIX}.>`;

export type JobEventAction = "changed";
export type JobEventSource = "MANUAL" | "SYSTEM";

/// One event per station job change. WorkContext's job fields are the NEW job (null when cleared).
export interface JobEvent extends WorkContext {
  id: string; // event id — published as msgID for JetStream dedup
  action: JobEventAction;
  workspaceId: string;
  siteId: string;
  stationId: string;
  stationName: string;
  previousJobId?: string;
  previousJobName?: string;
  changedAt: string;
  changedByEmployeeId?: string;
  source: JobEventSource;
  sourceType?: string;
  sourceRef?: string;
  /** Present when an automation caused this change. */
  cause?: EventCause;
  emittedAt: string;
}

export function deriveJobEventSubject(input: { siteId: string; stationId: string; action: JobEventAction }): string {
  const site = sanitizeSubjectToken(input.siteId);
  const station = sanitizeSubjectToken(input.stationId);
  const action = sanitizeSubjectToken(input.action);
  if (!site || !station || !action) {
    throw new Error("job event subject requires siteId, stationId, and action");
  }
  return `${JOB_EVENT_SUBJECT_PREFIX}.${site}.${station}.${action}`;
}

export function isJobEvent(value: unknown): value is JobEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const event = value as Partial<JobEvent>;
  return (
    typeof event.id === "string" &&
    event.action === "changed" &&
    typeof event.workspaceId === "string" &&
    typeof event.siteId === "string" &&
    typeof event.stationId === "string" &&
    typeof event.stationName === "string" &&
    isOptionalString(event.previousJobId) &&
    isOptionalString(event.previousJobName) &&
    typeof event.changedAt === "string" &&
    isOptionalString(event.changedByEmployeeId) &&
    (event.source === "MANUAL" || event.source === "SYSTEM") &&
    isOptionalString(event.sourceType) &&
    isOptionalString(event.sourceRef) &&
    isOptionalCause(event.cause) &&
    isOptionalWorkContext(event) &&
    typeof event.emittedAt === "string"
  );
}

export function parseJobEvent(value: unknown): JobEvent | null {
  return isJobEvent(value) ? value : null;
}
