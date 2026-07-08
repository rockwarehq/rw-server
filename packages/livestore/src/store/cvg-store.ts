import type { KV, KvWatchEntry } from "@nats-io/kv";
import type { QueuedIterator } from "@nats-io/nats-core";

import { parseValueEnvelope, type ValueEnvelope } from "../types/index.js";

export const CVG_BUCKET = "cvg";

const encoder = new TextEncoder();

export function propertyKey(propertyId: string): string {
  return `prop.${propertyId}`;
}

export class CvgStore {
  constructor(private readonly kv: KV) {}

  async get(propertyId: string): Promise<ValueEnvelope | null> {
    const entry = await this.kv.get(propertyKey(propertyId));
    if (!entry) return null;
    return parseEnvelopeText(entry.string());
  }

  async put(propertyId: string, envelope: ValueEnvelope): Promise<void> {
    await this.kv.put(propertyKey(propertyId), encoder.encode(JSON.stringify(envelope)));
  }

  async watch(propertyId: string): Promise<QueuedIterator<KvWatchEntry>> {
    return this.kv.watch({ key: propertyKey(propertyId) });
  }
}

export function parseEnvelopeText(value: string): ValueEnvelope | null {
  try {
    return parseValueEnvelope(JSON.parse(value));
  } catch {
    return null;
  }
}
