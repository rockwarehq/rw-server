import { Kvm, type KV } from "@nats-io/kv";
import { StorageType } from "@nats-io/jetstream";
import { getNatsClient } from "./nats.js";
import type { HealthSnapshot } from "./types.js";

const encoder = new TextEncoder();

let healthKv: KV | null = null;

export function healthKvBucketName(): string {
  return process.env.LIVESTORE_HEALTH_KV_BUCKET || "livestore_health";
}

export async function ensureHealthKvBucket(): Promise<void> {
  if (healthKv) return;

  const kvm = new Kvm(getNatsClient().jetstream);
  healthKv = await kvm.create(healthKvBucketName(), {
    history: 1,
    storage: StorageType.File,
  });

  console.log(`[livestore] ensured health KV bucket ${healthKvBucketName()}`);
}

export async function putHealthSnapshot(key: string, snapshot: HealthSnapshot): Promise<void> {
  const kv = healthKv;
  if (!kv) {
    throw new Error("Health KV bucket is not ready");
  }

  await kv.put(key, encoder.encode(JSON.stringify(snapshot)));
}
