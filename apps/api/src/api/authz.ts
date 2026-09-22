import type { FastifyReply } from "fastify";
import prisma from "@rw/db";
import type { IAMContext } from "@rw/auth/context";
import {
  authorize,
  authorizeList,
  authorizeReferenceRead,
  type PolicyDenial,
  type PolicyResult,
} from "@rw/auth/iam/policy";

/** Physical setup targets must belong to the caller's company, even for workspace grants. */
async function physicalWorkspaceDenial(scope: {
  workspaceId: string;
  siteId?: string;
}): Promise<PolicyDenial | undefined> {
  if (!scope.siteId) return;
  const site = await prisma.site.findUnique({ where: { id: scope.siteId }, select: { workspaceId: true } });
  if (!site) return { ok: false, code: "NOT_FOUND", message: "Site not found" };
  if (site.workspaceId !== scope.workspaceId) {
    return { ok: false, code: "FORBIDDEN", message: "Site does not belong to this workspace" };
  }
}

// Preserve the core overloads so concrete targets continue to prove a siteId.
export const authorizePhysicalTarget = (async (
  iam: IAMContext | undefined,
  check: Parameters<typeof authorize>[1],
): Promise<PolicyResult> => {
  const result = await authorize(iam, check);
  if (!result.ok) return result;
  return (await physicalWorkspaceDenial(result)) ?? result;
}) as typeof authorize;

export const authorizePhysicalList: typeof authorizeList = async (iam, check) => {
  const result = await authorizeList(iam, check);
  if (!result.ok) return result;
  return (await physicalWorkspaceDenial(result)) ?? result;
};

export const authorizePhysicalReference: typeof authorizeReferenceRead = async (iam, check) => {
  const result = await authorizeReferenceRead(iam, check);
  if (!result.ok) return result;
  return (await physicalWorkspaceDenial(result)) ?? result;
};

/** An unassigned gateway can be commissioned into an authorized plant; other pool mutations require workspace authority. */
export async function authorizeGatewayAssignment(
  iam: IAMContext | undefined,
  id: string,
  targetSiteId?: string,
): Promise<PolicyResult> {
  if (!targetSiteId) {
    return authorizePhysicalTarget(iam, { permission: "configuration:write", scope: { kind: "gateway", id } });
  }
  const target = await authorizePhysicalTarget(iam, {
    permission: "configuration:write",
    scope: { kind: "site", siteId: targetSiteId },
  });
  if (!target.ok) return target;
  const gateway = await prisma.gateway.findUnique({ where: { id }, select: { siteId: true } });
  if (!gateway) return { ok: false, code: "NOT_FOUND", message: "Gateway not found" };
  if (gateway.siteId) {
    const source = await authorizePhysicalTarget(iam, {
      permission: "configuration:write",
      scope: { kind: "site", siteId: gateway.siteId },
    });
    if (!source.ok) return source;
  }
  return target;
}

/**
 * REST transport mapping for policy denials. Bodies match the pre-policy
 * hand-rolled responses in these route files: bare "forbidden" (no
 * permission echo), "No workspace context" as 401.
 */
export function replyPolicyDenial(reply: FastifyReply, denial: PolicyDenial): FastifyReply {
  switch (denial.code) {
    case "UNAUTHENTICATED":
      return reply.status(401).send({ error: "Unauthorized" });
    case "NO_WORKSPACE":
      return reply.status(401).send({ error: "No workspace context" });
    case "NOT_FOUND":
      return reply.status(404).send({ error: denial.message });
    case "FORBIDDEN":
      return reply.status(403).send({ error: "forbidden" });
  }
}
