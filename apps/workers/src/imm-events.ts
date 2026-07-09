// Consumes IMM livestore hook events and applies them to Postgres.
// imm.cycle_completed -> records a production cycle. Needs DATABASE_URL
// (pooled), REDIS_URL, NATS_URL.

import { jetstream, jetstreamManager } from "@nats-io/jetstream";
import type { NatsConnection } from "@nats-io/nats-core";
import { connect } from "@nats-io/transport-node";
import prisma from "@rw/db";
import { complete as completeCycle } from "@rw/services/cycle/index";
import { livestoreEventType, type LivestoreHookEvent } from "@rw/livestore/catalog/events";

import { ImmEventConsumer, type ImmEventHandlers } from "./imm-event-consumer.js";
import { installEntityEventSink, uninstallEntityEventSink } from "./entity-event-publisher.js";

let nc: NatsConnection | null = null;
let consumer: ImmEventConsumer | null = null;

const handlers: ImmEventHandlers = {
  [livestoreEventType("imm", "cycle_completed")]: handleCycleCompleted,
};

export async function startImmEvents(): Promise<void> {
  nc = await connect({
    servers: natsServers(),
    name: process.env.NATS_CLIENT_NAME || "rw-workers-imm-events",
    maxReconnectAttempts: -1,
    waitOnFirstConnect: true,
  });
  const js = jetstream(nc);
  const jsm = await jetstreamManager(nc);
  await installEntityEventSink(js, jsm);
  consumer = new ImmEventConsumer(js, jsm, handlers);
  await consumer.start();
  console.log(`[imm-events] connected to NATS at ${nc.getServer()}`);

  nc.closed().then((err) => {
    if (err) console.error("[imm-events] NATS connection closed with error", err);
  });
}

export async function stopImmEvents(): Promise<void> {
  uninstallEntityEventSink();
  consumer?.stop();
  consumer = null;
  if (nc && !nc.isClosed()) await nc.drain();
  nc = null;
}

async function handleCycleCompleted(event: LivestoreHookEvent): Promise<void> {
  if (alreadyHandled(event.id)) {
    console.warn(`[imm-events] cycle_completed ${event.id} already handled; skipping redelivery`);
    return;
  }

  const stationId = stringField(event.payload, "stationId");
  if (!stationId) {
    console.warn(`[imm-events] cycle_completed ${event.id} missing stationId; skipping`);
    markHandled(event.id);
    return;
  }

  // event jobId if present, else the station's current job
  const jobId = stringField(event.payload, "jobId") ?? (await currentJobId(stationId));
  if (!jobId) {
    console.warn(`[imm-events] cycle_completed ${event.id}: station ${stationId} has no current job; skipping`);
    markHandled(event.id);
    return;
  }

  const result = await completeCycle({ stationId, timestamp: parseEmittedAt(event.emittedAt), jobId });
  if ("error" in result) {
    console.error(`[imm-events] cycle.record failed for station ${stationId}: ${result.error} (${result.code})`);
    markHandled(event.id); // validation failure — don't retry a bad event
    return;
  }

  markHandled(event.id);
  console.log(`[imm-events] recorded cycle ${result.data.id} station=${stationId} job=${jobId} hook=${event.hookId}`);
}

// complete() is not idempotent — dedup nak redeliveries within this process.
// (A restart between commit and ack can still redeliver; durable dedup is a follow-up.)
const handled = new Set<string>();
const HANDLED_MAX = 10_000;

function alreadyHandled(eventId: string): boolean {
  return handled.has(eventId);
}

function markHandled(eventId: string): void {
  handled.add(eventId);
  if (handled.size > HANDLED_MAX) {
    const oldest = handled.values().next().value;
    if (oldest !== undefined) handled.delete(oldest);
  }
}

function stringField(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

async function currentJobId(stationId: string): Promise<string | null> {
  const rows = await prisma.$queryRaw<Array<{ currentJobId: string | null }>>`
    SELECT "currentJobId" FROM "Station" WHERE id = ${stationId}::uuid
  `;
  return rows[0]?.currentJobId ?? null;
}

function parseEmittedAt(value: string): Date {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function natsServers(): string | string[] {
  const servers = (process.env.NATS_URL ?? "nats://localhost:4222")
    .split(",")
    .map((server) => server.trim())
    .filter(Boolean);
  if (servers.length <= 1) return servers[0] ?? "nats://localhost:4222";
  return servers;
}
