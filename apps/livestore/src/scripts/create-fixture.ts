import "dotenv/config";

import { createPrismaClient } from "@rw/db";

import { deriveTagSubject } from "../subjects.js";

const nodeName = process.env.GRAPH_NODE_NAME ?? "Press 7";
const propertyName = process.env.GRAPH_PROPERTY_NAME ?? "cycleTime";
const deviceId = process.env.GRAPH_DEVICE_ID ?? "press7-plc";
const tagPath = process.env.GRAPH_TAG_PATH ?? "cycleTime";

async function main(): Promise<void> {
  const prisma = createPrismaClient("livestore");
  const node = await prisma.graphNode.upsert({
    where: { name: nodeName },
    create: { name: nodeName },
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

  console.log(
    JSON.stringify(
      {
        nodeId: node.id,
        nodeName: node.name,
        propertyId: property.id,
        propertyName: property.name,
        subject: deriveTagSubject(deviceId, tagPath),
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
