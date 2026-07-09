import { ORPCError } from "@orpc/server";

// Single place where service-layer error codes become oRPC transport errors.
// Services never throw — they return { error, code } (see ADR-0003); RPC
// handlers map that to an ORPCError here.
//
// Resolution order: per-call overrides → exact table → suffix heuristics →
// BAD_REQUEST. The exact table encodes the mappings the routers used before
// this helper existed; `overrides` exists so a router can pin a divergent
// historical mapping without changing the shared default —
// @rockwarehq/rpc-client is published, so observable error codes are API.

export type ServiceError = { error: string; code: string };

export type OrpcErrorCode =
  | "BAD_REQUEST"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "INTERNAL_SERVER_ERROR";

export type CodeOverrides = Record<string, OrpcErrorCode>;

const EXACT: Record<string, OrpcErrorCode> = {
  NOT_FOUND: "NOT_FOUND",
  // Soft-deleted resources read as absent…
  ALREADY_DELETED: "NOT_FOUND",
  JOB_DELETED: "NOT_FOUND",
  PRODUCT_DELETED: "NOT_FOUND",
  TOOL_DELETED: "NOT_FOUND",
  CAVITY_DELETED: "NOT_FOUND",
  ITEM_DELETED: "NOT_FOUND",
  INVENTORY_ITEM_DELETED: "NOT_FOUND",
  DASHBOARD_DELETED: "NOT_FOUND",
  NOT_LINKED: "NOT_FOUND",
  NOT_IN_GROUP: "NOT_FOUND",
  PICTURE_MISMATCH: "NOT_FOUND",

  FORBIDDEN: "FORBIDDEN",
  WORKSPACE_MISMATCH: "FORBIDDEN",
  SITE_NOT_IN_WORKSPACE: "FORBIDDEN",

  CONFLICT: "CONFLICT",
  // …while scope mismatches on live resources are conflicts by default
  // (entity/graph routers historically used FORBIDDEN — they pin overrides).
  SITE_MISMATCH: "CONFLICT",
  TOOL_SITE_MISMATCH: "CONFLICT",
  WORKCENTER_MISMATCH: "CONFLICT",
  DEFINITION_PATTERN_MISMATCH: "CONFLICT",
  NOT_ARCHIVED: "CONFLICT",
  IN_OTHER_GROUP: "CONFLICT",
  LABEL_CONFLICT: "CONFLICT",
  VERSION_CONFLICT: "CONFLICT",
  GRAPH_CYCLE: "CONFLICT",
  CIRCULAR_REFERENCE: "CONFLICT",
  PATTERN_ASSIGNED: "CONFLICT",
  NO_CURRENT_BLOB: "CONFLICT",
  NEEDS_ACTIVE_SWAP: "CONFLICT",
  MAX_PICTURES_REACHED: "CONFLICT",
  REPLACEMENT_IS_SELF: "CONFLICT",
  REPLACEMENT_NOT_IN_GROUP: "CONFLICT",
  INVALID_STATE: "CONFLICT",
  STATION_EVENT_DISABLED: "CONFLICT",
  DOCUMENT_PENDING: "CONFLICT",
  INVALID_PARENT: "CONFLICT",

  EXECUTION_ENQUEUE_FAILED: "INTERNAL_SERVER_ERROR",
  INTERNAL_SERVER_ERROR: "INTERNAL_SERVER_ERROR",
};

export function mapServiceCode(code: string, overrides?: CodeOverrides): OrpcErrorCode {
  const pinned = overrides?.[code];
  if (pinned) return pinned;
  const exact = EXACT[code];
  if (exact) return exact;
  if (code.endsWith("_NOT_FOUND")) return "NOT_FOUND";
  if (
    code.endsWith("_EXISTS") ||
    code.includes("HAS_") ||
    code.startsWith("DUPLICATE_") ||
    code.startsWith("ALREADY_")
  ) {
    return "CONFLICT";
  }
  return "BAD_REQUEST";
}

export function throwServiceError(err: ServiceError, overrides?: CodeOverrides): never {
  throw new ORPCError(mapServiceCode(err.code, overrides), { message: err.error, cause: err });
}

/**
 * Unwrap a service result: return the data, throw a mapped ORPCError on
 * { error, code }, throw NOT_FOUND on null/undefined.
 */
export function unwrap<T>(
  result: { data: T } | ServiceError | null | undefined,
  opts?: { notFoundMessage?: string; overrides?: CodeOverrides },
): T {
  if (!result) throw new ORPCError("NOT_FOUND", { message: opts?.notFoundMessage ?? "Resource not found" });
  if ("error" in result) throwServiceError(result, opts?.overrides);
  return result.data;
}
