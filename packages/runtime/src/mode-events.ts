// Production mode event contract — subject derivation, payload shape, and type
// guards shared by the publisher (apps/api) and any NATS consumers. Mirrors
// call-events; dependency-free by design.

import {
  type EventCause,
  isOptionalCause,
  isOptionalString,
  isOptionalWorkContext,
  sanitizeSubjectToken,
  type WorkContext,
} from "./domain-events.js";

export const MODE_EVENT_STREAM = "RW_MODE_EVENTS";
export const MODE_EVENT_SUBJECT_PREFIX = "modes";
export const MODE_EVENT_SUBJECT_FILTER = `${MODE_EVENT_SUBJECT_PREFIX}.>`;

export type ModeEventAction = "forced" | "cleared";
export type ModeEventSource = "MANUAL" | "SYSTEM";

/// One event per StationModeLog transition. A switch emits `cleared` for the old mode then `forced` for the new.
export interface ModeEvent extends WorkContext {
  id: string; // event id — published as msgID for JetStream dedup
  action: ModeEventAction;
  logId: string;
  modeId: string;
  modeName: string;
  workspaceId: string;
  siteId: string;
  stationId: string;
  stationName: string;
  /** Who performed this action (the clear's actor on a `cleared` event, not the original forcer). */
  source: ModeEventSource;
  sourceType?: string;
  sourceRef?: string;
  startedAt: string;
  startedByEmployeeId?: string;
  endedAt?: string; // cleared events only
  endedByEmployeeId?: string;
  /** Present when an automation caused this change. */
  cause?: EventCause;
  emittedAt: string;
}

export function deriveModeEventSubject(input: { siteId: string; stationId: string; action: ModeEventAction }): string {
  const site = sanitizeSubjectToken(input.siteId);
  const station = sanitizeSubjectToken(input.stationId);
  const action = sanitizeSubjectToken(input.action);
  if (!site || !station || !action) {
    throw new Error("mode event subject requires siteId, stationId, and action");
  }
  return `${MODE_EVENT_SUBJECT_PREFIX}.${site}.${station}.${action}`;
}

export function isModeEvent(value: unknown): value is ModeEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const event = value as Partial<ModeEvent>;
  return (
    typeof event.id === "string" &&
    (event.action === "forced" || event.action === "cleared") &&
    typeof event.logId === "string" &&
    typeof event.modeId === "string" &&
    typeof event.modeName === "string" &&
    typeof event.workspaceId === "string" &&
    typeof event.siteId === "string" &&
    typeof event.stationId === "string" &&
    typeof event.stationName === "string" &&
    (event.source === "MANUAL" || event.source === "SYSTEM") &&
    isOptionalString(event.sourceType) &&
    isOptionalString(event.sourceRef) &&
    typeof event.startedAt === "string" &&
    isOptionalString(event.startedByEmployeeId) &&
    isOptionalString(event.endedAt) &&
    isOptionalString(event.endedByEmployeeId) &&
    isOptionalCause(event.cause) &&
    isOptionalWorkContext(event) &&
    typeof event.emittedAt === "string"
  );
}

export function parseModeEvent(value: unknown): ModeEvent | null {
  return isModeEvent(value) ? value : null;
}
