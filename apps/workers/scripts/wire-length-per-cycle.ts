/**
 * Dev one-off — give the STN-30 shift totalizer a weight-like source:
 * adds an entity property for the encoderLengthTick static point, an expr
 * property lengthPerCycle = encoderLengthTick * itemsPerCycle, and points
 * the shiftItemsTotal totalizer's source at it. Restart livestore after.
 *
 *   pnpm --filter @rw/workers exec tsx scripts/wire-length-per-cycle.ts
 */

import "dotenv/config";

import prisma, { createPrismaClient } from "@rw/db";
import * as properties from "@rw/livestore/graph/properties";

createPrismaClient("api");

const NODE_NAME = process.env.TOTALIZER_NODE_NAME ?? "STN-30";
const TOTALIZER_NAME = process.env.TOTALIZER_PROPERTY_NAME ?? "shiftItemsTotal";
const ENCODER_POINT_ID = process.env.ENCODER_POINT_ID ?? "4f9664c8-f234-4181-af57-3c88f553b195";

interface Result {
  error?: string;
  code?: string;
  data?: { id?: string };
}
const check = (label: string, r: Result): string => {
  if (r?.error) throw new Error(`${label} failed: ${r.code} ${r.error}`);
  if (!r.data?.id) throw new Error(`${label}: no id in result`);
  return r.data.id;
};
const ref = (propertyId: string): string => `p_${propertyId.replaceAll("-", "_")}`;

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

const itemsPerCycle = need("itemsPerCycle");
const totalizer = need(TOTALIZER_NAME);

let encoderId = byName.get("encoderLengthTick")?.id;
if (!encoderId) {
  encoderId = check(
    "encoderLengthTick",
    (await properties.create(
      {
        nodeId: node.id,
        name: "encoderLengthTick",
        resolverType: "entity",
        resolver: { type: "entity", entityType: "datasource.point", entityId: ENCODER_POINT_ID, path: "staticValue" },
      },
      scope,
    )) as Result,
  );
  console.log("created encoderLengthTick:", encoderId);
}

let lengthPerCycleId = byName.get("lengthPerCycle")?.id;
if (!lengthPerCycleId) {
  lengthPerCycleId = check(
    "lengthPerCycle",
    (await properties.create(
      {
        nodeId: node.id,
        name: "lengthPerCycle",
        resolverType: "expr",
        resolver: { type: "expr", expression: `${ref(encoderId)} * ${ref(itemsPerCycle.id)}` },
      },
      scope,
    )) as Result,
  );
  console.log("created lengthPerCycle:", lengthPerCycleId);
}

const resolver = totalizer.resolver as Record<string, unknown>;
check(
  "retarget totalizer",
  (await properties.update(
    totalizer.id,
    { resolverType: "totalizer", resolver: { ...resolver, sourcePropertyId: lengthPerCycleId } },
    scope,
  )) as Result,
);
console.log(`${TOTALIZER_NAME} source -> lengthPerCycle (${lengthPerCycleId})`);
await prisma.$disconnect();
