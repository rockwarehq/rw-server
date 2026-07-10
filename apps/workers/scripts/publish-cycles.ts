/**
 * Dev cycle publisher — emits imm.cycle_completed livestore events to NATS,
 * standing in for the gateway/hook path. The imm-events worker consumes these
 * and records cycles; the rollups worker then computes SHIFT buckets and
 * bridges them to livestore.
 *
 *   pnpm --filter @rw/workers publish:cycles
 *   PUBLISH_CYCLE_INTERVAL_MS=2000 pnpm --filter @rw/workers publish:cycles
 *   PUBLISH_CYCLE_STATION_ID=<uuid> pnpm --filter @rw/workers publish:cycles
 */

import "dotenv/config";
import { randomUUID } from "node:crypto";

import {
  DiscardPolicy,
  jetstream,
  jetstreamManager,
  RetentionPolicy,
  StorageType,
} from "@nats-io/jetstream";
import { connect } from "@nats-io/transport-node";
import prisma, { createPrismaClient } from "@rw/db";
import {
  deriveLivestoreEventSubject,
  LIVESTORE_EVENT_STREAM,
  LIVESTORE_EVENT_SUBJECT_FILTER,
  livestoreEventType,
  type LivestoreHookEvent,
} from "@rw/livestore/catalog/events";

createPrismaClient("api");

const INTERVAL_MS = Number.parseInt(process.env.PUBLISH_CYCLE_INTERVAL_MS ?? "", 10) || 1000;
const STATION_ID = process.env.PUBLISH_CYCLE_STATION_ID || null;
const WORKCENTER_ID = process.env.PUBLISH_CYCLE_WORKCENTER_ID || null;
const LIMIT = Number.parseInt(process.env.PUBLISH_CYCLE_LIMIT ?? "", 10) || 10;
const NATS_URL = process.env.NATS_URL ?? "nats://127.0.0.1:4222";
const encoder = new TextEncoder();

interface Target {
  stationId: string;
  siteId: string;
  jobId: string;
}

// Pick a station with a current job (or the requested one); fall back to any
// station plus any job in its site so a fresh DB still produces cycles.
async function pickTarget(): Promise<Target | null> {
  const where = STATION_ID ? { id: STATION_ID } : { currentJobId: { not: null }, deletedAt: null };
  const station =
    (await prisma.station.findFirst({ where, select: { id: true, siteId: true, currentJobId: true } })) ??
    (await prisma.station.findFirst({ select: { id: true, siteId: true, currentJobId: true } }));
  if (!station) return null;

  let jobId = station.currentJobId;
  if (!jobId) {
    const job = await prisma.job.findFirst({
      where: { siteId: station.siteId, deletedAt: null, currentVersionId: { not: null } },
      select: { id: true },
    });
    jobId = job?.id ?? null;
  }
  if (!jobId) return null;
  return { stationId: station.id, siteId: station.siteId, jobId };
}

// All stations under a workcenter (with a current job), else a single target.
async function resolveTargets(): Promise<Target[]> {
  if (WORKCENTER_ID) {
    const stations = await prisma.station.findMany({
      where: { workcenterId: WORKCENTER_ID, deletedAt: null, currentJobId: { not: null } },
      orderBy: { name: "asc" },
      take: LIMIT,
      select: { id: true, siteId: true, currentJobId: true },
    });
    return stations.map((s) => ({ stationId: s.id, siteId: s.siteId, jobId: s.currentJobId as string }));
  }
  const target = await pickTarget();
  return target ? [target] : [];
}

function buildEvent(target: Target): LivestoreHookEvent {
  const id = randomUUID();
  return {
    id,
    namespace: "imm",
    name: "cycle_completed",
    type: livestoreEventType("imm", "cycle_completed"),
    version: "1",
    siteId: target.siteId,
    hookId: "dev-publish-cycles",
    hookName: "dev publish-cycles",
    propertyId: "",
    emittedAt: new Date().toISOString(),
    previous: null,
    current: null,
    payload: { stationId: target.stationId, jobId: target.jobId, cycleTime: 10 + Math.random() * 5 },
    context: {},
  };
}

async function main(): Promise<void> {
  const nc = await connect({ servers: NATS_URL, name: "rw-publish-cycles", waitOnFirstConnect: true });
  const jsm = await jetstreamManager(nc);
  const js = jetstream(nc);

  // Ensure the stream exists (idempotent with the livestore hook-manager).
  try {
    const info = await jsm.streams.info(LIVESTORE_EVENT_STREAM);
    const subjects = new Set(info.config.subjects ?? []);
    if (!subjects.has(LIVESTORE_EVENT_SUBJECT_FILTER)) {
      await jsm.streams.update(LIVESTORE_EVENT_STREAM, { subjects: [...subjects, LIVESTORE_EVENT_SUBJECT_FILTER] });
    }
  } catch {
    await jsm.streams.add({
      name: LIVESTORE_EVENT_STREAM,
      subjects: [LIVESTORE_EVENT_SUBJECT_FILTER],
      retention: RetentionPolicy.Limits,
      storage: StorageType.File,
      discard: DiscardPolicy.Old,
      max_msgs: 100_000,
    });
  }

  const targets = await resolveTargets();
  if (targets.length === 0) {
    console.log("[publish-cycles] no station+job found; create a station with a current job first.");
    await nc.drain();
    return;
  }
  console.log(`[publish-cycles] connected to ${nc.getServer()} — ${targets.length} station(s), every ${INTERVAL_MS}ms`);
  let count = 0;

  // One cycle per target per tick.
  const tick = async () => {
    for (const target of targets) {
      const event = buildEvent(target);
      const subject = deriveLivestoreEventSubject(target.siteId, "imm", "cycle_completed", "1");
      await js.publish(subject, encoder.encode(JSON.stringify(event)), { msgID: event.id });
      count += 1;
    }
    console.log(`[publish-cycles] tick: ${targets.length} cycles (total ${count})`);
  };

  const handle = setInterval(() => void tick().catch((err) => console.error("[publish-cycles] tick error", err)), INTERVAL_MS);

  const shutdown = async () => {
    clearInterval(handle);
    await nc.drain();
    await prisma.$disconnect();
    console.log(`[publish-cycles] stopped after ${count} cycles`);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err) => {
  console.error("[publish-cycles] fatal", err);
  process.exit(1);
});
