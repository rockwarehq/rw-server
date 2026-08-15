/**
 * Load-test seeder — idempotently provisions N simulated IMM stations with the
 * full supporting domain graph, so a single number scales the whole footprint:
 *
 *   per station i (1..N):
 *     - Station "STN-%04d" + StationVersion (standardCycle 20s)
 *     - Job "JOB-%04d" + JobVersion (standardCycle 20s) set as currentJob
 *     - Tool "TOOL-%04d" (1 cavity) linked via JobTool
 *     - Product "PART-%04d" + JobProduct (qty 1), materials round-robined
 *     - Datasource "SIM-STN-%04d" (driver: simulation, ACTIVE) on the gateway
 *       with PointGroup "Cycle" (1000ms) + Point "Cycle Complete"
 *       (address "cycle-20s" — builtin sim sequence, one rising edge / 20s)
 *     - StationDatasource join
 *     - GraphNode "STN-%04d" (@imm/station, fields materialized)
 *       + "Cycle Complete" tag property (tags.<datasourceId>.<pointId>)
 *       + GraphHook (operator: increases) emitting imm.cycle_completed
 *         with stationId (+ jobId) bound from node properties
 *   shared:
 *     - ProcessType "Injection Molding", Workcenter "Load Test"
 *     - 5 Materials (RESIN-01..05) + ProductMaterial links
 *     - ShiftPattern "Load Test 24/7" (3x8h daily) + assignment + instances
 *     - Gateway.specVersion bump so the edge gateway picks up new datasources
 *
 * Re-running is additive only: existing rows are matched by natural keys
 * (Station.siteId+name, GraphNode.siteId+name, version-row names for
 * Job/Product/Material/Tool) and never removed. Raise --stations to grow.
 *
 *   DATABASE_URL=... pnpm --filter @rw/workers seed:loadtest -- --stations 100
 *   env: SEED_SITE_NAME (default "Rockware"), SEED_GATEWAY_ID (required if
 *        more than one gateway exists), SEED_TELEMETRY=1 (extra sim points)
 */

import "dotenv/config";
import { parseArgs } from "node:util";

import prisma, { createPrismaClient } from "@rw/db";

createPrismaClient("api");

import * as hooks from "@rw/livestore/graph/hooks";
import * as nodes from "@rw/livestore/graph/nodes";
import * as properties from "@rw/livestore/graph/properties";
import { bumpSpecVersion } from "@rw/services/device/gateway/spec";
import { reconcileShiftInstances } from "@rw/services/facility/shift/materialize";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const { values: args } = parseArgs({
  // pnpm forwards a literal "--" — drop it so option parsing continues past it
  args: process.argv.slice(2).filter((a) => a !== "--"),
  options: {
    stations: { type: "string", short: "n", default: process.env.SEED_STATIONS ?? "10" },
    telemetry: { type: "boolean", default: process.env.SEED_TELEMETRY === "1" },
  },
  allowPositionals: true,
});

const STATION_COUNT = Number.parseInt(args.stations ?? "10", 10);
if (!Number.isInteger(STATION_COUNT) || STATION_COUNT < 1 || STATION_COUNT > 10_000) {
  console.error(`--stations must be an integer 1..10000 (got "${args.stations}")`);
  process.exit(1);
}

const SITE_NAME = process.env.SEED_SITE_NAME ?? "Rockware";
const WORKSPACE_SLUG = process.env.SEED_WORKSPACE_SLUG ?? "default";
const GATEWAY_ID = process.env.SEED_GATEWAY_ID;
// Stations are grouped into workcenters of SEED_WC_SIZE (default 50). Station i
// belongs to workcenter ceil(i / size). Re-running MOVES existing stations to
// their computed workcenter (the one intentional non-additive behavior).
const WORKCENTER_SIZE = Number.parseInt(process.env.SEED_WC_SIZE ?? "50", 10);
const PROCESS_TYPE_NAME = "Injection Molding";
const MATERIAL_COUNT = 5;
const STANDARD_CYCLE_SECONDS = 20;
const CYCLE_ADDRESS = "cycle-20s"; // builtin sim sequence: 0 for 10s, 1 for 10s

const pad = (n: number) => String(n).padStart(4, "0");
const stationName = (i: number) => `STN-${pad(i)}`;
const wcGroup = (i: number) => Math.ceil(i / WORKCENTER_SIZE);
const wcName = (g: number) => `Load Test WC-${String(g).padStart(2, "0")}`;

