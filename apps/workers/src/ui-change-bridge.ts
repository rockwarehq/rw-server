// Carries ui.changes pings from this process to the api's subscribers. It is a
// process-wide concern, not one consumer's: every rebuild that runs here (job
// history, shift amendments) announces itself through publishUiChange.

import type { NatsConnection } from "@nats-io/nats-core";
import { connect } from "@nats-io/transport-node";
import { deriveUiChangeSubject } from "@rw/runtime/ui-change-events";
import { setUiChangeSink } from "@rw/services/events/ui-changes";

const encoder = new TextEncoder();
let nc: NatsConnection | null = null;

export async function startUiChangeBridge(): Promise<void> {
  nc = await connect({
    servers: (process.env.NATS_URL ?? "nats://localhost:4222").split(",").map((s) => s.trim()),
    name: "rw-workers-ui-changes",
    maxReconnectAttempts: -1,
    waitOnFirstConnect: true,
  });
  const conn = nc;
  setUiChangeSink(async (event) => {
    conn.publish(deriveUiChangeSubject(event.siteId), encoder.encode(JSON.stringify(event)));
  });
}

export async function stopUiChangeBridge(): Promise<void> {
  setUiChangeSink(null);
  if (nc && !nc.isClosed()) await nc.drain();
  nc = null;
}
