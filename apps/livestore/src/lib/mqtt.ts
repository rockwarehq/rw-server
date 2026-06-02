import mqtt, { type MqttClient } from "mqtt";
import { livestreamSubjectPrefix, publishMqttIngestEvent } from "./jetstream.js";
import { putHealthSnapshot } from "./kv.js";
import type { HealthSnapshot, MqttIngestEvent, Quality, RockwareTopicMetadata, ValueEnvelope } from "./types.js";

let client: MqttClient | null = null;

export function isMqttReady(): boolean {
  return client?.connected === true;
}

export async function startMqttBridge(): Promise<void> {
  if (client) return;

  const brokerUrl = process.env.MQTT_BROKER_URL || "mqtt://127.0.0.1:1883";
  const topic = process.env.MQTT_TOPIC || "#";
  const username = process.env.MQTT_USERNAME || undefined;
  const password = process.env.MQTT_PASSWORD || undefined;

  const mqttClient = mqtt.connect(brokerUrl, {
    username,
    password,
  });

  mqttClient.on("message", (mqttTopic, raw) => {
    void handleMqttMessage(mqttTopic, raw).catch((err) => {
      console.error("[livestore] failed to process MQTT message:", err);
    });
  });

  mqttClient.on("error", (err: Error) => {
    console.error("[livestore] MQTT client error:", err);
  });

  mqttClient.on("close", () => {
    console.log("[livestore] MQTT connection closed");
  });

  mqttClient.on("offline", () => {
    console.warn("[livestore] MQTT client offline");
  });

  mqttClient.on("reconnect", () => {
    console.log("[livestore] MQTT reconnecting");
  });

  await new Promise<void>((resolve, reject) => {
    const onConnect = () => {
      console.log(`[livestore] connected to MQTT broker ${brokerUrl}`);
      mqttClient.subscribe(topic, (err) => {
        mqttClient.off("error", onError);

        if (err) {
          reject(err);
          return;
        }

        console.log(`[livestore] subscribed to MQTT topic ${topic}`);
        resolve();
      });
    };

    const onError = (err: Error) => {
      mqttClient.off("connect", onConnect);
      reject(err);
    };

    mqttClient.once("connect", onConnect);
    mqttClient.once("error", onError);
  });

  client = mqttClient;
}

export async function stopMqttBridge(): Promise<void> {
  const current = client;
  client = null;
  if (!current) return;

  await current.endAsync();
}

type RouteResult =
  | { kind: "points"; events: MqttIngestEvent[] }
  | { kind: "health"; key: string; snapshot: HealthSnapshot }
  | { kind: "unknown"; reason: string };

async function handleMqttMessage(topic: string, raw: Buffer): Promise<void> {
  const receivedAt = Date.now();
  const routed = routeMqttMessage(topic, raw, receivedAt);

  if (routed.kind === "points") {
    await Promise.all(routed.events.map((event) => publishMqttIngestEvent(event)));
    return;
  }

  if (routed.kind === "health") {
    await putHealthSnapshot(routed.key, routed.snapshot);
    return;
  }

  console.warn("[livestore] dropping unknown MQTT message", {
    topic,
    reason: routed.reason,
  });
}

function routeMqttMessage(topic: string, raw: Buffer, receivedAt: number): RouteResult {
  const metadata = parseTopicMetadata(topic);
  if (!metadata) {
    return { kind: "unknown", reason: "unknown_topic" };
  }

  const payload = parseJsonObject(raw);
  if (payload === undefined) {
    return { kind: "unknown", reason: "invalid_json" };
  }

  if (metadata.resource === "Health") {
    return {
      kind: "health",
      key: healthKvKey(metadata),
      snapshot: {
        source: "mqtt",
        topic,
        receivedAt,
        metadata,
        payload,
      },
    };
  }

  const points = payload.points;
  if (!Array.isArray(points)) {
    return { kind: "unknown", reason: "points_payload_missing_points" };
  }

  if (points.length === 0) {
    return { kind: "unknown", reason: "points_payload_empty" };
  }

  const events: MqttIngestEvent[] = [];
  points.forEach((point, index) => {
    if (!isRecord(point)) {
      console.warn("[livestore] dropping invalid point payload", {
        topic,
        pointIndex: index,
        reason: "point_payload_invalid",
      });
      return;
    }

    const event = buildPointIngestEvent({
      topic,
      metadata,
      payload,
      point,
      receivedAt,
      pointIndex: index,
    });

    if (!event) {
      console.warn("[livestore] dropping invalid point payload", {
        topic,
        pointIndex: index,
        reason: "point_payload_invalid",
      });
      return;
    }

    events.push(event);
  });

  if (events.length === 0) {
    return { kind: "unknown", reason: "point_payload_invalid" };
  }

  return { kind: "points", events };
}

