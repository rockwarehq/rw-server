// Cross-process event bus — lifted from rw-server/src/rpc/events-bus.ts.
//
// - apps/api runs `subscriber` mode: subscribes to Redis and feeds events into
//   the local EventPublisher for oRPC clients.
// - apps/workers runs `publisher` mode: publishStreamEvent sends to Redis.

import { EventPublisher } from "@orpc/server";
import { Redis } from "ioredis";

export interface PointValueEventPayload {
  pointId: string;
  valueRaw: unknown;
  previousValueRaw?: unknown;
  quality: "GOOD" | "BAD" | "UNKNOWN";
  value?: number;
  previousValue?: number;
  timestamp: string;
  gatewayTimestamp: string;
  replayed: boolean;
}

export interface PointValueEvent {
  id: string;
  type: "PointValue";
  gatewayId: string;
  workspaceId: string | null;
  receivedAt: string;
  payload: PointValueEventPayload;
}

export interface StationEventTriggeredPayload {
  stationId: string;
  eventId: string;
  executionId: string;
  triggeredAt: string;
}

export interface StationEventTriggeredEvent {
  id: string;
  type: "StationEventTriggered";
  workspaceId: string | null;
  receivedAt: string;
  payload: StationEventTriggeredPayload;
}

export interface StationEventExecutionActionResult {
  actionId: string;
  event: string;
  eventDisplayName?: string;
  status: "success" | "failed" | "skipped";
}

export interface StationEventExecutionPayload {
  executionId: string;
  stationId: string;
  eventId: string;
  status: "success" | "failed";
  triggeredAt: string;
  trigger?: {
    tagName?: string;
    deviceName?: string;
    previousValue?: number | string | boolean;
    actualValue?: number | string | boolean;
  };
  actionResults: StationEventExecutionActionResult[];
  error?: {
    code: string;
    message: string;
  } | null;
}

export interface StationEventExecutionEvent {
  id: string;
  type: "StationEventExecution";
  workspaceId: string | null;
  receivedAt: string;
  payload: StationEventExecutionPayload;
}

export type StreamEvent = PointValueEvent | StationEventTriggeredEvent | StationEventExecutionEvent;

interface EventMap {
  event: StreamEvent;
}

const STREAM_EVENTS_CHANNEL = "stream-events";

const eventPublisher = new EventPublisher<EventMap>({
  maxBufferedEvents: 100,
});

let publishFn: (event: StreamEvent) => void = (event) => {
  eventPublisher.publish("event", event);
};

export function publishStreamEvent(event: StreamEvent): void {
  publishFn(event);
}

export function subscribeStreamEvents(options?: { signal?: AbortSignal }): AsyncIterable<StreamEvent> {
  return eventPublisher.subscribe("event", options);
}

export async function initEventsBridge(mode: "publisher" | "subscriber"): Promise<() => Promise<void>> {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    console.log("[events-bus] REDIS_URL not set, skipping bridge");
    return async () => {};
  }

  if (mode === "publisher") {
    const pub = new Redis(redisUrl);
    publishFn = (event) => {
      pub.publish(STREAM_EVENTS_CHANNEL, JSON.stringify(event)).catch((err: unknown) => {
        console.error("[events-bus] Failed to publish to Redis:", err);
      });
    };
    console.log("[events-bus] Publishing stream events via Redis");
    return async () => {
      pub.disconnect();
    };
  }

  const sub = new Redis(redisUrl);
  sub.subscribe(STREAM_EVENTS_CHANNEL).catch((err: unknown) => {
    console.error("[events-bus] Failed to subscribe:", err);
  });
  sub.on("message", (_channel: string, message: string) => {
    try {
      const event = JSON.parse(message) as StreamEvent;
      eventPublisher.publish("event", event);
    } catch (err) {
      console.error("[events-bus] Failed to parse event from Redis:", err);
    }
  });
  console.log("[events-bus] Subscribing to stream events via Redis");
  return async () => {
    sub.disconnect();
  };
}
