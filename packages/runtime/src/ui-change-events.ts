// UI change feed — a "something you may be showing just changed" ping that livestore relays to
// browsers so screens refetch instead of polling. Ids only, never data: every handler refetches
// through the API, which keeps authorization and shaping in one place. Core NATS, no stream: a
// missed ping costs a stale screen until the next refetch, never wrong data.

import { sanitizeSubjectToken } from "./domain-events.js";

export const UI_CHANGE_SUBJECT_PREFIX = "ui.changes";
export const UI_CHANGE_SUBJECT_FILTER = `${UI_CHANGE_SUBJECT_PREFIX}.*`;

export type UiChangeKind = "job-history.rebuilt" | "downtime.recalculated" | "scrap.recorded";
const KINDS: readonly string[] = ["job-history.rebuilt", "downtime.recalculated", "scrap.recorded"];

export interface UiChangeEvent {
  id: string;
  kind: UiChangeKind;
  siteId: string;
  stationId?: string;
  /** job-history.rebuilt: which amendment, and how its metric rebuild ended. */
  amendmentId?: string;
  status?: "APPLIED" | "FAILED";
  emittedAt: string;
}

export function deriveUiChangeSubject(siteId: string): string {
  return `${UI_CHANGE_SUBJECT_PREFIX}.${sanitizeSubjectToken(siteId)}`;
}

export function isUiChangeEvent(value: unknown): value is UiChangeEvent {
  if (typeof value !== "object" || value === null) return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e.id === "string" &&
    typeof e.kind === "string" &&
    KINDS.includes(e.kind) &&
    typeof e.siteId === "string" &&
    typeof e.emittedAt === "string" &&
    (e.stationId === undefined || typeof e.stationId === "string") &&
    (e.amendmentId === undefined || typeof e.amendmentId === "string") &&
    (e.status === undefined || e.status === "APPLIED" || e.status === "FAILED")
  );
}

export function parseUiChangeEvent(raw: unknown): UiChangeEvent | null {
  return isUiChangeEvent(raw) ? raw : null;
}
