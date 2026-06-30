/**
 * Dev seed — materializes one @imm/station graph node plus the cycle-complete
 * tag + hook, mirroring the reference setup:
 *   - Station node (typeContext.stationId), with all type fields materialized.
 *   - A "Cycle Complete" tag property fed from tags.<device>.<path>.
 *   - A GraphHook that fires when that tag increases and emits imm.cycle_completed,
 *     mapping stationId from the node's stationId property.
 *
 *   DATABASE_URL=... pnpm --filter @rw/workers seed:station
 *   SEED_STATION_ID=<uuid> SEED_NODE_NAME="STN-01" ... seed:station
 */

import "dotenv/config";

import { createPrismaClient } from "@rw/db";
import * as hooks from "@rw/services/graph/hooks";
import * as nodes from "@rw/services/graph/nodes";
import * as properties from "@rw/services/graph/properties";

createPrismaClient("api");

const scope = {
  workspaceId: process.env.SEED_WORKSPACE_ID ?? "e9e9927e-4537-431a-a9ff-a591d850feaa",
  siteId: process.env.SEED_SITE_ID ?? "59dadf6c-860b-4029-b9bf-5617e00781df",
};
const STATION_ID = process.env.SEED_STATION_ID ?? "23cb545f-7743-4b0c-8b0c-1a8ffa6df6d7";
const NODE_NAME = process.env.SEED_NODE_NAME ?? "STN-01";
const DEVICE_ID = process.env.SEED_DEVICE_ID ?? "sim-press-01";
const TAG_PATH = process.env.SEED_TAG_PATH ?? "cycleComplete";

interface Result {
  data?: unknown;
  error?: string;
  code?: string;
}

function unwrap(label: string, result: Result): Record<string, unknown> {
  if (result && typeof result === "object" && "error" in result && result.error) {
    throw new Error(`${label} failed: ${result.code} ${result.error}`);
  }
  return ((result.data ?? result) as Record<string, unknown>) ?? {};
}

async function main(): Promise<void> {
  const node = unwrap(
    "createNode",
    await nodes.create(
      { name: NODE_NAME, typeRef: "@imm/station", typeContext: { stationId: STATION_ID }, materializeTypeFields: true },
      scope,
    ),
  );
  const nodeId = node.id as string;
  const nodeProps = (node.properties as Array<{ id: string; name: string }>) ?? [];
  const stationIdProp = nodeProps.find((p) => p.name === "stationId");
  if (!stationIdProp) throw new Error("seeded node has no stationId property");
  console.log(`node ${nodeId} (${NODE_NAME}) — ${nodeProps.length} properties; stationId prop ${stationIdProp.id}`);

  const tagProp = unwrap(
    "createProperty",
    await properties.create(
      {
        nodeId,
        name: "Cycle Complete",
        resolverType: "tag",
        resolver: { type: "tag", deviceId: DEVICE_ID, tagPath: TAG_PATH },
      },
      scope,
    ),
  );
  console.log(`tag property ${tagProp.id} -> tags.${DEVICE_ID}.${TAG_PATH}`);

  const hook = unwrap(
    "createHook",
    await hooks.create(
      {
        name: `${NODE_NAME} Cycle Complete hook`,
        condition: { source: { type: "property", propertyId: tagProp.id as string }, operator: "increases" },
        eventNamespace: "imm",
        eventName: "cycle_completed",
        eventVersion: "1",
        eventContext: { stationId: { source: { type: "property", propertyId: stationIdProp.id } } },
      },
      scope,
    ),
  );
  console.log(`hook ${hook.id}`);

  console.log(
    JSON.stringify(
      { nodeId, stationId: STATION_ID, tagSubject: `tags.${DEVICE_ID}.${TAG_PATH}`, deviceId: DEVICE_ID, tagPath: TAG_PATH, hookId: hook.id },
      null,
      2,
    ),
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
