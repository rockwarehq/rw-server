import type { KV } from "@nats-io/kv";

import { parseAggState, type AggState } from "./types.js";

// imm_agg_state bucket internal window aggregation state
// one entry per window property.
// Separate from cvg because state updates far more often than output
// Not exposed to WS clients.
export const AGG_BUCKET = "imm_agg_state";

const encoder = new TextEncoder();

export function aggKey(propertyId: string): string {
  return `agg.${propertyId}`;
}

export class AggStateStore {
  constructor(private readonly kv: KV) {}

  async get(propertyId: string): Promise<AggState | null> {
    const entry = await this.kv.get(aggKey(propertyId));
    if (!entry) return null;
    return parseAggStateText(entry.string());
  }

  async put(propertyId: string, state: AggState): Promise<void> {
    await this.kv.put(aggKey(propertyId), encoder.encode(JSON.stringify(state)));
  }
}

export function parseAggStateText(value: string): AggState | null {
  try {
    return parseAggState(JSON.parse(value));
  } catch {
    return null;
  }
}