interface ServiceResult {
  data?: unknown;
  error?: string;
  code?: string;
}

function unwrap(label: string, result: ServiceResult): Record<string, unknown> {
  if (result && typeof result === "object" && "error" in result && result.error) {
    throw new Error(`${label} failed: ${result.code} ${result.error}`);
  }
  return ((result.data ?? result) as Record<string, unknown>) ?? {};
}

const counts = { created: 0, existing: 0, moved: 0 };
function mark(created: boolean, label: string) {
  if (created) {
    counts.created++;
    console.log(`  + ${label}`);
  } else {
    counts.existing++;
  }
}

// ---------------------------------------------------------------------------
// Shared scaffolding
// ---------------------------------------------------------------------------

async function resolveScope() {
  const workspace = await prisma.workspace.findFirst({
    where: { OR: [{ slug: WORKSPACE_SLUG }, { isDefault: true }] },
  });
  if (!workspace) throw new Error(`Workspace "${WORKSPACE_SLUG}" not found — run db:seed first`);

  const site = await prisma.site.findFirst({
    where: { workspaceId: workspace.id, name: SITE_NAME },
  });
  if (!site) throw new Error(`Site "${SITE_NAME}" not found in workspace "${workspace.name}"`);

  return { workspaceId: workspace.id, siteId: site.id };
}

async function resolveGateway(siteId: string) {
  if (GATEWAY_ID) {
    const gw = await prisma.gateway.findUnique({ where: { id: GATEWAY_ID } });
    if (!gw) throw new Error(`Gateway ${GATEWAY_ID} not found`);
    return gw;
  }
  const gateways = await prisma.gateway.findMany();
  if (gateways.length === 1) return gateways[0];
  if (gateways.length > 1) {
    console.error("Multiple gateways found — set SEED_GATEWAY_ID to one of:");
    for (const g of gateways) console.error(`  ${g.id}  ${g.name} (${g.serialNumber}) status=${g.status}`);
    process.exit(1);
  }
  // No gateway (fresh/local DB) — create a placeholder so datasources have a home.
  const gw = await prisma.gateway.create({
    data: { name: "Load Test Sim Gateway", serialNumber: "SIM-LOADTEST", siteId },
  });
  console.log(`  + Gateway "SIM-LOADTEST" ${gw.id} (no gateway existed — claim or replace as needed)`);
  return gw;
}

async function ensureProcessType(siteId: string) {
  const existing = await prisma.processType.findFirst({ where: { siteId, name: PROCESS_TYPE_NAME } });
  if (existing) return existing.id;
  const created = await prisma.processType.create({ data: { siteId, name: PROCESS_TYPE_NAME } });
  mark(true, `ProcessType ${PROCESS_TYPE_NAME}`);
  return created.id;
}

async function ensureWorkcenter(siteId: string, processTypeId: string, name: string) {
  const existing = await prisma.workcenter.findFirst({
    where: { siteId, parentId: null, name },
  });
  if (existing) return existing.id;
  const created = await prisma.workcenter.create({
    data: { siteId, name, processTypeId },
  });
  mark(true, `Workcenter ${name}`);
  return created.id;
}

async function ensureMaterials(siteId: string) {
  const ids: { materialId: string; materialVersionId: string }[] = [];
  for (let i = 1; i <= MATERIAL_COUNT; i++) {
    const materialNumber = `RESIN-${String(i).padStart(2, "0")}`;
    const existing = await prisma.material.findFirst({
      where: { siteId, deletedAt: null, currentVersion: { materialNumber } },
      include: { currentVersion: true },
    });
    if (existing?.currentVersionId) {
      ids.push({ materialId: existing.id, materialVersionId: existing.currentVersionId });
      continue;
    }
    const material = await prisma.material.create({ data: { siteId } });
    const version = await prisma.materialVersion.create({
      data: {
        version: 1,
        materialNumber,
        name: `Load Test Resin ${i}`,
        weightUnits: "KG",
        materialId: material.id,
      },
    });
    await prisma.material.update({ where: { id: material.id }, data: { currentVersionId: version.id } });
    mark(true, `Material ${materialNumber}`);
    ids.push({ materialId: material.id, materialVersionId: version.id });
  }
  return ids;
}

