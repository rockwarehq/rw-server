/**
 * Dev seed — materializes a set of @imm/station nodes plus their @imm/workcenter
 * node so rollups can be tested. Node-only (no per-station tag/hook); drive
 * cycles with `publish:cycles` (PUBLISH_CYCLE_WORKCENTER_ID).
 *
 *   DATABASE_URL=... pnpm --filter @rw/workers seed:rollup-set
 *   SEED_WORKCENTER_ID=<uuid> SEED_STATION_LIMIT=10 ... seed:rollup-set
 */

import "dotenv/config";

import prisma, { createPrismaClient } from "@rw/db";
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

async function seedNode(name: string, typeRef: string, typeContext: Record<string, unknown>): Promise<void> {
  const res = (await nodes.create({ name, typeRef, typeContext, materializeTypeFields: true }, scope)) as Result;
  if (res && typeof res === "object" && "error" in res && res.error) {
    if (res.code === "GRAPH_NODE_NAME_EXISTS") {
      console.log(`skip ${name} (already exists)`);
      return;
    }
    throw new Error(`${name} failed: ${res.code} ${res.error}`);
  }
  const node = (res.data ?? res) as { id: string; properties?: unknown[] };
  console.log(`seeded ${name} -> ${node.id} (${node.properties?.length ?? 0} props)`);
}

async function main(): Promise<void> {
  const wc = await prisma.workcenter.findUnique({ where: { id: WORKCENTER_ID }, select: { id: true, name: true } });
  if (!wc) throw new Error(`workcenter ${WORKCENTER_ID} not found`);
  const stations = await prisma.station.findMany({
    where: { workcenterId: WORKCENTER_ID, deletedAt: null },
    orderBy: { name: "asc" },
    take: LIMIT,
    select: { id: true, name: true },
  });
  console.log(`workcenter "${wc.name}" (${wc.id}); seeding ${stations.length} stations + workcenter`);

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
