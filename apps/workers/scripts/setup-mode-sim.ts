/**
 * Dev setup for the cycle-mode E2E sim: configures three stations (one per
 * CycleMode), creates jobs "discrete" / "QUANTITY_PER_CYCLE" /
 * "QUANTITY_PER_INTERVAL" with products, and assigns them via the real
 * changeJob path so StationJobLog snapshots the derived standards.
 *
 *   pnpm --filter @rw/workers exec tsx scripts/setup-mode-sim.ts
 */

import "dotenv/config";
import prisma, { createPrismaClient } from "@rw/db";
import { changeJob } from "@rw/services/facility/station/jobs";

createPrismaClient("api");

async function ensureProduct(siteId: string, sku: string, name: string): Promise<string> {
  const existing = await prisma.product.findFirst({
    where: { siteId, currentVersion: { sku } },
    select: { id: true },
  });
  if (existing) return existing.id;
  const product = await prisma.product.create({ data: { siteId } });
  const version = await prisma.productVersion.create({
    data: { productId: product.id, version: 1, sku, name },
  });
  await prisma.product.update({ where: { id: product.id }, data: { currentVersionId: version.id } });
  return product.id;
}

interface JobSpec {
  name: string;
  standardCycle: number | null;
  sku: string;
}

async function ensureJob(siteId: string, spec: JobSpec): Promise<string> {
  const existing = await prisma.job.findFirst({
    where: { siteId, deletedAt: null, currentVersion: { name: spec.name } },
    select: { id: true },
  });
  if (existing) return existing.id;

  const productId = await ensureProduct(siteId, spec.sku, `${spec.name} product`);
  const job = await prisma.job.create({ data: { siteId } });
  const version = await prisma.jobVersion.create({
    data: { jobId: job.id, version: 1, name: spec.name, standardCycle: spec.standardCycle },
  });
  await prisma.job.update({ where: { id: job.id }, data: { currentVersionId: version.id } });

  const jobProduct = await prisma.jobProduct.create({ data: { jobId: job.id, productId } });
  const jpVersion = await prisma.jobProductVersion.create({
    data: { jobProductId: jobProduct.id, version: 1, quantity: 1, isActive: true },
  });
  await prisma.jobProduct.update({ where: { id: jobProduct.id }, data: { currentVersionId: jpVersion.id } });
  return job.id;
}

async function main(): Promise<void> {
  console.log("[setup] loading site…");
  const site = await prisma.site.findFirst({ select: { id: true, name: true } });
  if (!site) throw new Error("no site found");

  const stations = await prisma.station.findMany({
    where: { siteId: site.id, deletedAt: null, currentVersionId: { not: null } },
    orderBy: { name: "asc" },
    take: 3,
    select: { id: true, name: true, currentVersionId: true },
  });
  console.log("[setup] stations:", stations.map((s) => s.name).join(", "));
  if (stations.length < 3) throw new Error(`need 3 stations, found ${stations.length}`);
  const [discreteStation, pulseStation, intervalStation] = stations;

  // Station configs (update the current version in place — dev only).
  await prisma.stationVersion.update({
    where: { id: discreteStation.currentVersionId as string },
    data: { cycleMode: "DISCRETE", slowDetect: 0.25 },
  });
  await prisma.stationVersion.update({
    where: { id: pulseStation.currentVersionId as string },
    data: {
      cycleMode: "QUANTITY_PER_CYCLE",
      standardQuantity: 100,
      quantityUnit: "ft",
      standardRate: 100,
      standardRateUnit: "ft",
      standardRatePeriod: "MINUTE",
      slowDetect: 0.25,
    },
  });
  await prisma.stationVersion.update({
    where: { id: intervalStation.currentVersionId as string },
    data: {
      cycleMode: "QUANTITY_PER_INTERVAL",
      standardCycle: 60,
      quantityUnit: "ea",
      standardRate: 10000,
      standardRateUnit: "ea",
      standardRatePeriod: "MINUTE",
      slowDetect: 0.25,
    },
  });

  console.log("[setup] station versions configured");
  const discreteJob = await ensureJob(site.id, { name: "discrete", standardCycle: 20, sku: "SIM-DISCRETE" });
  const pulseJob = await ensureJob(site.id, { name: "QUANTITY_PER_CYCLE", standardCycle: null, sku: "SIM-PULSE" });
  const intervalJob = await ensureJob(site.id, {
    name: "QUANTITY_PER_INTERVAL",
    standardCycle: null,
    sku: "SIM-INTERVAL",
  });

  for (const [station, jobId] of [
    [discreteStation, discreteJob],
    [pulseStation, pulseJob],
    [intervalStation, intervalJob],
  ] as const) {
    console.log(`[setup] changeJob ${station.name}…`);
    const result = await changeJob(station.id, jobId);
    if ("error" in result) throw new Error(`changeJob ${station.name}: ${result.error}`);
  }

  // Show what got snapshotted.
  const logs = await prisma.stationJobLog.findMany({
    where: { stationId: { in: stations.map((s) => s.id) }, endTime: null },
    select: {
      stationId: true,
      standardCycle: true,
      standardQuantity: true,
      quantityUnit: true,
      job: { select: { currentVersion: { select: { name: true } } } },
    },
  });
  const nameById = new Map(stations.map((s) => [s.id, s.name]));
  for (const log of logs) {
    console.log(
      `${nameById.get(log.stationId)}  job=${log.job.currentVersion?.name}  standardCycle=${log.standardCycle}  standardQuantity=${log.standardQuantity}  unit=${log.quantityUnit}`,
    );
  }
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("[setup-mode-sim] fatal", err);
  process.exit(1);
});
