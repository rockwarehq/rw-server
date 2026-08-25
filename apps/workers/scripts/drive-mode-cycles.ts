/**
 * Dev gateway sim for the cycle-mode E2E: publishes imm.cycle_completed
 * events for the three mode stations at each mode's natural cadence.
 * - DISCRETE:              every 20 s, no quantity (parts from job products)
 * - QUANTITY_PER_CYCLE:    every 60 s, no quantity (100 ft pulse configured)
 * - QUANTITY_PER_INTERVAL: every 60 s, quantity ≈ 10,000 (measured count)
 *
 *   NATS_URL=nats://127.0.0.1:14222 pnpm --filter @rw/workers exec tsx scripts/drive-mode-cycles.ts
 */

import "dotenv/config";
import { randomUUID } from "node:crypto";
import { jetstream, jetstreamManager } from "@nats-io/jetstream";
import { connect } from "@nats-io/transport-node";
import prisma, { createPrismaClient } from "@rw/db";
import { deriveLivestoreEventSubject, livestoreEventType, type LivestoreHookEvent } from "@rw/livestore/catalog/events";
import { ensureLivestoreEventStream } from "@rw/livestore/catalog/event-stream";

createPrismaClient("api");

const NATS_URL = process.env.NATS_URL ?? "nats://127.0.0.1:14222";
const encoder = new TextEncoder();

interface Target {
  stationId: string;
  stationName: string;
  siteId: string;
  jobId: string;
  mode: string;
  intervalMs: number;
  quantity: (() => number) | null;
}

function buildEvent(target: Target): LivestoreHookEvent {
  const payload: Record<string, unknown> = { stationId: target.stationId, jobId: target.jobId };
  if (target.quantity) payload.quantity = target.quantity();
  return {
    id: randomUUID(),
    namespace: "imm",
    name: "cycle_completed",
    type: livestoreEventType("imm", "cycle_completed"),
    version: "1",
    siteId: target.siteId,
    hookId: "dev-mode-sim",
    hookName: "dev mode sim",
    propertyId: "",
    emittedAt: new Date().toISOString(),
    previous: null,
    current: null,
    payload,
    context: {},
  };
}

async function main(): Promise<void> {
  const stations = await prisma.station.findMany({
    where: {
      deletedAt: null,
      currentJobId: { not: null },
      currentVersion: { cycleMode: { in: ["DISCRETE", "QUANTITY_PER_CYCLE", "QUANTITY_PER_INTERVAL"] } },
      currentJob: { currentVersion: { name: { in: ["discrete", "QUANTITY_PER_CYCLE", "QUANTITY_PER_INTERVAL"] } } },
    },
    select: {
      id: true,
      name: true,
      siteId: true,
      currentJobId: true,
      currentVersion: { select: { cycleMode: true } },
    },
    orderBy: { name: "asc" },
  });

  const targets: Target[] = stations.map((s) => {
    const mode = s.currentVersion?.cycleMode ?? "DISCRETE";
    return {
      stationId: s.id,
      stationName: s.name,
      siteId: s.siteId,
      jobId: s.currentJobId as string,
      mode,
      intervalMs: mode === "DISCRETE" ? 20_000 : 60_000,
      // Rivets: measured count near the 10,000/min standard with jitter,
      // plus the occasional slow tick to exercise quantity-based SLOW.
      quantity:
        mode === "QUANTITY_PER_INTERVAL" ? () => (Math.random() < 0.15 ? 6_500 : 9_600 + Math.random() * 800) : null,
    };
  });
  if (targets.length !== 3) {
    console.error(`[drive-mode-cycles] expected 3 mode stations, found ${targets.length} — run setup-mode-sim first`);
    process.exit(1);
  }

  const nc = await connect({ servers: NATS_URL, name: "rw-drive-mode-cycles", waitOnFirstConnect: true });
  const jsm = await jetstreamManager(nc);
  const js = jetstream(nc);
  await ensureLivestoreEventStream(jsm);
  console.log(`[drive-mode-cycles] connected to ${nc.getServer()}`);

  let count = 0;
  const publish = async (target: Target) => {
    const event = buildEvent(target);
    const subject = deriveLivestoreEventSubject(target.siteId, "imm", "cycle_completed", "1");
    await js.publish(subject, encoder.encode(JSON.stringify(event)), { msgID: event.id });
    count += 1;
    const qty = (event.payload as Record<string, unknown>).quantity;
    console.log(
      `[drive-mode-cycles] ${target.stationName} (${target.mode})${qty != null ? ` qty=${(qty as number).toFixed(0)}` : ""} — total ${count}`,
    );
  };

  const handles = targets.map((t) => {
    void publish(t).catch((err) => console.error("publish error", err));
    return setInterval(() => void publish(t).catch((err) => console.error("publish error", err)), t.intervalMs);
  });

  const shutdown = async () => {
    for (const h of handles) clearInterval(h);
    await nc.drain();
    await prisma.$disconnect();
    console.log(`[drive-mode-cycles] stopped after ${count} events`);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err) => {
  console.error("[drive-mode-cycles] fatal", err);
  process.exit(1);
});
