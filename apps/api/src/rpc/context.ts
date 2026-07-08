import type { AppIAMContext, DisplayIAMContext, IAMContext, UserIAMContext } from "@rw/auth/context";

export interface RPCRequest {
  headers: {
    authorization?: string | string[];
  };
}

// Base context provided to all procedures
export interface RPCContext {
  request: RPCRequest;
  iam?: IAMContext;
}

// Context after user auth middleware runs
export interface UserAuthenticatedRPCContext extends RPCContext {
  iam: UserIAMContext;
}

// Context after display auth middleware runs
export interface DisplayAuthenticatedRPCContext extends RPCContext {
  iam: DisplayIAMContext;
}

// Context after any principal auth middleware runs
export interface PrincipalAuthenticatedRPCContext extends RPCContext {
  iam: UserIAMContext | DisplayIAMContext;
}

// Context after graph-read auth middleware runs: the only surface that also
// admits APP (customer API token) principals, read-only and site-scoped.
export interface GraphReadRPCContext extends RPCContext {
  iam: UserIAMContext | DisplayIAMContext | AppIAMContext;
}
