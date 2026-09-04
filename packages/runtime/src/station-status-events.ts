// Station status event contract — subject derivation, payload shape, and type guards shared by
// the publisher (apps/api) and any NATS consumers. Mirrors mode-events; dependency-free by design.

import {
  type EventCause,
  isOptionalCause,
  isOptionalString,
  isOptionalWorkContext,
  sanitizeSubjectToken,
  type WorkContext,
} from "./domain-events.js";

export const STATION_EVENT_STREAM = "RW_STATION_EVENTS";
export const STATION_EVENT_SUBJECT_PREFIX = "stations";
export const STATION_STATUS_SUBJECT_FILTER = `${STATION_EVENT_SUBJECT_PREFIX}.*.*.status`;

export type StationState = "UP" | "DOWN";
export type StationStatus = "FAST" | "SLOW" | "UP" | "DOWN";
export type StationStatusEventSource = "MANUAL" | "SYSTEM";

const STATES: readonly string[] = ["UP", "DOWN"];
const STATUSES: readonly string[] = ["FAST", "SLOW", "UP", "DOWN"];

/// One event per change of the open state-log row's status or reason. Job and mode splits keep
/// both and emit nothing. `statusSince` is when the station entered its current status.
export interface StationStatusEvent extends WorkContext {
  id: string; // event id — published as msgID for JetStream dedup
  workspaceId: string;
  siteId: string;
  stationId: string;
  stationName: string;
  state: StationState;
  status: StationStatus;
  previousStatus?: StationStatus;
  statusReasonId?: string;
  statusReason?: string;
  previousStatusReasonId?: string;
  /** ISO time the current status run began, across reason/job/mode splits. */
  statusSince: string;
  source: StationStatusEventSource;
  sourceType?: string;
  sourceRef?: string;
  /** Present when an automation caused this change. */
  cause?: EventCause;
  emittedAt: string;
}

export function deriveStationStatusSubject(input: { siteId: string; stationId: string }): string {
  const site = sanitizeSubjectToken(input.siteId);
  const station = sanitizeSubjectToken(input.stationId);
  if (!site || !station) throw new Error("station status subject requires siteId and stationId");
  return `${STATION_EVENT_SUBJECT_PREFIX}.${site}.${station}.status`;
}

export function isStationStatusEvent(value: unknown): value is StationStatusEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const event = value as Partial<StationStatusEvent>;
  return (
    typeof event.id === "string" &&
    typeof event.workspaceId === "string" &&
    typeof event.siteId === "string" &&
    typeof event.stationId === "string" &&
    typeof event.stationName === "string" &&
    STATES.includes(event.state as string) &&
    STATUSES.includes(event.status as string) &&
    (event.previousStatus === undefined || STATUSES.includes(event.previousStatus)) &&
    isOptionalString(event.statusReasonId) &&
    isOptionalString(event.statusReason) &&
    isOptionalString(event.previousStatusReasonId) &&
    typeof event.statusSince === "string" &&
    (event.source === "MANUAL" || event.source === "SYSTEM") &&
    isOptionalString(event.sourceType) &&
    isOptionalString(event.sourceRef) &&
    isOptionalCause(event.cause) &&
    isOptionalWorkContext(event) &&
    typeof event.emittedAt === "string"
  );
}

export function parseStationStatusEvent(value: unknown): StationStatusEvent | null {
  return isStationStatusEvent(value) ? value : null;
}
