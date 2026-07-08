/**
 * Dev reset + reseed — soft-deletes existing graph hooks and nodes for the
 * site, then re-materializes the station + workcenter set against the current
 * type definitions (so removed/renamed fields don't linger as orphans).
 *
 *   DATABASE_URL=... pnpm --filter @rw/workers reseed:graph
 */

import "dotenv/config";

import prisma, { createPrismaClient } from "@rw/db";
import * as hooks from "@rw/livestore/graph/hooks";
import * as nodes from "@rw/livestore/graph/nodes";

createPrismaClient("api");

const scope = {
  workspaceId: process.env.SEED_WORKSPACE_ID ?? "e9e9927e-4537-431a-a9ff-a591d850feaa",
  siteId: process.env.SEED_SITE_ID ?? "59dadf6c-860b-4029-b9bf-5617e00781df",
};
const WORKCENTER_ID = process.env.SEED_WORKCENTER_ID ?? "a9f1eec5-eaff-4c4a-9c9c-c40632951323";
const LIMIT = Number.parseInt(process.env.SEED_STATION_LIMIT ?? "", 10) || 10;

interface Result {
  data?: unknown;
  error?: string;
  code?: string;
}

function check(label: string, result: Result): Record<string, unknown> {
  if (result && typeof result === "object" && "error" in result && result.error) {
    throw new Error(`${label} failed: ${result.code} ${result.error}`);
  }
  return ((result.data ?? result) as Record<string, unknown>) ?? {};
}

async function reset(): Promise<void> {
  const liveHooks = await prisma.graphHook.findMany({ where: { siteId: scope.siteId, isDeleted: false }, select: { id: true } });
  for (const h of liveHooks) check(`removeHook ${h.id}`, (await hooks.remove(h.id, scope)) as Result);
  const liveNodes = await prisma.graphNode.findMany({ where: { siteId: scope.siteId, isDeleted: false }, select: { id: true } });
  for (const n of liveNodes) check(`removeNode ${n.id}`, (await nodes.remove(n.id, scope)) as Result);
  console.log(`reset: removed ${liveHooks.length} hooks, ${liveNodes.length} nodes`);
}

async function seedNode(name: string, typeRef: string, typeContext: Record<string, unknown>): Promise<void> {
  const node = check(name, (await nodes.create({ name, typeRef, typeContext, materializeTypeFields: true }, scope)) as Result) as {
    id: string;
    properties?: unknown[];
  };
  console.log(`seeded ${name} -> ${node.id} (${node.properties?.length ?? 0} props)`);
}

async function main(): Promise<void> {
  await reset();

  const wc = await prisma.workcenter.findUnique({ where: { id: WORKCENTER_ID }, select: { id: true, name: true } });
  if (!wc) throw new Error(`workcenter ${WORKCENTER_ID} not found`);
  const stations = await prisma.station.findMany({
    where: { workcenterId: WORKCENTER_ID, deletedAt: null },
    orderBy: { name: "asc" },
    take: LIMIT,
    select: { id: true, name: true },
  });
  console.log(`reseeding workcenter "${wc.name}" + ${stations.length} stations`);
  for (const s of stations) await seedNode(s.name, "@imm/station", { stationId: s.id });
  await seedNode(wc.name, "@imm/workcenter", { workcenterId: wc.id });
  console.log("done");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