async function ensureShifts(siteId: string) {
  const PATTERN_NAME = "Load Test 24/7";
  let pattern = await prisma.shiftPattern.findFirst({ where: { siteId, name: PATTERN_NAME } });
  if (!pattern) {
    pattern = await prisma.shiftPattern.create({
      data: { siteId, name: PATTERN_NAME, totalDaysInRotation: 1, useEndDateForBusinessDate: false },
    });
    mark(true, `ShiftPattern ${PATTERN_NAME}`);
  }

  const shifts = [
    { sortOrder: 1, shiftName: "First", startTime: "00:00" },
    { sortOrder: 2, shiftName: "Second", startTime: "08:00" },
    { sortOrder: 3, shiftName: "Third", startTime: "16:00" },
  ];
  for (const s of shifts) {
    const existingDef = await prisma.shiftDefinition.findFirst({
      where: { patternId: pattern.id, dayOfRotation: 1, sortOrder: s.sortOrder },
    });
    if (!existingDef) {
      await prisma.shiftDefinition.create({
        data: {
          patternId: pattern.id,
          dayOfRotation: 1,
          sortOrder: s.sortOrder,
          startDayOffset: 0,
          startTime: s.startTime,
          durationHrs: 8,
          shiftName: s.shiftName,
        },
      });
      mark(true, `ShiftDefinition ${s.shiftName}`);
    }
  }

  let assignment = await prisma.shiftAssignment.findFirst({ where: { patternId: pattern.id } });
  if (!assignment) {
    const start = new Date();
    start.setUTCHours(0, 0, 0, 0);
    assignment = await prisma.shiftAssignment.create({
      data: { patternId: pattern.id, siteId, rotationStartDate: start },
    });
    mark(true, `ShiftAssignment (from ${assignment.rotationStartDate.toISOString().slice(0, 10)})`);
  }

  try {
    const result = await reconcileShiftInstances(assignment.id);
    console.log(`  shift instances reconciled: ${JSON.stringify(result)}`);
  } catch (err) {
    console.warn(`  ! reconcileShiftInstances failed (instances will materialize via worker): ${err}`);
  }
}

// ---------------------------------------------------------------------------
// Per-station scaffolding
// ---------------------------------------------------------------------------

async function ensureProduct(siteId: string, i: number, material: { materialId: string; materialVersionId: string }) {
  const sku = `PART-${pad(i)}`;
  let productId: string;
  let productVersionId: string;

  const existing = await prisma.product.findFirst({
    where: { siteId, deletedAt: null, currentVersion: { sku } },
  });
  if (existing?.currentVersionId) {
    productId = existing.id;
    productVersionId = existing.currentVersionId;
  } else {
    const product = await prisma.product.create({ data: { siteId } });
    const version = await prisma.productVersion.create({
      data: {
        version: 1,
        sku,
        name: `Load Test Part ${pad(i)}`,
        weight: 0.05,
        weightUnits: "KG",
        productId: product.id,
      },
    });
    await prisma.product.update({ where: { id: product.id }, data: { currentVersionId: version.id } });
    mark(true, `Product ${sku}`);
    productId = product.id;
    productVersionId = version.id;
  }

  // Material link (upsert on productId+materialId)
  const pm = await prisma.productMaterial.upsert({
    where: { productId_materialId: { productId, materialId: material.materialId } },
    update: {},
    create: { productId, materialId: material.materialId },
  });
  if (!pm.currentVersionId) {
    const pmv = await prisma.productMaterialVersion.create({
      data: {
        version: 1,
        weight: 0.05,
        weightUnits: "KG",
        productMaterialId: pm.id,
        materialVersionId: material.materialVersionId,
        productVersionId,
      },
    });
    await prisma.productMaterial.update({ where: { id: pm.id }, data: { currentVersionId: pmv.id } });
  }

  return { productId, productVersionId };
}

async function ensureTool(siteId: string, i: number) {
  const name = `TOOL-${pad(i)}`;
  const existing = await prisma.tool.findFirst({
    where: { siteId, deletedAt: null, currentVersion: { name } },
  });
  if (existing) {
    const cavity = await prisma.toolCavity.findFirst({ where: { toolId: existing.id, deletedAt: null } });
    return { toolId: existing.id, toolCavityId: cavity?.id ?? null };
  }
  const tool = await prisma.tool.create({ data: { siteId } });
  const version = await prisma.toolVersion.create({
    data: { version: 1, name, cavityCount: 1, toolId: tool.id },
  });
  await prisma.tool.update({ where: { id: tool.id }, data: { currentVersionId: version.id } });
  const cavity = await prisma.toolCavity.create({ data: { toolId: tool.id } });
  const cavityVersion = await prisma.toolCavityVersion.create({
    data: { version: 1, name: "1", position: 1, toolCavityId: cavity.id },
  });
  await prisma.toolCavity.update({ where: { id: cavity.id }, data: { currentVersionId: cavityVersion.id } });
  mark(true, `Tool ${name}`);
  return { toolId: tool.id, toolCavityId: cavity.id };
}

