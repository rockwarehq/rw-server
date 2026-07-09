import { jetstream } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import { connect } from "@nats-io/transport-node";
import { CVG_BUCKET, CvgStore } from "@rw/livestore/store/cvg-store";
import type { ValueEnvelope } from "@rw/livestore/types/index";
import { moduleLogger } from "../logger.js";
import { natsServers } from "./util.js";

const log = moduleLogger("graph-values");

// Read-only access to livestore's current-value KV bucket for one-shot value
// introspection (graph.introspect.values / explain). Livestore remains the
// bucket's sole writer; this module never creates the bucket — if livestore
// has not provisioned it (or NATS_URL is unset), reads report unavailable.

const READ_CHUNK = 50;

let storePromise: Promise<CvgStore | null> | null = null;

async function openStore(): Promise<CvgStore | null> {
  const servers = process.env.NATS_URL;
  if (!servers) return null;
  try {
    const nc = await connect({
      servers: natsServers(servers),
      name: process.env.NATS_CLIENT_NAME || "rw-api-graph-values",
      maxReconnectAttempts: -1,
    });
    const kv = await new Kvm(jetstream(nc)).open(CVG_BUCKET);
    return new CvgStore(kv);
  } catch (err) {
    log.error({ err }, "could not open CVG bucket, value reads unavailable");
    return null;
  }
}

async function getStore(): Promise<CvgStore | null> {
  if (!storePromise) storePromise = openStore();
  const store = await storePromise;
  // A failed open is not cached — the bucket may simply not exist yet
  // (livestore provisions it on boot), so retry on the next read.
  if (!store) storePromise = null;
  return store;
}

export interface GraphValueReadResult {
  available: boolean;
  envelopes: Map<string, ValueEnvelope | null>;
}

export async function readGraphValues(propertyIds: readonly string[]): Promise<GraphValueReadResult> {
  const envelopes = new Map<string, ValueEnvelope | null>();
  const store = await getStore();
  if (!store) {
    for (const id of propertyIds) envelopes.set(id, null);
    return { available: false, envelopes };
  }

  for (let start = 0; start < propertyIds.length; start += READ_CHUNK) {
    const chunk = propertyIds.slice(start, start + READ_CHUNK);
    const results = await Promise.all(
      chunk.map(async (id) => {
        try {
          return await store.get(id);
        } catch {
          return null;
        }
      }),
    );
    chunk.forEach((id, index) => {
      envelopes.set(id, results[index] ?? null);
    });
  }
  return { available: true, envelopes };
}
