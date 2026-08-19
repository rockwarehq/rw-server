import type { FastifyReply } from "fastify";
import type { PolicyDenial } from "@rw/auth/iam/policy";

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
