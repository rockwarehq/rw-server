import type { FastifyReply, FastifyRequest } from "fastify";
import { asUser } from "@rw/auth/context";

/**
 * Fastify preHandler for account-admin routes (account admin, or ENGINEER
 * staff unless `allowStaff: false`). With `workspaceParam`, the URL's
 * workspace must be the account's.
 *
 *   preHandler: [fastify.verifyAccessToken, accountAdminRequired({ workspaceParam: "id" })]
 *
 * Replies 401 without a signed-in user and 403 `{ error: "forbidden",
 * required: "ADMIN" }` otherwise (the body clients already know).
 */
export function accountAdminRequired(opts: { allowStaff?: boolean; workspaceParam?: string } = {}) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const me = asUser(req.current);
    if (!me) return reply.status(401).send({ error: "Unauthorized" });

    const params = req.params as Record<string, string | undefined> | undefined;
    const sameWorkspace = !opts.workspaceParam || params?.[opts.workspaceParam] === me.workspaceId;
    const admin = me.access.person.accountAdmin || (opts.allowStaff !== false && me.access.person.staff === "ENGINEER");
    if (!sameWorkspace || !admin) {
      return reply.status(403).send({ error: "forbidden", required: "ADMIN" });
    }
  };
}
