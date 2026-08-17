import "dotenv/config";

import { createPrismaClient } from "@rw/db";
import { deriveTagSubject } from "@rw/runtime/graph-subjects";
import { connect } from "@nats-io/transport-node";

import type { Quality, ValueEnvelope } from "@rw/livestore";

interface Options {
  dryRun: boolean;
  includeDraft: boolean;
  intervalMs: number;
  count: number | null;
  datasourceIds: string[];
  pointIds: string[];
  siteId?: string;
  gatewayId?: string;
  quality: Quality;
}

interface DatasourceRow {
  id: string;
  name: string;
  status: string;
  site: { id: string; name: string } | null;
  gateway: { id: string; name: string } | null;
  points: PointRow[];
}

interface PointRow {
  id: string;
  name: string;
  dataType: string;
  scaleFactor: number;
  offset: number;
}

interface TagTarget {
  datasource: DatasourceRow;
  point: PointRow;
  subject: string;
}

interface SampleValue {
  value: unknown;
  raw?: unknown;
}

const encoder = new TextEncoder();
const QUALITY_VALUES = new Set<Quality>(["good", "stale", "uncertain", "bad"]);

async function main(): Promise<void> {
  const options = parseOptions();
  const prisma = createPrismaClient("livestore");

  const datasources = await loadDatasources(prisma, options);
  const targets = buildTargets(datasources);
  if (targets.length === 0) {
    await prisma.$disconnect();
    throw new Error("simulate-tags: no datasource points matched the current filters");
  }

  const missingGraphTags = await findMissingGraphTags(prisma, targets);
  printSummary(options, datasources, targets, missingGraphTags);

  if (options.dryRun) {
    await prisma.$disconnect();
    return;
  }

  const nc = await connect({ servers: natsServers(), name: "rw-livestore-tag-simulator" });
  let tickCount = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopping = false;

  const shutdown = async (code = 0) => {
    if (stopping) return;
    stopping = true;
    if (timer) clearInterval(timer);
    await nc.drain();
    await prisma.$disconnect();
    process.stdout.write("\n");
    process.exit(code);
  };

  const tick = () => {
    tickCount += 1;
    const timestamp = Date.now();
    const preview: string[] = [];
    for (let index = 0; index < targets.length; index += 1) {
      const target = targets[index];
      if (!target) continue;
      const envelope = buildEnvelope(target.point, index, tickCount, timestamp, options.quality);
      nc.publish(target.subject, encoder.encode(JSON.stringify(envelope)));
      if (preview.length < 4) preview.push(`${target.point.name}=${String(envelope.value)}`);
    }

    process.stdout.write(
      `\rtick=${tickCount} tags=${targets.length} quality=${options.quality} ${preview.join(" ")}   `,
    );
  };

  tick();
  if (isComplete(tickCount, options.count)) {
    await shutdown(0);
    return;
  }

  timer = setInterval(() => {
    tick();
    if (isComplete(tickCount, options.count)) void shutdown(0);
  }, options.intervalMs);
  process.on("SIGINT", () => void shutdown(0));
  process.on("SIGTERM", () => void shutdown(0));
}

function isComplete(tickCount: number, count: number | null): boolean {
  return count !== null && tickCount >= count;
}

async function loadDatasources(
  prisma: ReturnType<typeof createPrismaClient>,
  options: Options,
): Promise<DatasourceRow[]> {
  const where: Record<string, unknown> = { siteId: options.siteId ?? { not: null } };
  if (!options.includeDraft) where.status = "ACTIVE";
  if (options.datasourceIds.length > 0) where.id = { in: options.datasourceIds };
  if (options.gatewayId) where.gatewayId = options.gatewayId;

  const pointFilter = options.pointIds.length > 0 ? { id: { in: options.pointIds } } : undefined;

  return prisma.datasource.findMany({
    where,
    orderBy: { name: "asc" },
    select: {
      id: true,
      name: true,
      status: true,
      site: { select: { id: true, name: true } },
      gateway: { select: { id: true, name: true } },
      points: {
        ...(pointFilter ? { where: pointFilter } : {}),
        orderBy: { name: "asc" },
        select: {
          id: true,
          name: true,
          dataType: true,
          scaleFactor: true,
          offset: true,
        },
      },
    },
  });
}

function buildTargets(datasources: DatasourceRow[]): TagTarget[] {
  return datasources.flatMap((datasource) =>
    datasource.points.map((point) => ({
      datasource,
      point,
      subject: deriveTagSubject(datasource.id, point.id),
    })),
  );
}

async function findMissingGraphTags(
  prisma: ReturnType<typeof createPrismaClient>,
  targets: TagTarget[],
): Promise<TagTarget[]> {
  const properties = await prisma.graphProperty.findMany({
    where: { resolverType: "tag", isDeleted: false },
    select: { resolver: true },
  });
  const graphTags = new Set<string>();
  for (const property of properties) {
    const key = resolverKey(property.resolver);
    if (key) graphTags.add(key);
  }

  return targets.filter((target) => !graphTags.has(tagKey(target.datasource.id, target.point.id)));
}

