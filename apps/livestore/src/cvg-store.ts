import { StringCodec, type KV } from "nats";

import { parseValueEnvelope, type ValueEnvelope } from "./types.js";

export const CVG_BUCKET = "cvg";

const codec = StringCodec();

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
    await this.kv.put(propertyKey(propertyId), codec.encode(JSON.stringify(envelope)));
  }

  async watch(propertyId: string) {
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
