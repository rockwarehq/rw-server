/**
 * Dev one-off — add a "shiftItemsTotal" totalizer property to a station node:
 * each Cycle Complete increase adds the station's current itemsPerCycle;
 * total zeroes when shiftInstanceId changes. Restart livestore afterwards.
 *
 *   TOTALIZER_NODE_NAME=STN-30 pnpm --filter @rw/workers exec tsx scripts/add-shift-items-totalizer.ts
 */

import "dotenv/config";

import prisma, { createPrismaClient } from "@rw/db";
import * as properties from "@rw/livestore/graph/properties";

createPrismaClient("api");

const NODE_NAME = process.env.TOTALIZER_NODE_NAME ?? "STN-30";
const PROPERTY_NAME = process.env.TOTALIZER_PROPERTY_NAME ?? "shiftItemsTotal";

const node = await prisma.graphNode.findFirst({
  where: { name: NODE_NAME, isDeleted: false },
  select: { id: true, siteId: true, site: { select: { workspaceId: true } } },
});
if (!node) throw new Error(`node ${NODE_NAME} not found`);
const scope = { siteId: node.siteId, workspaceId: node.site.workspaceId };

const props = await prisma.graphProperty.findMany({
  where: { nodeId: node.id, isDeleted: false },
  select: { id: true, name: true, resolver: true },
});
const byName = new Map(props.map((p) => [p.name, p]));
const need = (name: string) => {
  const p = byName.get(name);
  if (!p) throw new Error(`property "${name}" not found on ${NODE_NAME}`);
  return p;
};

if (byName.has(PROPERTY_NAME)) {
  console.log(`${PROPERTY_NAME} already exists on ${NODE_NAME} — nothing to do`);
  process.exit(0);
}

const source = need("itemsPerCycle");
const trigger = need("Cycle Complete");
const reset = need("shiftInstanceId");
console.log(`trigger tag resolver:`, JSON.stringify(trigger.resolver));

const result = (await properties.create(
  {
    nodeId: node.id,
    name: PROPERTY_NAME,
    resolverType: "totalizer",
    resolver: {
      type: "totalizer",
      sourcePropertyId: source.id,
      trigger: { source: { type: "property", propertyId: trigger.id }, operator: "increases" },
      reset: { source: { type: "property", propertyId: reset.id }, operator: "changed" },
    },
  },
  scope,
)) as { error?: string; code?: string; data?: { id?: string } };

if (result?.error) throw new Error(`create failed: ${result.code} ${result.error}`);
console.log(`created ${PROPERTY_NAME} on ${NODE_NAME}:`, result.data?.id);
await prisma.$disconnect();
