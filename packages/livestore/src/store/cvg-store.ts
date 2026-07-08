import type { KV } from "@nats-io/kv";

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
}

export function parseEnvelopeText(value: string): ValueEnvelope | null {
  try {
    return parseValueEnvelope(JSON.parse(value));
  } catch {
    return null;
  }
}
