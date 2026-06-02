export type Quality = "good" | "stale" | "uncertain" | "bad";

export interface ValueEnvelope {
  value: unknown;
  quality: Quality;
  timestamp: number;
  context?: Record<string, unknown>;
}

export interface MqttIngestEvent {
  source: "mqtt";
  topic: string;
  subject: string;
  receivedAt: number;
  envelope: ValueEnvelope;
}

export interface RockwareTopicMetadata {
  family: "rockware";
  version: string;
  gatewayId: string;
  deviceId?: string;
  resource: "Health" | "Points";
  scope: "gateway" | "device";
}

export interface HealthSnapshot {
  source: "mqtt";
  topic: string;
  receivedAt: number;
  metadata: RockwareTopicMetadata;
  payload: Record<string, unknown>;
}
