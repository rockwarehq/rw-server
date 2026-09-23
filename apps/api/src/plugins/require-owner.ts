import type { FastifyReply, FastifyRequest } from "fastify";
import { asUser } from "@rw/auth/context";

/**
 * Fastify preHandler for workspace-owner routes (owner, or ENGINEER staff
 * unless `allowStaff: false`). With `workspaceParam`, the URL's workspace
 * must be the caller's own.
 *
 *   preHandler: [fastify.verifyAccessToken, ownerRequired({ workspaceParam: "id" })]
 *
 * Replies 401 without a signed-in user and 403 `{ error: "forbidden",
 * required: "ADMIN" }` otherwise (the body clients already know).
 */
export function ownerRequired(opts: { allowStaff?: boolean; workspaceParam?: string } = {}) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const me = asUser(req.current);
    if (!me) return reply.status(401).send({ error: "Unauthorized" });

    const params = req.params as Record<string, string | undefined> | undefined;
    const sameWorkspace = !opts.workspaceParam || params?.[opts.workspaceParam] === me.workspaceId;
    const owner = me.access.person.owner || (opts.allowStaff !== false && me.access.person.staff === "ENGINEER");
    if (!sameWorkspace || !owner) {
      return reply.status(403).send({ error: "forbidden", required: "ADMIN" });
    }
  };
}
