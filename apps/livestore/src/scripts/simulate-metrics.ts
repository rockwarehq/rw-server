import "dotenv/config";

import { createPrismaClient } from "@rw/db";

import { connectNatsResources, stopNatsResources } from "../nats.js";
import { deriveMetricSubject } from "@rw/runtime/graph-subjects";

// Mimics the metrics worker: ramps shift goodItems for a handful of stations and
// publishes each to metrics.<stationId>.SHIFT.goodItems. Livestore's metric mirror
// ingests them, they roll up to workcenter + site, and the playground UI updates
// live. Swap this for the real worker publishing the same subjects later.
const COUNT = Number.parseInt(process.env.SIM_STATIONS ?? "5", 10);
const INTERVAL_MS = Number.parseInt(process.env.SIM_INTERVAL_MS ?? "1000", 10);

async function main(): Promise<void> {
  const prisma = createPrismaClient("livestore");
  const nats = await connectNatsResources();
  const encoder = new TextEncoder();

  const workcenter = await prisma.workcenter.findFirst({ select: { id: true, name: true } });
  if (!workcenter) throw new Error("simulate-metrics: no workcenter found");
  const stations = await prisma.station.findMany({
    where: { workcenterId: workcenter.id, deletedAt: null, archivedAt: null },
    orderBy: { name: "asc" },
    take: COUNT,
    select: { id: true, name: true },
  });
  if (stations.length === 0) throw new Error("simulate-metrics: no stations under the workcenter");

  console.log(`simulating ${stations.length} stations under ${workcenter.name} (every ${INTERVAL_MS}ms):`);
  console.log(`  ${stations.map((s) => s.name).join(", ")}\n`);

  const totals = new Map(stations.map((s) => [s.id, 0]));
  const tick = () => {
    for (const station of stations) {
      const next = (totals.get(station.id) ?? 0) + 1 + Math.floor(Math.random() * 5);
      totals.set(station.id, next);
      const subject = deriveMetricSubject(station.id, "SHIFT", "goodItems");
      nats.nc.publish(subject, encoder.encode(JSON.stringify({ value: next, quality: "good", timestamp: Date.now() })));
    }
    const sum = [...totals.values()].reduce((a, b) => a + b, 0);
    process.stdout.write(`\rgoodItems  stations=[${stations.map((s) => totals.get(s.id)).join(", ")}]  sum=${sum}   `);
  };

  tick();
  const timer = setInterval(tick, INTERVAL_MS);

  const shutdown = async () => {
    clearInterval(timer);
    await stopNatsResources();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err) => {
  console.error("[livestore simulate-metrics] failed", err);
  process.exit(1);
});
