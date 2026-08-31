// Re-materialize type fields on @imm/station nodes so existing nodes gain
// newly added catalog fields (e.g. openCallCount/callsUpdatedAt). Run once
// per environment after a deploy that adds station type fields.
import "dotenv/config";
import prisma from "@rw/db";
import { nodes } from "@rw/livestore/graph/index";

const stationNodes = await prisma.graphNode.findMany({
  where: { typeRef: "@imm/station", isDeleted: false },
  select: { id: true, name: true, siteId: true, typeContext: true, site: { select: { workspaceId: true } } },
});
console.log("station nodes:", stationNodes.length);
for (const node of stationNodes) {
  const scope = { workspaceId: node.site.workspaceId, siteId: node.siteId };
  const result = await nodes.update(node.id, { typeContext: node.typeContext as Record<string, unknown> }, scope);
  console.log(node.name, "error" in (result ?? {}) ? JSON.stringify(result) : "ok");
}
const check = await prisma.graphProperty.count({
  where: { typeFieldKey: { in: ["openCallCount", "callsUpdatedAt"] }, isDeleted: false },
});
console.log("new call properties:", check);
await prisma.$disconnect();
