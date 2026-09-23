import type { Access } from "@rw/auth/iam/access";
import type { Current } from "@rw/auth/context";

export interface RPCRequest {
  headers: {
    authorization?: string | string[];
  };
}

// Base context provided to all procedures
export interface RPCContext {
  request: RPCRequest;
  /** Who is calling; null when anonymous. */
  current: Current | null;
  /** May the caller do this? Throws AccessDenied when not. */
  access: Access;
}

/** Context once a middleware has admitted only these kinds of caller. */
export type CallerContext<K extends Current["kind"]> = RPCContext & {
  current: Extract<Current, { kind: K }>;
  access: Extract<Current, { kind: K }>["access"];
};
