// Call lifecycle event contract — subject derivation, payload shape, and type
// guards shared by the publisher (apps/api) and any NATS consumers. This module
// is dependency-free by design; the NATS connection lives in the apps.

import { type EventCause, isOptionalCause, isOptionalString, sanitizeSubjectToken } from "./domain-events.js";

export const CALL_EVENT_STREAM = "RW_CALL_EVENTS";
export const CALL_EVENT_SUBJECT_PREFIX = "calls";
export const CALL_EVENT_SUBJECT_FILTER = `${CALL_EVENT_SUBJECT_PREFIX}.>`;

export type CallEventAction = "opened" | "closed";
export type CallEventSeverity = "INFORMATION" | "ALERT" | "WARNING";
export type CallEventSource = "MANUAL" | "SYSTEM";

/// Carries enough for a notification consumer to react without a DB read.
export interface CallEvent {
  id: string; // event id — published as msgID for JetStream dedup
  action: CallEventAction;
  callId: string;
  definitionId: string;
  definitionName: string;
  severity: CallEventSeverity;
  workspaceId: string;
  siteId: string;
  stationId: string;
  stationName: string;
  source: CallEventSource;
  sourceType?: string;
  sourceRef?: string;
  message?: string;
  openedAt: string;
  openedByEmployeeId?: string;
  closedAt?: string; // closed events only
  closedByEmployeeId?: string;
  closeMessage?: string;
  /** Present when an automation caused this change. */
  cause?: EventCause;
  emittedAt: string;
}

export function deriveCallEventSubject(input: { siteId: string; callId: string; action: CallEventAction }): string {
  const site = sanitizeSubjectToken(input.siteId);
  const callId = sanitizeSubjectToken(input.callId);
  const action = sanitizeSubjectToken(input.action);
  if (!site || !callId || !action) {
    throw new Error("call event subject requires siteId, callId, and action");
  }
  return `${CALL_EVENT_SUBJECT_PREFIX}.${site}.${callId}.${action}`;
}

export function isCallEvent(value: unknown): value is CallEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const event = value as Partial<CallEvent>;
  return (
    typeof event.id === "string" &&
    (event.action === "opened" || event.action === "closed") &&
    typeof event.callId === "string" &&
    typeof event.definitionId === "string" &&
    typeof event.definitionName === "string" &&
    (event.severity === "INFORMATION" || event.severity === "ALERT" || event.severity === "WARNING") &&
    typeof event.workspaceId === "string" &&
    typeof event.siteId === "string" &&
    typeof event.stationId === "string" &&
    typeof event.stationName === "string" &&
    (event.source === "MANUAL" || event.source === "SYSTEM") &&
    isOptionalString(event.sourceType) &&
    isOptionalString(event.sourceRef) &&
    isOptionalString(event.message) &&
    typeof event.openedAt === "string" &&
    isOptionalString(event.openedByEmployeeId) &&
    isOptionalString(event.closedAt) &&
    isOptionalString(event.closedByEmployeeId) &&
    isOptionalString(event.closeMessage) &&
    isOptionalCause(event.cause) &&
    typeof event.emittedAt === "string"
  );
}

export function parseCallEvent(value: unknown): CallEvent | null {
  return isCallEvent(value) ? value : null;
}