async function ensureJob(
  siteId: string,
  processTypeId: string,
  i: number,
  product: { productId: string; productVersionId: string },
  tool: { toolId: string; toolCavityId: string | null },
) {
  const name = `JOB-${pad(i)}`;
  let jobId: string;

  const existing = await prisma.job.findFirst({
    where: { siteId, deletedAt: null, currentVersion: { name } },
  });
  if (existing) {
    jobId = existing.id;
  } else {
    const job = await prisma.job.create({ data: { siteId, processTypeId } });
    const version = await prisma.jobVersion.create({
      data: {
        version: 1,
        name,
        standardCycle: STANDARD_CYCLE_SECONDS,
        standardCycleUnit: "SECONDS",
        productsPerCycle: 1,
        jobId: job.id,
      },
    });
    await prisma.job.update({ where: { id: job.id }, data: { currentVersionId: version.id } });
    mark(true, `Job ${name}`);
    jobId = job.id;
  }

  await prisma.jobTool.upsert({
    where: { jobId_toolId: { jobId, toolId: tool.toolId } },
    update: { isActive: true },
    create: { jobId, toolId: tool.toolId, isActive: true },
  });

  const existingJobProduct = await prisma.jobProduct.findFirst({
    where: { jobId, productId: product.productId, deletedAt: null },
  });
  if (!existingJobProduct) {
    const jp = await prisma.jobProduct.create({
      data: { jobId, productId: product.productId, toolId: tool.toolId, toolCavityId: tool.toolCavityId },
    });
    const jpv = await prisma.jobProductVersion.create({
      data: { version: 1, isActive: true, quantity: 1, jobProductId: jp.id },
    });
    await prisma.jobProduct.update({ where: { id: jp.id }, data: { currentVersionId: jpv.id } });
  }

  return jobId;
}

async function ensureStation(siteId: string, workcenterId: string, processTypeId: string, i: number, jobId: string) {
  const name = stationName(i);
  const existing = await prisma.station.findFirst({
    where: { siteId, name: { equals: name, mode: "insensitive" } },
    include: { currentVersion: true },
  });
  if (existing) {
    const patch: Record<string, unknown> = {};
    if (!existing.currentJobId) patch.currentJobId = jobId;
    if (existing.workcenterId !== workcenterId) {
      patch.workcenterId = workcenterId;
      counts.moved++;
    }
    if (Object.keys(patch).length > 0) {
      await prisma.station.update({ where: { id: existing.id }, data: patch });
    }
    await prisma.stationJob.upsert({
      where: { stationId_jobId: { stationId: existing.id, jobId } },
      update: {},
      create: { stationId: existing.id, jobId },
    });
    return existing.id;
  }

  const station = await prisma.station.create({
    data: { name, siteId, workcenterId, currentJobId: jobId, description: "Load test sim station" },
  });
  const version = await prisma.stationVersion.create({
    data: {
      version: 1,
      standardCycle: STANDARD_CYCLE_SECONDS,
      downtimeDetect: 120,
      downtimeDetectUnit: "SECONDS",
      slowDetect: 25,
      slowDetectUnit: "PERCENTAGE",
      processTypeId,
      stationId: station.id,
    },
  });
  await prisma.station.update({ where: { id: station.id }, data: { currentVersionId: version.id } });
  await prisma.stationJob.upsert({
    where: { stationId_jobId: { stationId: station.id, jobId } },
    update: {},
    create: { stationId: station.id, jobId },
  });
  mark(true, `Station ${name}`);
  return station.id;
}

