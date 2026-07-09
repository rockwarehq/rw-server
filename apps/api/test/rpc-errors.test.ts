import { ORPCError } from "@orpc/server";
import { describe, expect, it } from "vitest";
import { mapServiceCode, throwServiceError, unwrap } from "../src/rpc/errors.js";

describe("mapServiceCode", () => {
  it("maps exact codes", () => {
    expect(mapServiceCode("NOT_FOUND")).toBe("NOT_FOUND");
    expect(mapServiceCode("WORKSPACE_MISMATCH")).toBe("FORBIDDEN");
    expect(mapServiceCode("SITE_NOT_IN_WORKSPACE")).toBe("FORBIDDEN");
    expect(mapServiceCode("SITE_MISMATCH")).toBe("CONFLICT");
    expect(mapServiceCode("GRAPH_CYCLE")).toBe("CONFLICT");
    expect(mapServiceCode("VERSION_CONFLICT")).toBe("CONFLICT");
    expect(mapServiceCode("EXECUTION_ENQUEUE_FAILED")).toBe("INTERNAL_SERVER_ERROR");
  });

  it("soft-deleted resources read as NOT_FOUND only for the pinned codes", () => {
    expect(mapServiceCode("JOB_DELETED")).toBe("NOT_FOUND");
    expect(mapServiceCode("ALREADY_DELETED")).toBe("NOT_FOUND");
    // Codes outside the exact table fall through to BAD_REQUEST — this is
    // the historical entity/graph behavior for e.g. SCHEMA_DELETED.
    expect(mapServiceCode("SCHEMA_DELETED")).toBe("BAD_REQUEST");
    expect(mapServiceCode("GRAPH_NODE_DELETED")).toBe("BAD_REQUEST");
  });

  it("applies suffix heuristics for unknown codes", () => {
    expect(mapServiceCode("WIDGET_NOT_FOUND")).toBe("NOT_FOUND");
    expect(mapServiceCode("WIDGET_NAME_EXISTS")).toBe("CONFLICT");
    expect(mapServiceCode("HAS_WIDGETS")).toBe("CONFLICT");
    expect(mapServiceCode("GRAPH_NODE_HAS_HOOKS")).toBe("CONFLICT");
    expect(mapServiceCode("DUPLICATE_NAME")).toBe("CONFLICT");
    expect(mapServiceCode("ALREADY_CLAIMED")).toBe("CONFLICT");
    expect(mapServiceCode("INVALID_INPUT")).toBe("BAD_REQUEST");
    expect(mapServiceCode("SOMETHING_ELSE")).toBe("BAD_REQUEST");
  });

  it("per-call overrides win over everything", () => {
    expect(mapServiceCode("SITE_MISMATCH", { SITE_MISMATCH: "FORBIDDEN" })).toBe("FORBIDDEN");
    expect(mapServiceCode("HAS_ALLOCATIONS", { HAS_ALLOCATIONS: "BAD_REQUEST" })).toBe("BAD_REQUEST");
  });
});

describe("throwServiceError / unwrap", () => {
  it("throwServiceError raises an ORPCError with message and cause", () => {
    try {
      throwServiceError({ error: "site not found", code: "SITE_NOT_FOUND" });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ORPCError);
      const orpc = err as ORPCError<string, unknown>;
      expect(orpc.code).toBe("NOT_FOUND");
      expect(orpc.message).toBe("site not found");
      expect(orpc.cause).toEqual({ error: "site not found", code: "SITE_NOT_FOUND" });
    }
  });

  it("unwrap returns data, throws NOT_FOUND on null, maps service errors", () => {
    expect(unwrap({ data: 42 })).toBe(42);
    expect(() => unwrap(null)).toThrowError(ORPCError);
    try {
      unwrap({ error: "nope", code: "SITE_MISMATCH" }, { overrides: { SITE_MISMATCH: "FORBIDDEN" } });
      expect.unreachable();
    } catch (err) {
      expect((err as ORPCError<string, unknown>).code).toBe("FORBIDDEN");
    }
  });
});
