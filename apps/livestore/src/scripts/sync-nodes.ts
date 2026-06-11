import "dotenv/config";

import { createPrismaClient } from "@rw/db";

import { syncNodes } from "../node-sync.js";

async function main(): Promise<void> {
  const prisma = createPrismaClient("livestore");
  const result = await syncNodes(prisma);
  console.log(JSON.stringify(result, null, 2));
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("[livestore sync:nodes] failed", err);
  process.exit(1);
});
