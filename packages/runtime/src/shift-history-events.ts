// Shift amendment event contract — a correction to a shift that already ran
// (ADR-0015). `amended` is published after the instance rows and stamps are
// rewritten and drives the metric rebuild; `rebuilt` is published when that
// rebuild ends. Mirrors job-history-events; dependency-free by design.

import { sanitizeSubjectToken } from "./domain-events.js";

export const SHIFT_HISTORY_EVENT_STREAM = "RW_SHIFT_HISTORY_EVENTS";
export const SHIFT_HISTORY_EVENT_SUBJECT_PREFIX = "shift-history";
export const SHIFT_HISTORY_EVENT_SUBJECT_FILTER = `${SHIFT_HISTORY_EVENT_SUBJECT_PREFIX}.>`;

export type ShiftHistoryEventAction = "amended" | "rebuilt";

export interface ShiftHistoryEvent {
  id: string; // event id — published as msgID for JetStream dedup
  action: ShiftHistoryEventAction;
  workspaceId: string;
  siteId: string;
  /** null = the site-level schedule. */
  workCenterId: string | null;
  amendmentId: string;
  businessDate: string;
  shiftName: string;
  /** Union of the old and new windows. */
  windowStart: string;
  windowEnd: string;
  /** rebuilt only. */
  status?: "APPLIED" | "FAILED";
  emittedAt: string;
}

export function deriveShiftHistoryEventSubject(input: {
  siteId: string;
  workCenterId: string | null;
  action: ShiftHistoryEventAction;
}): string {
  const site = sanitizeSubjectToken(input.siteId);
  const scope = sanitizeSubjectToken(input.workCenterId ?? "site");
  if (!site || !scope) throw new Error("shift history event subject requires siteId");
  return `${SHIFT_HISTORY_EVENT_SUBJECT_PREFIX}.${site}.${scope}.${input.action}`;
}

export function parseShiftHistoryEvent(value: unknown): ShiftHistoryEvent | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const e = value as Partial<ShiftHistoryEvent>;
  const ok =
    typeof e.id === "string" &&
    (e.action === "amended" || e.action === "rebuilt") &&
    typeof e.workspaceId === "string" &&
    typeof e.siteId === "string" &&
    (e.workCenterId === null || typeof e.workCenterId === "string") &&
    typeof e.amendmentId === "string" &&
    typeof e.businessDate === "string" &&
    typeof e.shiftName === "string" &&
    typeof e.windowStart === "string" &&
    typeof e.windowEnd === "string" &&
    typeof e.emittedAt === "string";
  return ok ? (value as ShiftHistoryEvent) : null;
}
