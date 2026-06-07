import { connect, type KV, type NatsConnection } from "nats";

import { CVG_BUCKET } from "./cvg-store.js";

export interface NatsResources {
  nc: NatsConnection;
  kv: KV;
}

export async function connectNatsResources(): Promise<NatsResources> {
  const servers = (process.env.NATS_URL ?? "nats://localhost:4222")
    .split(",")
    .map((server) => server.trim())
    .filter(Boolean);

  const nc = await connect({ servers, name: "rw-livestore" });
  const js = nc.jetstream();
  const kv = await js.views.kv(CVG_BUCKET, { history: 5 });

  return { nc, kv };
}
