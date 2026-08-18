import { ORPCError } from "@orpc/server";
import type { PolicyDenial } from "@rw/auth/iam/policy";

// oRPC transport mapping for policy denials. Wire codes preserve the
// pre-policy-layer behavior (observable error codes are API — ADR-0003):
// missing workspace context was BAD_REQUEST, permission failures FORBIDDEN.
const DENIAL_CODES = {
  UNAUTHENTICATED: "UNAUTHORIZED",
  NO_WORKSPACE: "BAD_REQUEST",
  NOT_FOUND: "NOT_FOUND",
  FORBIDDEN: "FORBIDDEN",
} as const;

/** Unwrap a policy result: return the grant or throw the mapped ORPCError. */
export function grant<T extends { ok: true }>(result: T | PolicyDenial): T {
  if (result.ok) return result;
  throw new ORPCError(DENIAL_CODES[result.code], { message: result.message });
}
