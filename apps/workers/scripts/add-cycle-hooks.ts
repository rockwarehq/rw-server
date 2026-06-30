/**
 * Dev — add a "Cycle Complete" tag property + cycle hook to existing station
 * graph nodes (the authentic tag -> hook -> imm.cycle_completed path).
 *
 * All hooks watch one shared tag subject (tags.<device>.<path>), so a single
 * publish:counter drives a cycle on every hooked station per increment.
 *
 *   DATABASE_URL=... pnpm --filter @rw/workers add:cycle-hooks
 *   SEED_STATION_LIMIT=10 SEED_DEVICE_ID=sim-mold SEED_TAG_PATH=cycleComplete ...
 */

import "dotenv/config";

import prisma, { createPrismaClient } from "@rw/db";
import * as hooks from "@rw/services/graph/hooks";
import * as properties from "@rw/services/graph/properties";

createPrismaClient("api");

const scope = {
  workspaceId: process.env.SEED_WORKSPACE_ID ?? "e9e9927e-4537-431a-a9ff-a591d850feaa",
  siteId: process.env.SEED_SITE_ID ?? "59dadf6c-860b-4029-b9bf-5617e00781df",
};
const WORKCENTER_ID = process.env.SEED_WORKCENTER_ID ?? "a9f1eec5-eaff-4c4a-9c9c-c40632951323";
const LIMIT = Number.parseInt(process.env.SEED_STATION_LIMIT ?? "", 10) || 10;
const DEVICE_ID = process.env.SEED_DEVICE_ID ?? "sim-mold";
const TAG_PATH = process.env.SEED_TAG_PATH ?? "cycleComplete";

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

async function main(): Promise<void> {
  const stations = await prisma.station.findMany({
    where: { workcenterId: WORKCENTER_ID, deletedAt: null },
    orderBy: { name: "asc" },
    take: LIMIT,
    select: { id: true, name: true },
  });

  let added = 0;
  for (const station of stations) {
    const node = await prisma.graphNode.findUnique({
      where: { siteId_name: { siteId: scope.siteId, name: station.name } },
      include: { properties: { where: { isDeleted: false } } },
    });
    if (!node) {
      console.log(`skip ${station.name} (no graph node)`);
      continue;
    }
    const stationIdProp = node.properties.find((p) => p.name === "stationId");
    if (!stationIdProp) {
      console.log(`skip ${station.name} (no stationId property)`);
      continue;
    }

    const tagProp = check(
      `${station.name} tag`,
      (await properties.create(
        {
          nodeId: node.id,
          name: "Cycle Complete",
          resolverType: "tag",
          resolver: { type: "tag", deviceId: DEVICE_ID, tagPath: TAG_PATH },
        },
        scope,
      )) as Result,
    );

    const hook = check(
      `${station.name} hook`,
      (await hooks.create(
        {
          name: `${station.name} cycle hook`,
          condition: { source: { type: "property", propertyId: tagProp.id as string }, operator: "increases" },
          eventNamespace: "imm",
          eventName: "cycle_completed",
          eventVersion: "1",
          eventContext: { stationId: { source: { type: "property", propertyId: stationIdProp.id } } },
        },
        scope,
      )) as Result,
    );
    added += 1;
    console.log(`hooked ${station.name}: tag ${tagProp.id} -> hook ${hook.id}`);
  }

  console.log(`done — ${added} stations hooked on tags.${DEVICE_ID}.${TAG_PATH}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
