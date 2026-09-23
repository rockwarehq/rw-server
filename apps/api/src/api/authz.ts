import type { FastifyReply, FastifyRequest } from "fastify";
import { asUser, type UserCurrent } from "@rw/auth/context";
import { AccessDenied } from "@rw/auth/iam/access";

/** The signed-in user on a route behind verifyAccessToken (401 otherwise). */
export function currentUser(request: FastifyRequest): UserCurrent {
  const me = asUser(request.current);
  if (!me) throw new AccessDenied("UNAUTHENTICATED", "Authentication required");
  return me;
}

/**
 * REST replies for access denials. Bodies match the pre-policy hand-rolled
 * responses in the route files: bare "forbidden" (no tier echo), "No
 * workspace context" as 401. Wired once as the server's error handler.
 */
export function replyAccessDenied(reply: FastifyReply, denial: AccessDenied): FastifyReply {
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
