/**
 * Dev tag publisher — emits a monotonically increasing counter to a tag
 * subject, driving an "increases" cycle hook (the gateway/PLC stand-in).
 *
 *   SEED_DEVICE_ID=sim-press-01 SEED_TAG_PATH=cycleComplete \
 *     PUBLISH_COUNTER_INTERVAL_MS=2000 pnpm --filter @rw/workers publish:counter
 */

import "dotenv/config";

import { connect } from "@nats-io/transport-node";
import { deriveTagSubject } from "@rw/runtime/graph-subjects";

const NATS_URL = process.env.NATS_URL ?? "nats://127.0.0.1:4222";
const DEVICE_ID = process.env.SEED_DEVICE_ID ?? "sim-press-01";
const TAG_PATH = process.env.SEED_TAG_PATH ?? "cycleComplete";
const INTERVAL_MS = Number.parseInt(process.env.PUBLISH_COUNTER_INTERVAL_MS ?? "", 10) || 2000;
const START = Number.parseInt(process.env.PUBLISH_COUNTER_START ?? "", 10) || 0;
const encoder = new TextEncoder();

async function main(): Promise<void> {
  const nc = await connect({ servers: NATS_URL, name: "rw-publish-counter", waitOnFirstConnect: true });
  const subject = deriveTagSubject(DEVICE_ID, TAG_PATH);
  console.log(`[publish-counter] -> ${subject} every ${INTERVAL_MS}ms`);

  let counter = START;
  const handle = setInterval(() => {
    counter += 1;
    const envelope = { value: counter, quality: "good", timestamp: Date.now() };
    nc.publish(subject, encoder.encode(JSON.stringify(envelope)));
    console.log(`[publish-counter] ${subject} = ${counter}`);
  }, INTERVAL_MS);

  const shutdown = async () => {
    clearInterval(handle);
    await nc.drain();
    console.log(`[publish-counter] stopped at ${counter}`);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err) => {
  console.error("[publish-counter] fatal", err);
  process.exit(1);
});
