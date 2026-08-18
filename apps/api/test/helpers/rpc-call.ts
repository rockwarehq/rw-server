import type { TestServer } from "./build-server.js";

/**
 * Invoke an oRPC procedure over HTTP via server.inject.
 *
 * The RPC protocol wraps both request and response in a `{ json, meta? }`
 * envelope (StandardRPCSerializer). Plain-JSON inputs need no meta; response
 * `json` is returned as-is, so callers assert on statusCode + json.
 */
export async function rpcCall(
  server: TestServer,
  path: string,
  input: unknown,
  token?: string,
): Promise<{ statusCode: number; json: unknown }> {
  const response = await server.inject({
    method: "POST",
    url: `/rpc/${path}`,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    payload: JSON.stringify({ json: input }),
  });

  let json: unknown;
  try {
    json = (JSON.parse(response.body) as { json?: unknown }).json;
  } catch {
    json = undefined;
  }
  return { statusCode: response.statusCode, json };
}
