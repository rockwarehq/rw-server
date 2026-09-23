import { os, ORPCError } from "@orpc/server";
import { timingSafeEqual } from "node:crypto";
import { AccessDenied } from "@rw/auth/iam/access";
import type { Current } from "@rw/auth/context";
import { processorConfig } from "../config.js";
import type { CallerContext, RPCContext } from "./context.js";

// Access denials keep their pre-policy wire codes (observable error codes
// are API — ADR-0003): missing workspace context was BAD_REQUEST, missing
// access FORBIDDEN.
const DENIAL_CODES = {
  UNAUTHENTICATED: "UNAUTHORIZED",
  NO_WORKSPACE: "BAD_REQUEST",
  NOT_FOUND: "NOT_FOUND",
  FORBIDDEN: "FORBIDDEN",
} as const;

const mapAccessDenied = os.$context<RPCContext>().middleware(async ({ next }) => {
  try {
    return await next();
  } catch (err) {
    if (err instanceof AccessDenied) {
      throw new ORPCError(DENIAL_CODES[err.code], { message: err.message });
    }
    throw err;
  }
});

// Base procedure builder: every procedure starts here, so AccessDenied is
// mapped once for all of them.
export const publicProcedure = os.$context<RPCContext>().use(mapAccessDenied);

/**
 * Admit only these kinds of caller. APP (customer API token) callers are
 * admitted only on the graph read surface.
 */
function allow<K extends Current["kind"]>(kinds: readonly K[], message = "Authentication required") {
  return publicProcedure.use(async ({ context, next }) => {
    const current = context.current;
    if (!current || !(kinds as readonly string[]).includes(current.kind)) {
      throw new ORPCError("UNAUTHORIZED", { message });
    }
    return next({ context: context as CallerContext<K> });
  });
}

// Signed-in users only
export const userRequired = allow(["user"]);

// A user or a display
export const userOrDisplayRequired = allow(["user", "display"]);

// A user, display, or API token — graph read procedures only
export const graphReadRequired = allow(["user", "display", "app"]);

// Displays only
export const displayRequired = allow(["display"], "Display authentication required");

function safeSecretEquals(expected: string, provided: string) {
  const expectedBuffer = Buffer.from(expected);
  const providedBuffer = Buffer.from(provided);

  if (expectedBuffer.length !== providedBuffer.length) {
    return false;
  }

  return timingSafeEqual(expectedBuffer, providedBuffer);
}

// Processor auth middleware - requires shared secret in Authorization header
const processorMiddleware = os.$context<RPCContext>().middleware(async ({ context, next }) => {
  const authorizationHeader = context.request.headers.authorization;

  if (!authorizationHeader || Array.isArray(authorizationHeader) || !authorizationHeader.startsWith("Processor ")) {
    throw new ORPCError("UNAUTHORIZED", { message: "Processor authorization required" });
  }

  if (!processorConfig.sharedSecret) {
    throw new ORPCError("FORBIDDEN", { message: "Processor ingest is not configured" });
  }

  const providedSecret = authorizationHeader.slice("Processor ".length);
  if (!safeSecretEquals(processorConfig.sharedSecret, providedSecret)) {
    throw new ORPCError("UNAUTHORIZED", { message: "Invalid processor secret" });
  }

  return next();
});

// Requires valid processor shared secret
export const processorRequired = publicProcedure.use(processorMiddleware);