async function ensureDatasource(siteId: string, gatewayId: string, stationId: string, i: number) {
  const name = `SIM-${stationName(i)}`;
  let datasource = await prisma.datasource.findFirst({ where: { gatewayId, name } });
  let changedSpec = false;

  if (!datasource) {
    datasource = await prisma.datasource.create({
      data: {
        name,
        type: "DEVICE",
        status: "ACTIVE",
        driver: "simulation",
        driverVersion: "1.0.0",
        connection: {},
        gatewayId,
        siteId,
      },
    });
    mark(true, `Datasource ${name}`);
    changedSpec = true;
  }

  let group = await prisma.pointGroup.findFirst({ where: { datasourceId: datasource.id, name: "Cycle" } });
  if (!group) {
    group = await prisma.pointGroup.create({
      data: { name: "Cycle", pollRateMs: 1000, datasourceId: datasource.id },
    });
    changedSpec = true;
  }

  let point = await prisma.point.findFirst({
    where: { datasourceId: datasource.id, groupId: group.id, name: "Cycle Complete" },
  });
  if (!point) {
    point = await prisma.point.create({
      data: {
        name: "Cycle Complete",
        address: CYCLE_ADDRESS,
        dataType: "BOOL",
        datasourceId: datasource.id,
        groupId: group.id,
      },
    });
    changedSpec = true;
  }

  if (args.telemetry) {
    let telemetryGroup = await prisma.pointGroup.findFirst({
      where: { datasourceId: datasource.id, name: "Telemetry" },
    });
    if (!telemetryGroup) {
      telemetryGroup = await prisma.pointGroup.create({
        data: { name: "Telemetry", pollRateMs: 5000, datasourceId: datasource.id },
      });
      changedSpec = true;
    }
    const telemetryPoints = [
      { name: "Barrel Temp", address: "sine(150,200,60000)", dataType: "FLOAT32" },
      { name: "Injection Pressure", address: "random(900,1100)", dataType: "FLOAT32" },
    ];
    for (const tp of telemetryPoints) {
      const exists = await prisma.point.findFirst({
        where: { datasourceId: datasource.id, groupId: telemetryGroup.id, name: tp.name },
      });
      if (!exists) {
        await prisma.point.create({
          data: { ...tp, datasourceId: datasource.id, groupId: telemetryGroup.id },
        });
        changedSpec = true;
      }
    }
  }

  await prisma.stationDatasource.upsert({
    where: { stationId_datasourceId: { stationId, datasourceId: datasource.id } },
    update: {},
    create: { stationId, datasourceId: datasource.id },
  });

  return { datasourceId: datasource.id, pointId: point.id, changedSpec };
}

async function ensureGraph(
  scope: { workspaceId: string; siteId: string },
  i: number,
  stationId: string,
  datasourceId: string,
  pointId: string,
) {
  const name = stationName(i);

  // Node (@imm/station) — nodes.create rejects duplicates, so check first.
  let nodeId: string;
  let nodeProps: Array<{ id: string; name: string }>;
  const existingNode = await prisma.graphNode.findFirst({
    where: { siteId: scope.siteId, name, isDeleted: false },
    include: { properties: { where: { isDeleted: false }, select: { id: true, name: true } } },
  });
  if (existingNode) {
    nodeId = existingNode.id;
    nodeProps = existingNode.properties;
  } else {
    const node = unwrap(
      `graph node ${name}`,
      (await nodes.create(
        { name, typeRef: "@imm/station", typeContext: { stationId }, materializeTypeFields: true },
        scope,
      )) as ServiceResult,
    );
    nodeId = node.id as string;
    nodeProps = (node.properties as Array<{ id: string; name: string }>) ?? [];
    mark(true, `GraphNode ${name} (${nodeProps.length} properties)`);
  }

  const stationIdProp = nodeProps.find((p) => p.name === "stationId");
  if (!stationIdProp) throw new Error(`node ${name} has no stationId property`);
  const currentJobIdProp = nodeProps.find((p) => p.name === "currentJobId");

  // Cycle trigger property — tag resolver on tags.<datasourceId>.<pointId>
  let tagPropId: string;
  const existingProp = await prisma.graphProperty.findFirst({
    where: { nodeId, name: "Cycle Complete", isDeleted: false },
  });
  if (existingProp) {
    tagPropId = existingProp.id;
  } else {
    const tagProp = unwrap(
      `tag property ${name}`,
      (await properties.create(
        {
          nodeId,
          name: "Cycle Complete",
          resolverType: "tag",
          resolver: { type: "tag", deviceId: datasourceId, tagPath: pointId },
        },
        scope,
      )) as ServiceResult,
    );
    tagPropId = tagProp.id as string;
    mark(true, `TagProperty ${name} -> tags.${datasourceId}.${pointId}`);
  }

  // Hook: cycle trigger increases -> imm.cycle_completed
  const hookName = `${name} Cycle Complete hook`;
  const existingHook = await prisma.graphHook.findFirst({
    where: { siteId: scope.siteId, name: hookName, isDeleted: false },
  });
  if (!existingHook) {
    const eventContext: Record<string, unknown> = {
      stationId: { source: { type: "property", propertyId: stationIdProp.id } },
    };
    if (currentJobIdProp) {
      eventContext.jobId = { source: { type: "property", propertyId: currentJobIdProp.id } };
    }
    unwrap(
      `hook ${hookName}`,
      (await hooks.create(
        {
          name: hookName,
          condition: { source: { type: "property", propertyId: tagPropId }, operator: "increases" },
          eventNamespace: "imm",
          eventName: "cycle_completed",
          eventVersion: "1",
          eventContext,
        },
        scope,
      )) as ServiceResult,
    );
    mark(true, `GraphHook ${hookName}`);
  }
}

