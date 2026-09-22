import prisma, { type DocumentTargetType } from "@rw/db";
import type { IAMContext } from "@rw/auth/context";
import { authorize, authorizeReferenceRead, type PolicyResult, type ScopeRef } from "@rw/auth/iam/policy";

type Target = { targetType: DocumentTargetType; targetId: string };
const missing = (): PolicyResult => ({ ok: false, code: "NOT_FOUND", message: "Document or target not found" });

export async function authorizeDocumentTarget(iam: IAMContext, target: Target, write = false): Promise<PolicyResult> {
  const kind = {
    SITE: "site",
    WORKCENTER: "workcenter",
    STATION: "station",
    JOB: "job",
    TOOL: "tool",
    PRODUCT: "product",
    MATERIAL: "material",
  } as const;
  const scope: ScopeRef =
    target.targetType === "SITE"
      ? { kind: "site", siteId: target.targetId }
      : { kind: kind[target.targetType], id: target.targetId };
  if (target.targetType === "WORKCENTER" || target.targetType === "STATION") {
    return authorize(iam, { permission: write ? "production:write" : "production:read", scope });
  }
  return write ? authorize(iam, { permission: "configuration:write", scope }) : authorizeReferenceRead(iam, { scope });
}

/** Walk actual parents; attrs and input site claims are never ownership evidence. */
export async function authorizeDocument(iam: IAMContext, id: string, write = false): Promise<PolicyResult> {
  const seen = new Set<string>();
  let currentId: string | null = id;
  let result: PolicyResult | undefined;
  let documentSite: string | null | undefined;
  let hasTargets = false;
  while (currentId) {
    if (seen.has(currentId) || seen.size >= 100) return missing();
    seen.add(currentId);
    const row: { siteId: string | null; parentId: string | null; deletedAt: Date | null; links: Target[] } | null =
      await prisma.document.findUnique({
        where: { id: currentId },
        select: { siteId: true, parentId: true, deletedAt: true, links: true },
      });
    if (!row || row.deletedAt) return missing();
    if (documentSite === undefined) documentSite = row.siteId;
    if (row.siteId !== documentSite) return missing();
    // Null-site documents are workspace resources, even when linked to a local target.
    if (row.siteId === null) {
      result = await authorize(iam, {
        permission: write ? "configuration:write" : "configuration:read",
        scope: { kind: "workspace" },
      });
      if (!result.ok) return result;
    }
    for (const link of row.links) {
      hasTargets = true;
      result = await authorizeDocumentTarget(iam, link, write);
      if (!result.ok) return result;
      if (documentSite !== null && result.siteId !== documentSite) return missing();
    }
    currentId = row.parentId;
  }
  if (result?.ok && (hasTargets || documentSite === null)) {
    if (documentSite === undefined) return missing();
    return documentSite === null
      ? { ok: true, workspaceId: result.workspaceId }
      : { ok: true, workspaceId: result.workspaceId, siteId: documentSite };
  }
  if (!documentSite) return missing();
  return write
    ? authorize(iam, { permission: "configuration:write", scope: { kind: "site", siteId: documentSite } })
    : authorizeReferenceRead(iam, { scope: { kind: "site", siteId: documentSite } });
}

/** Authorize every affected descendant before a recursive delete/move or target-link change. */
export async function authorizeDocumentTree(iam: IAMContext, id: string): Promise<PolicyResult> {
  let result = await authorizeDocument(iam, id, true);
  if (!result.ok) return result;
  const seen = new Set<string>([id]);
  let frontier = [id];
  while (frontier.length) {
    const children = await prisma.document.findMany({ where: { parentId: { in: frontier } }, select: { id: true } });
    frontier = [];
    for (const child of children) {
      if (seen.has(child.id)) return missing();
      seen.add(child.id);
      result = await authorizeDocument(iam, child.id, true);
      if (!result.ok) return result;
      frontier.push(child.id);
    }
  }
  return result;
}

/** Apply before pagination/count so neither totals nor links disclose foreign targets. */
export async function readableDocumentIds(iam: IAMContext, siteId: string | null): Promise<string[]> {
  const rows = await prisma.document.findMany({ where: { siteId, deletedAt: null }, select: { id: true } });
  const ids: string[] = [];
  for (const row of rows) if ((await authorizeDocument(iam, row.id)).ok) ids.push(row.id);
  return ids;
}
