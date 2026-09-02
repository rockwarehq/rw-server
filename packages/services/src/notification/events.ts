import type { NotificationEvent } from "@rw/runtime/notification-events";
import { createEventSink, type EventSink } from "../events/sink.js";

const notificationEvents = createEventSink<NotificationEvent>("notification-events");

export type NotificationEventSink = EventSink<NotificationEvent>;
export const setNotificationEventSink = notificationEvents.set;
export const publishNotificationEvent = notificationEvents.publish;
