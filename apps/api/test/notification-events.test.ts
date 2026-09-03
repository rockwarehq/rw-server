import { deriveNotificationEventSubject, isNotificationEvent, parseNotificationEvent } from "@rw/runtime/notification-events";
import { describe, expect, it } from "vitest";

const baseEvent = {
  id: "e1",
  action: "sent",
  notificationId: "n1",
  groupId: "g1",
  groupName: "Maintenance",
  workspaceId: "w1",
  siteId: "s1",
  subject: "Press 4 down",
  source: "SYSTEM",
  sent: 2,
  failed: 0,
  skipped: 1,
  emittedAt: "2026-09-02T00:00:00.000Z",
};

describe("notification event contract", () => {
  it("derives subjects and sanitizes wildcard-hostile tokens", () => {
    expect(deriveNotificationEventSubject({ siteId: "site-1", notificationId: "n-1", action: "sent" })).toBe(
      "notifications.site-1.n-1.sent",
    );
    expect(deriveNotificationEventSubject({ siteId: "a b", notificationId: "x*y", action: "failed" })).toBe(
      "notifications.a_b.x_y.failed",
    );
    expect(() => deriveNotificationEventSubject({ siteId: "", notificationId: "n", action: "sent" })).toThrow();
  });

  it("accepts well-formed events, including a cause", () => {
    expect(isNotificationEvent(baseEvent)).toBe(true);
    expect(
      isNotificationEvent({
        ...baseEvent,
        action: "failed",
        sourceType: "automation",
        sourceRef: "auto-1",
        cause: { correlationId: "root", causationId: "parent", hop: 2 },
      }),
    ).toBe(true);
  });

  it("rejects malformed events", () => {
    expect(isNotificationEvent(null)).toBe(false);
    expect(isNotificationEvent({ ...baseEvent, action: "queued" })).toBe(false);
    expect(isNotificationEvent({ ...baseEvent, sent: "2" })).toBe(false);
    expect(parseNotificationEvent({ ...baseEvent, notificationId: undefined })).toBeNull();
    expect(parseNotificationEvent(baseEvent)).toEqual(baseEvent);
  });
});
