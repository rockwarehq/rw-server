// Notification outcome event contract — subject derivation, payload shape, and
// type guards shared by the publisher (apps/api) and any NATS consumers.
// Mirrors call-events; dependency-free by design.

import { type EventCause, isOptionalCause, isOptionalString, sanitizeSubjectToken } from "./domain-events.js";

export const NOTIFICATION_EVENT_STREAM = "RW_NOTIFICATION_EVENTS";
export const NOTIFICATION_EVENT_SUBJECT_PREFIX = "notifications";
export const NOTIFICATION_EVENT_SUBJECT_FILTER = `${NOTIFICATION_EVENT_SUBJECT_PREFIX}.>`;

/** `sent` = at least one delivery reached a provider; `failed` = none did. */
export type NotificationEventAction = "sent" | "failed";
export type NotificationEventSource = "MANUAL" | "SYSTEM";

export interface NotificationEvent {
  id: string; // event id — published as msgID for JetStream dedup
  action: NotificationEventAction;
  notificationId: string;
  /** Absent for a direct-to-people send. */
  groupId?: string;
  groupName?: string;
  workspaceId: string;
  siteId: string;
  subject: string;
  source: NotificationEventSource;
  sourceType?: string;
  sourceRef?: string;
  sent: number;
  failed: number;
  skipped: number;
  /** Present when an automation caused this notification. */
  cause?: EventCause;
  emittedAt: string;
}

export function deriveNotificationEventSubject(input: {
  siteId: string;
  notificationId: string;
  action: NotificationEventAction;
}): string {
  const site = sanitizeSubjectToken(input.siteId);
  const id = sanitizeSubjectToken(input.notificationId);
  const action = sanitizeSubjectToken(input.action);
  if (!site || !id || !action) {
    throw new Error("notification event subject requires siteId, notificationId, and action");
  }
  return `${NOTIFICATION_EVENT_SUBJECT_PREFIX}.${site}.${id}.${action}`;
}

export function isNotificationEvent(value: unknown): value is NotificationEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const event = value as Partial<NotificationEvent>;
  return (
    typeof event.id === "string" &&
    (event.action === "sent" || event.action === "failed") &&
    typeof event.notificationId === "string" &&
    isOptionalString(event.groupId) &&
    isOptionalString(event.groupName) &&
    typeof event.workspaceId === "string" &&
    typeof event.siteId === "string" &&
    typeof event.subject === "string" &&
    (event.source === "MANUAL" || event.source === "SYSTEM") &&
    isOptionalString(event.sourceType) &&
    isOptionalString(event.sourceRef) &&
    typeof event.sent === "number" &&
    typeof event.failed === "number" &&
    typeof event.skipped === "number" &&
    isOptionalCause(event.cause) &&
    typeof event.emittedAt === "string"
  );
}

export function parseNotificationEvent(value: unknown): NotificationEvent | null {
  return isNotificationEvent(value) ? value : null;
}