async function ensureRollupNode(
  scope: { workspaceId: string; siteId: string },
  name: string,
  typeRef: string,
  typeContext: Record<string, unknown>,
) {
  const existing = await prisma.graphNode.findFirst({
    where: { siteId: scope.siteId, name, isDeleted: false },
  });
  if (existing) return existing.id;
  const node = unwrap(
    `rollup node ${name}`,
    (await nodes.create({ name, typeRef, typeContext, materializeTypeFields: true }, scope)) as ServiceResult,
  );
  mark(true, `GraphNode ${name} (${typeRef})`);
  return node.id as string;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`Seeding ${STATION_COUNT} load-test stations (additive, idempotent)\n`);

  const scope = await resolveScope();
  console.log(`workspace ${scope.workspaceId}\nsite      ${scope.siteId} (${SITE_NAME})\n`);

  const gateway = await resolveGateway(scope.siteId);
  console.log(`gateway   ${gateway.id} (${gateway.name}, serial ${gateway.serialNumber})\n`);

  const processTypeId = await ensureProcessType(scope.siteId);
  const materials = await ensureMaterials(scope.siteId);
  await ensureShifts(scope.siteId);

  // Workcenters: one per WORKCENTER_SIZE stations
  const workcenterIds = new Map<number, string>();
  const groups = Math.ceil(STATION_COUNT / WORKCENTER_SIZE);
  for (let g = 1; g <= groups; g++) {
    workcenterIds.set(g, await ensureWorkcenter(scope.siteId, processTypeId, wcName(g)));
  }

  let specChanged = false;
  for (let i = 1; i <= STATION_COUNT; i++) {
    const material = materials[(i - 1) % materials.length];
    const workcenterId = workcenterIds.get(wcGroup(i));
    if (!workcenterId) throw new Error(`no workcenter for station ${i}`);
    const product = await ensureProduct(scope.siteId, i, material);
    const tool = await ensureTool(scope.siteId, i);
    const jobId = await ensureJob(scope.siteId, processTypeId, i, product, tool);
    const stationId = await ensureStation(scope.siteId, workcenterId, processTypeId, i, jobId);
    const ds = await ensureDatasource(scope.siteId, gateway.id, stationId, i);
    await ensureGraph(scope, i, stationId, ds.datasourceId, ds.pointId);
    specChanged = specChanged || ds.changedSpec;
    if (i % 25 === 0) console.log(`  ... ${i}/${STATION_COUNT}`);
  }

  // Rollup nodes: one @imm/workcenter node per workcenter + one @imm/site node
  for (let g = 1; g <= groups; g++) {
    await ensureRollupNode(scope, wcName(g), "@imm/workcenter", { workcenterId: workcenterIds.get(g) });
  }
  await ensureRollupNode(scope, `${SITE_NAME} (Site)`, "@imm/site", { siteId: scope.siteId });

  // Moved stations have a stale workcenterId facet on their graph node (direct
  // DB updates emit no entity events) — refresh so workcenter rollups see them.
  if (counts.moved > 0) {
    const refreshed = await nodes.refreshFacetsForType({ typeRef: "@imm/station", scope });
    console.log(
      `  moved ${counts.moved} stations between workcenters; station facets refreshed: ${JSON.stringify(
        "data" in refreshed ? refreshed.data : refreshed,
      )}`,
    );
  }

  if (specChanged) {
    const bumped = await bumpSpecVersion(gateway.id);
    console.log(
      `\ngateway spec bumped to v${bumped.specVersion} — sim drivers go live within ~5s of the next /edge/sync`,
    );
  } else {
    console.log("\nno datasource changes — gateway spec version untouched");
  }

  console.log(
    `\ndone: ${counts.created} objects created, ${counts.moved} stations moved, everything else already existed`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
