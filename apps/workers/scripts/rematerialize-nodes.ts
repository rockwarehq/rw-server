/**
 * Dev one-off — re-materialize type fields on all existing typed graph nodes
 * so they pick up fields added to the type definitions (non-destructive:
 * keeps nodes, hooks, and property ids; only stamps missing/changed fields).
 *
 *   DATABASE_URL=... pnpm --filter @rw/workers exec tsx scripts/rematerialize-nodes.ts
 *
 * Restart livestore afterwards if NATS isn't reachable from this script —
 * the graph-definition events won't have been published.
 */

import "dotenv/config";

import prisma, { createPrismaClient } from "@rw/db";
import * as nodes from "@rw/livestore/graph/nodes";

createPrismaClient("api");

const liveNodes = await prisma.graphNode.findMany({
  where: { isDeleted: false, typeRef: { not: null } },
  select: {
    id: true,
    name: true,
    typeRef: true,
    typeContext: true,
    siteId: true,
    site: { select: { workspaceId: true } },
  },
});

let ok = 0;
let failed = 0;
for (const node of liveNodes) {
  const scope = { siteId: node.siteId, workspaceId: node.site.workspaceId };
  try {
    const result = (await nodes.update(
      node.id,
      { typeContext: (node.typeContext ?? {}) as Record<string, unknown> },
      scope,
    )) as { error?: string; code?: string };
    if (result?.error) {
      failed++;
      console.error(`FAIL ${node.name} (${node.typeRef}): ${result.code} ${result.error}`);
    } else {
      ok++;
      console.log(`ok   ${node.name} (${node.typeRef})`);
    }
  } catch (err) {
    failed++;
    console.error(`FAIL ${node.name} (${node.typeRef}):`, err);
  }
}

console.log(`done: ${ok} re-materialized, ${failed} failed of ${liveNodes.length} typed nodes`);
await prisma.$disconnect();
process.exit(failed > 0 ? 1 : 0);
