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

import { CVG_BUCKET } from "./cvg-store.js";

export interface NatsResources {
  nc: NatsConnection;
  jetstream: JetStreamClient;
  jetstreamManager: JetStreamManager;
  kv: KV;
  isReady: () => boolean;
}

let resources: NatsResources | null = null;

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
    storage: StorageType.File,
  });
  resources = {
    nc,
    jetstream: js,
    jetstreamManager: jsm,
    kv,
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
