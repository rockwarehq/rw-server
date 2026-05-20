// Quick health check: are MetricBucket rows updating and are Cycle rows
// flowing in? Reads through the workers' direct connection (avoids the
// pgbouncer pool budget while running this one-shot script).
//
// Usage: cd packages/db && DATABASE_URL=$(grep '^DATABASE_URL' ../../apps/workers/.env | cut -d= -f2-) pnpm exec tsx ../../scripts/check-activity.ts

import { createPrismaClient } from "@rw/db";

async function main() {
  const prisma = createPrismaClient("api");

  const since = new Date(Date.now() - 5 * 60_000); // last 5 min

  const [bucketCount, bucketSample, cycleCount, cycleSample, latestStations] = await Promise.all([
    prisma.metricBucket.count({ where: { lastUpdatedAt: { gte: since } } }),
    prisma.metricBucket.findMany({
      where: { lastUpdatedAt: { gte: since } },
      orderBy: { lastUpdatedAt: "desc" },
      take: 3,
      select: { id: true, stationId: true, runSeconds: true, downSeconds: true, lastUpdatedAt: true },
    }),
    prisma.cycle.count({ where: { startedAt: { gte: since } } }),
    prisma.cycle.findMany({
      where: { startedAt: { gte: since } },
      orderBy: { startedAt: "desc" },
      take: 3,
      select: { id: true, stationId: true, startedAt: true, completedAt: true, status: true },
    }),
    prisma.station.count(),
  ]);

  console.log("=== MetricBucket (updated in last 5 min) ===");
  console.log(`  count: ${bucketCount}`);
  for (const b of bucketSample) {
    console.log(
      `  ${b.id.slice(0, 8)}  station=${b.stationId.slice(0, 8)}  run=${b.runSeconds}s  down=${b.downSeconds}s  upd=${b.lastUpdatedAt.toISOString()}`,
    );
  }

  console.log("\n=== Cycle (started in last 5 min) ===");
  console.log(`  count: ${cycleCount}`);
  for (const c of cycleSample) {
    console.log(
      `  ${c.id.slice(0, 8)}  station=${c.stationId.slice(0, 8)}  status=${c.status}  start=${c.startedAt.toISOString()}  end=${c.completedAt?.toISOString() ?? "-"}`,
    );
  }

  console.log(`\nTotal stations in DB: ${latestStations}`);

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