function printSummary(
  options: Options,
  datasources: DatasourceRow[],
  targets: TagTarget[],
  missingGraphTags: TagTarget[],
): void {
  console.log(
    `simulating ${targets.length} tags from ${datasources.length} datasource(s) ` +
      `(${options.includeDraft ? "including drafts" : "active only"})` +
      publishModeLabel(options),
  );
  for (const target of targets.slice(0, 12)) {
    const site = target.datasource.site?.name ?? "no site";
    const gateway = target.datasource.gateway?.name ?? "no gateway";
    console.log(`  ${site} / ${target.datasource.name} (${gateway}) / ${target.point.name} -> ${target.subject}`);
  }
  if (targets.length > 12) console.log(`  ... ${targets.length - 12} more tag(s)`);

  if (missingGraphTags.length > 0) {
    console.warn(`warning: ${missingGraphTags.length} matched tag(s) do not have active graph tag properties yet`);
    console.warn("create graph tag properties in the UI, then restart LiveStore if it was already running");
    console.warn('resolver shape: { type: "tag", deviceId: datasource.id, tagPath: point.id }');
    for (const target of missingGraphTags.slice(0, 5)) {
      console.warn(`  missing graph tag: ${target.datasource.name} / ${target.point.name}`);
    }
    if (missingGraphTags.length > 5) console.warn(`  ... ${missingGraphTags.length - 5} more missing tag(s)`);
  } else {
    console.log("graph tag properties found for all matched tags");
    console.log("restart LiveStore if these devices were added after the current LiveStore process started");
  }
}

function publishModeLabel(options: Options): string {
  if (options.dryRun) return " (dry run)";
  if (options.count === 1) return " once";
  return ` every ${options.intervalMs}ms`;
}

function buildEnvelope(
  point: PointRow,
  pointIndex: number,
  tick: number,
  timestamp: number,
  quality: Quality,
): ValueEnvelope {
  const sample = sampleValue(point, pointIndex, tick);
  return {
    value: sample.value,
    quality,
    timestamp,
    ...(sample.raw !== undefined ? { context: { valueRaw: sample.raw } } : {}),
  };
}

function sampleValue(point: PointRow, pointIndex: number, tick: number): SampleValue {
  const dataType = point.dataType.toLowerCase();
  const seed = hashString(`${point.id}:${point.name}:${point.dataType}`);

  if (isBooleanType(dataType)) {
    const value = (tick + pointIndex + seed) % 2 === 0;
    return { value, raw: value };
  }

  if (isStringType(dataType)) {
    return { value: `${point.name}-${tick}` };
  }

  const base = 10 + (seed % 90);
  const step = 1 + (seed % 7);
  const wave = Math.sin((tick + pointIndex) / 4) * (1 + (seed % 5));
  const raw = isIntegerType(dataType) ? Math.round(base + tick * step + wave) : round(base + tick * step + wave, 3);
  return { value: round(raw * point.scaleFactor + point.offset, 3), raw };
}

function isBooleanType(dataType: string): boolean {
  return dataType.includes("bool") || dataType === "bit" || dataType.includes("coil") || dataType.includes("discrete");
}

function isStringType(dataType: string): boolean {
  return dataType.includes("string") || dataType.includes("text") || dataType.includes("char");
}

function isIntegerType(dataType: string): boolean {
  return (
    dataType.includes("int") || dataType.includes("word") || dataType.includes("dword") || dataType.includes("counter")
  );
}

function hashString(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash;
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function resolverKey(value: unknown): string | null {
  if (!isRecord(value)) return null;
  if (value.type !== "tag") return null;
  if (typeof value.deviceId !== "string" || typeof value.tagPath !== "string") return null;
  return tagKey(value.deviceId, value.tagPath);
}

function tagKey(deviceId: string, tagPath: string): string {
  return `${deviceId}\u0000${tagPath}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseOptions(): Options {
  const intervalMs = parsePositiveInt(readArg("--interval-ms") ?? process.env.SIM_TAG_INTERVAL_MS, 1000);
  const explicitCount = readArg("--count") ?? process.env.SIM_TAG_COUNT;
  const count = hasFlag("--once") ? 1 : explicitCount === undefined ? null : parsePositiveInt(explicitCount, 1);
  const activeOnly = hasFlag("--active-only");
  return {
    dryRun: hasFlag("--dry-run") || hasFlag("--list"),
    includeDraft: !activeOnly && (hasFlag("--include-draft") || parseBoolean(process.env.SIM_TAG_INCLUDE_DRAFT, true)),
    intervalMs,
    count,
    datasourceIds: parseCsv(
      readArg("--datasource-ids") ?? readArg("--datasource-id") ?? process.env.SIM_TAG_DATASOURCE_IDS,
    ),
    pointIds: parseCsv(readArg("--point-ids") ?? readArg("--point-id") ?? process.env.SIM_TAG_POINT_IDS),
    siteId: readArg("--site-id") ?? process.env.SIM_TAG_SITE_ID,
    gatewayId: readArg("--gateway-id") ?? process.env.SIM_TAG_GATEWAY_ID,
    quality: parseQuality(readArg("--quality") ?? process.env.SIM_TAG_QUALITY),
  };
}

function readArg(name: string): string | undefined {
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === name) {
      const next = args[index + 1];
      return next && !next.startsWith("--") ? next : undefined;
    }
    const prefix = `${name}=`;
    if (arg?.startsWith(prefix)) return arg.slice(prefix.length);
  }
  return undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.slice(2).includes(name);
}

function parseCsv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return fallback;
}

function parseBoolean(value: string | undefined, fallback = false): boolean {
  if (!value) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function parseQuality(value: string | undefined): Quality {
  if (!value) return "good";
  const normalized = value.toLowerCase() === "unknown" ? "uncertain" : value.toLowerCase();
  if (QUALITY_VALUES.has(normalized as Quality)) return normalized as Quality;
  throw new Error(`SIM_TAG_QUALITY/--quality must be one of: ${[...QUALITY_VALUES].join(", ")}`);
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

main().catch((err) => {
  console.error("[livestore simulate-tags] failed", err);
  process.exit(1);
});
