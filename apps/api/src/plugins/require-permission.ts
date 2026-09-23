import type { FastifyReply, FastifyRequest } from "fastify";
import { type BucketTier, loadBucketSnapshot, snapshotPlantTier, tierAtLeast } from "@rw/auth/iam/index";

/**
 * Fastify preHandler that enforces a bucket tier.
 *
 * Usage — ADMIN at the request's site plant:
 *   preHandler: [fastify.verifyAccessToken, requireTier("ADMIN", { scope: "site" })]
 *
 * Usage — workspace-level (owner or Rockware staff), URL carries the
 * workspace id:
 *   preHandler: [fastify.verifyAccessToken, requireTier("ADMIN", { scope: "workspace", workspaceParam: "id" })]
 *
 * Usage — ownership-only (owner, no staff bypass):
 *   preHandler: [fastify.verifyAccessToken, requireTier("ADMIN", { scope: "workspace", ownerOnly: true })]
 *
 * Returns:
 *   - 401 if the request is unauthenticated or has no workspace context.
 *   - 403 `{ error: "forbidden", required }` if the check fails.
 */
export interface RequireTierOptions {
  /**
   * "workspace" — reserved for workspace owners (staff FULL passes unless
   * ownerOnly). "site" (default) — the tier must be held on the plant
   * bucket of the route/token site.
   */
  scope?: "workspace" | "site";
  /** Owner strictly; Rockware staff cannot substitute. Workspace scope only. */
  ownerOnly?: boolean;
  /** Route-param name that holds the workspace id (default: token workspace). */
  workspaceParam?: string;
  /** Route-param name that holds the site id (default `"siteId"`, else token site). */
  siteParam?: string;
}

export function requireTier(tier: BucketTier, opts: RequireTierOptions = {}) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const userId = req.iam?.id;
    if (!userId) {
      return reply.status(401).send({ error: "Unauthorized" });
    }

    const params = req.params as Record<string, string | undefined> | undefined;
    const workspaceId = opts.workspaceParam ? params?.[opts.workspaceParam] : req.iam?.workspaceId;

    if (!workspaceId) {
      return reply.status(401).send({ error: "No workspace context" });
    }
    // A URL-supplied workspace must match the caller's session workspace.
    if (opts.workspaceParam && req.iam?.workspaceId && workspaceId !== req.iam.workspaceId) {
      return reply.status(403).send({ error: "forbidden", required: tier });
    }

    const snapshot =
      req.iam?.bucketSnapshot && req.iam.workspaceId === workspaceId
        ? req.iam.bucketSnapshot
        : await loadBucketSnapshot(userId, workspaceId);
    if (!snapshot) {
      return reply.status(403).send({ error: "forbidden", required: tier });
    }

    if (opts.scope === "workspace") {
      const ok = snapshot.owner || (!opts.ownerOnly && snapshot.staff === "FULL");
      if (!ok) {
        return reply.status(403).send({ error: "forbidden", required: tier });
      }
      return;
    }

    if (snapshot.owner || snapshot.staff === "FULL" || (snapshot.staff === "READ" && tier === "VIEW")) {
      return;
    }

    const siteKey = opts.siteParam ?? "siteId";
    const siteId = params?.[siteKey] ?? req.iam?.siteId;
    if (!siteId) {
      return reply.status(401).send({ error: "No site context" });
    }
    if (!tierAtLeast(snapshotPlantTier(snapshot, siteId), tier)) {
      return reply.status(403).send({ error: "forbidden", required: tier });
    }
  };
}
