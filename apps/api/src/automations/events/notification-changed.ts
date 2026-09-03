import { type ContextBuilder, type EventSchema, statelessContextBuilder } from "@rw/automations";
import type { NotificationEvent } from "@rw/runtime/notification-events";

/** `notification.changed` — a notification was delivered (or nothing got through). Fed by the `notifications.>` stream. */
export const schema: EventSchema = {
  type: "notification.changed",
  displayName: "Notification Sent",
  latest: "1",
  versions: {
    "1": {
      scopeKey: "notificationId",
      cooldownKey: "groupId",
      payload: {
        siteId: { type: "string", title: "Site", matchable: false },
        action: { type: "string", title: "What happened", enum: ["sent", "failed"] },
        notificationId: { type: "string", title: "Notification Id", matchable: false },
        groupId: { type: "string", title: "Group", ref: { source: "notificationGroups" } },
        groupName: { type: "string", title: "Group Name", matchable: false },
        subject: { type: "string", title: "Subject", matchable: false },
        source: { type: "string", title: "Triggered By", enum: ["MANUAL", "SYSTEM"], matchable: false },
        sourceType: { type: "string", title: "Trigger Type", matchable: false },
        sourceRef: { type: "string", title: "Source Ref", matchable: false },
        sent: { type: "number", title: "Sent Count" },
        failed: { type: "number", title: "Failed Count" },
        skipped: { type: "number", title: "Skipped Count" },
      },
    },
  },
};

export const contextBuilder: ContextBuilder = statelessContextBuilder;

export function fromNotificationEvent(e: NotificationEvent): Record<string, unknown> {
  return {
    siteId: e.siteId,
    action: e.action,
    notificationId: e.notificationId,
    groupId: e.groupId,
    groupName: e.groupName,
    subject: e.subject,
    source: e.source,
    sourceType: e.sourceType,
    sourceRef: e.sourceRef,
    sent: e.sent,
    failed: e.failed,
    skipped: e.skipped,
  };
}
