import "dotenv/config";

import { createPrismaClient } from "@rw/db";

import { deriveTagSubject } from "@rw/runtime/graph-subjects";
import { type Aggregation, type WindowResolverConfig, validateWindowResolver } from "@rw/livestore";

const nodeName = process.env.GRAPH_NODE_NAME ?? "Press 7";
const propertyName = process.env.GRAPH_PROPERTY_NAME ?? "cycleTime";
const deviceId = process.env.GRAPH_DEVICE_ID ?? "press7-plc";
const tagPath = process.env.GRAPH_TAG_PATH ?? "cycleTime";

// Optional window property over the tag (GRAPH_WINDOW_KIND=tumbling|ewma).
const windowKind = process.env.GRAPH_WINDOW_KIND;
const windowAggregation = (process.env.GRAPH_WINDOW_AGG ?? "avg") as Aggregation;
const windowMs = Number(process.env.GRAPH_WINDOW_MS ?? 10_000);
const windowAlpha = Number(process.env.GRAPH_WINDOW_ALPHA ?? 0.3);

async function main(): Promise<void> {
  const prisma = createPrismaClient("livestore");
  const siteId =
    process.env.GRAPH_SITE_ID ??
    (
      await prisma.site.findFirst({
        orderBy: { name: "asc" },
        select: { id: true },
      })
    )?.id;
  if (!siteId) throw new Error("GRAPH_SITE_ID is required when no site exists");

  const node = await prisma.graphNode.upsert({
    where: { siteId_name: { siteId, name: nodeName } },
    create: { name: nodeName, siteId },
    update: { isDeleted: false },
  });

  const property = await prisma.graphProperty.upsert({
    where: { nodeId_name: { nodeId: node.id, name: propertyName } },
    create: {
      nodeId: node.id,
      name: propertyName,
      resolverType: "tag",
      resolver: { type: "tag", deviceId, tagPath },
    },
    update: {
      resolverType: "tag",
      resolver: { type: "tag", deviceId, tagPath },
      isDeleted: false,
    },
  });

  let windowProperty: { id: string; name: string } | null = null;
  if (windowKind === "tumbling" || windowKind === "ewma") {
    const resolver: WindowResolverConfig = {
      type: "window",
      sourcePropertyId: property.id,
      kind: windowKind,
      aggregation: windowAggregation,
      ...(windowKind === "tumbling" ? { windowMs } : { alpha: windowAlpha }),
    };
    const errors = validateWindowResolver(resolver, (id) =>
      id === property.id ? { resolverType: property.resolverType } : null,
    );
    if (errors.length > 0) throw new Error(`invalid window config: ${errors.join("; ")}`);

    const windowName = `${propertyName}_${windowKind === "ewma" ? "ewma" : windowAggregation}`;
    windowProperty = await prisma.graphProperty.upsert({
      where: { nodeId_name: { nodeId: node.id, name: windowName } },
      create: { nodeId: node.id, name: windowName, resolverType: "window", resolver },
      update: { resolverType: "window", resolver, isDeleted: false },
    });
    // Persisted source -> window edge keeps topo order honest; the resolver indexes from config.
    await prisma.graphEdge.deleteMany({ where: { toPropertyId: windowProperty.id } });
    await prisma.graphEdge.create({
      data: { fromPropertyId: property.id, toPropertyId: windowProperty.id },
    });
  } else if (windowKind) {
    throw new Error(`GRAPH_WINDOW_KIND must be "tumbling" or "ewma", got "${windowKind}"`);
  }

  console.log(
    JSON.stringify(
      {
        nodeId: node.id,
        nodeName: node.name,
        propertyId: property.id,
        propertyName: property.name,
        subject: deriveTagSubject(deviceId, tagPath),
        ...(windowProperty && { windowPropertyId: windowProperty.id, windowPropertyName: windowProperty.name }),
      },
      null,
      2,
    ),
  );

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("[livestore fixture:create] failed", err);
  process.exit(1);
});