function buildPointIngestEvent(args: {
  topic: string;
  metadata: RockwareTopicMetadata;
  payload: Record<string, unknown>;
  point: Record<string, unknown>;
  receivedAt: number;
  pointIndex: number;
}): MqttIngestEvent | null {
  const pointId = stringOrUndefined(args.point.id);
  const pointName = stringOrUndefined(args.point.name);
  if (!pointId && !pointName) {
    return null;
  }

  const pointToken = pointId ?? pointName ?? String(args.pointIndex);
  const subject = `${livestreamSubjectPrefix()}.rockware.${sanitizeSubjectToken(args.metadata.gatewayId)}.device.${sanitizeSubjectToken(args.metadata.deviceId ?? "unknown")}.point.${sanitizeSubjectToken(pointToken)}`;

  return {
    source: "mqtt",
    topic: args.topic,
    subject,
    receivedAt: args.receivedAt,
    envelope: pointToEnvelope(args),
  };
}

function pointToEnvelope(args: {
  topic: string;
  metadata: RockwareTopicMetadata;
  payload: Record<string, unknown>;
  point: Record<string, unknown>;
  receivedAt: number;
  pointIndex: number;
}): ValueEnvelope {
  const timestamp =
    numberOrUndefined(args.point.timestamp) ??
    numberOrUndefined(args.payload.deviceTxTimestamp) ??
    numberOrUndefined(args.payload.gatewayRxTimestamp) ??
    args.receivedAt;

  const context: Record<string, unknown> = {
    mqttTopic: args.topic,
    gatewayId: args.metadata.gatewayId,
    deviceId: args.metadata.deviceId,
    pointIndex: args.pointIndex,
    pointId: args.point.id,
    pointName: args.point.name,
    previousValue: args.point.previousValue,
    gatewayRxTimestamp: args.payload.gatewayRxTimestamp,
    gatewayTxTimestamp: args.payload.gatewayTxTimestamp,
    deviceTxTimestamp: args.payload.deviceTxTimestamp,
    rawPoint: args.point,
  };

  return {
    value: args.point.value,
    quality: normalizePointQuality(args.point.quality),
    timestamp,
    context,
  };
}

function parseJsonObject(raw: Buffer): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(raw.toString("utf8"));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function parseTopicMetadata(topic: string): RockwareTopicMetadata | null {
  const normalizedTopic = topic.replace(/\/+$/, "");
  const topicWithoutLeadingSlash = normalizedTopic.startsWith("/") ? normalizedTopic.slice(1) : normalizedTopic;
  const segments = topicWithoutLeadingSlash.split("/");

  if (segments.length < 5 || segments[0] !== "Rockware" || segments[2] !== "Gateway") {
    return null;
  }

  const version = parseVersion(segments[1]);
  const gatewayId = segments[3];
  if (!version || !gatewayId) {
    return null;
  }

  if (segments.length === 5 && segments[4] === "Health") {
    return {
      family: "rockware",
      version,
      gatewayId,
      resource: "Health",
      scope: "gateway",
    };
  }

  const resource = segments[6];
  const deviceId = segments[5];
  if (
    segments.length === 7 &&
    segments[4] === "Device" &&
    deviceId &&
    (resource === "Health" || resource === "Points")
  ) {
    return {
      family: "rockware",
      version,
      gatewayId,
      deviceId,
      resource,
      scope: "device",
    };
  }

  return null;
}

function parseVersion(value: string | undefined): string | null {
  if (!value) return null;

  const match = /^v(.+)$/.exec(value);
  return match?.[1] ?? null;
}

function healthKvKey(metadata: RockwareTopicMetadata): string {
  const gateway = sanitizeSubjectToken(metadata.gatewayId);
  if (metadata.scope === "gateway") {
    return `gateway.${gateway}`;
  }

  return `gateway.${gateway}.device.${sanitizeSubjectToken(metadata.deviceId ?? "unknown")}`;
}

function normalizePointQuality(value: unknown): Quality {
  if (value === "GOOD" || value === "good") return "good";
  if (value === "BAD" || value === "bad") return "bad";
  if (value === "STALE" || value === "stale") return "stale";
  if (value === "UNKNOWN" || value === "UNCERTAIN" || value === "unknown" || value === "uncertain") {
    return "uncertain";
  }

  return "uncertain";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function sanitizeSubjectToken(token: string): string {
  return token.trim().replaceAll(/[^A-Za-z0-9_-]/g, "_") || "unknown";
}
