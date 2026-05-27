import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import type { AppRouter } from "../../../apps/api/src/rpc/index.js";

export type RpcClient = RouterClient<AppRouter>;

export interface CreateRpcClientOptions {
  baseUrl: string;
  getToken?: () => string | Promise<string> | undefined;
  /** Called on 401 response. Should attempt token refresh and return new token, or undefined if refresh fails. */
  onUnauthorized?: () => Promise<string | undefined>;
  /** Called when auth refresh fails. Should handle redirect to login. */
  onAuthFailure?: () => void;
}

export interface CreateProcessorRpcClientOptions {
  baseUrl: string;
  getSecret?: () => string | Promise<string> | undefined;
}

// Track refresh state to prevent multiple simultaneous refresh attempts
let isRefreshing = false;
let refreshPromise: Promise<string | undefined> | null = null;

export function createRpcClient(options: CreateRpcClientOptions): RouterClient<AppRouter> {
  const link = new RPCLink({
    url: `${options.baseUrl}/rpc`,
    headers: async () => {
      const token = await options.getToken?.();
      return token ? { Authorization: `Bearer ${token}` } : {};
    },
    fetch: async (url, init) => {
      // oRPC passes a Request object as `url`. Clone it before the first
      // fetch so a 401 retry can reuse the original one-time-use body stream.
      const req = url instanceof Request ? url : new Request(url, init);
      const retryReq = req.clone();

      const retryWithToken = (token: string) => {
        const headers = new Headers(retryReq.headers);
        headers.set("Authorization", `Bearer ${token}`);

        return fetch(new Request(retryReq, { headers }), init);
      };

      let response = await fetch(req, init);

      // Handle 401 - attempt token refresh
      if (response.status === 401 && options.onUnauthorized) {
        let newToken: string | undefined;

        if (!isRefreshing) {
          // Start refresh
          isRefreshing = true;
          refreshPromise = options.onUnauthorized();

          try {
            newToken = await refreshPromise;
          } finally {
            isRefreshing = false;
            refreshPromise = null;
          }
        } else if (refreshPromise) {
          // Wait for ongoing refresh
          newToken = await refreshPromise;
        }

        if (newToken) {
          // Retry with new token
          response = await retryWithToken(newToken);
        } else {
          // Refresh failed
          options.onAuthFailure?.();
        }
      }

      return response;
    },
  });

  return createORPCClient(link);
}

export function createProcessorRpcClient(options: CreateProcessorRpcClientOptions): RouterClient<AppRouter> {
  const link = new RPCLink({
    url: `${options.baseUrl}/rpc`,
    headers: async () => {
      const secret = await options.getSecret?.();
      return secret ? { Authorization: `Processor ${secret}` } : {};
    },
  });

  return createORPCClient(link);
}

// Re-export router type for consumers
export type { AppRouter };
