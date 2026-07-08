import {
  jetstream,
  jetstreamManager,
  StorageType,
  type JetStreamClient,
  type JetStreamManager,
} from "@nats-io/jetstream";
import { Kvm, type KV } from "@nats-io/kv";
import type { NatsConnection } from "@nats-io/nats-core";
import { connect } from "@nats-io/transport-node";

import { AGG_BUCKET } from "../value/agg-store.js";
import { CVG_BUCKET } from "../value/cvg-store.js";

export interface NatsResources {
  nc: NatsConnection;
  jetstream: JetStreamClient;
  jetstreamManager: JetStreamManager;
  kv: KV;
  aggKv: KV;
  isReady: () => boolean;
}

let resources: NatsResources | null = null;

// Hard byte ceilings on the KV buckets so unbounded key growth can't fill the
// NATS volume. These are safety backstops, NOT a TTL: KV holds last-write-wins
// current state, so we deliberately don't age values out (that would drop the
// current value of a slow-changing property). Overridable per-env.
const CVG_MAX_BYTES = Number(process.env.NATS_CVG_MAX_BYTES) || 128 * 1024 * 1024;
const AGG_MAX_BYTES = Number(process.env.NATS_AGG_MAX_BYTES) || 32 * 1024 * 1024;

export async function connectNatsResources(): Promise<NatsResources> {
  if (resources) return resources;

  const nc = await connect({
    servers: natsServers(),
    name: process.env.NATS_CLIENT_NAME || "rw-livestore",
    maxReconnectAttempts: -1,
    waitOnFirstConnect: true,
  });
  const js = jetstream(nc);
  const jsm = await jetstreamManager(nc);
  const kvm = new Kvm(js);
  const kv = await kvm.create(CVG_BUCKET, {
    history: 5,
    maxValueSize: 64 * 1024,
    max_bytes: CVG_MAX_BYTES,
    storage: StorageType.File,
  });
  // last-write-wins used for recovery.
  const aggKv = await kvm.create(AGG_BUCKET, {
    history: 1,
    maxValueSize: 16 * 1024,
    max_bytes: AGG_MAX_BYTES,
    storage: StorageType.File,
  });
  // kvm.create() no-ops when the bucket already exists, so apply tightened caps
  // to the underlying KV_<bucket> stream directly — otherwise a redeploy leaves
  // an old uncapped bucket unbounded.
  await reconcileKvMaxBytes(jsm, CVG_BUCKET, CVG_MAX_BYTES);
  await reconcileKvMaxBytes(jsm, AGG_BUCKET, AGG_MAX_BYTES);
  resources = {
    nc,
    jetstream: js,
    jetstreamManager: jsm,
    kv,
    aggKv,
    isReady: () => !nc.isClosed(),
  };

  console.log(`[livestore] connected to NATS at ${nc.getServer()}`);

  nc.closed().then((err) => {
    resources = null;
    if (err) {
      console.error("[livestore] NATS connection closed with error", err);
      return;
    }
    console.log("[livestore] NATS connection closed");
  });

  return resources;
}

// A KV bucket is backed by a `KV_<bucket>` JetStream stream; apply the byte cap
// there so it takes effect on already-existing buckets (kvm.create won't).
async function reconcileKvMaxBytes(
  jsm: JetStreamManager,
  bucket: string,
  maxBytes: number,
): Promise<void> {
  const stream = `KV_${bucket}`;
  try {
    const info = await jsm.streams.info(stream);
    if (info.config.max_bytes !== maxBytes) {
      await jsm.streams.update(stream, { max_bytes: maxBytes });
    }
  } catch (err) {
    // Freshly created buckets already carry the cap; a transient error here must
    // not block startup.
    console.warn(`[livestore] could not reconcile ${stream} max_bytes`, err);
  }
}

export async function stopNatsResources(): Promise<void> {
  const current = resources;
  resources = null;
  if (!current || current.nc.isClosed()) return;
  await current.nc.drain();
}

function natsServers(): string | string[] {
  const servers = (process.env.NATS_URL ?? "nats://localhost:4222")
    .split(",")
    .map((server) => server.trim())
    .filter(Boolean);

  if (servers.length === 0) return "nats://localhost:4222";
  if (servers.length === 1) return servers[0] ?? "nats://localhost:4222";
  return servers;
}
