import { z } from "zod";
import type { ActionContext, ActionDefinition, IntegrationType } from "./types.js";

// The secret's shape depends on config.authType, so it is a discriminated union
// and `validate` keeps the two in agreement.

const configSchema = z.object({
  baseUrl: z.url(),
  authType: z.enum(["none", "bearer", "apiKey", "basic"]),
  // apiKey only: which header carries the key.
  headerName: z.string().min(1).default("x-api-key"),
  defaultHeaders: z.record(z.string(), z.string()).default({}),
  timeoutMs: z.number().int().min(1_000).max(120_000).default(30_000),
});

const secretSchema = z.discriminatedUnion("authType", [
  z.object({ authType: z.literal("none") }),
  z.object({ authType: z.literal("bearer"), token: z.string().min(1) }),
  z.object({ authType: z.literal("apiKey"), apiKey: z.string().min(1) }),
  z.object({ authType: z.literal("basic"), username: z.string().min(1), password: z.string().min(1) }),
]);

export type RestConfig = z.infer<typeof configSchema>;
export type RestSecret = z.infer<typeof secretSchema>;

const requestInputSchema = z.object({
  path: z.string().default("/"),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("POST"),
  query: z.record(z.string(), z.string()).default({}),
  headers: z.record(z.string(), z.string()).default({}),
  body: z.unknown().optional(),
});

type RequestInput = z.infer<typeof requestInputSchema>;

export interface RestResponse {
  status: number;
  ok: boolean;
  body: unknown;
}

function authHeaders(config: RestConfig, secret: RestSecret): Record<string, string> {
  switch (secret.authType) {
    case "bearer":
      return { authorization: `Bearer ${secret.token}` };
    case "apiKey":
      return { [config.headerName]: secret.apiKey };
    case "basic": {
      const encoded = Buffer.from(`${secret.username}:${secret.password}`, "utf8").toString("base64");
      return { authorization: `Basic ${encoded}` };
    }
    case "none":
      return {};
  }
}

async function runRequest(input: RequestInput, context: ActionContext<RestConfig, RestSecret>): Promise<RestResponse> {
  const { config, secret } = context;
  // Explicit concatenation: new URL("/x", base) drops base's path prefix.
  const base = config.baseUrl.replace(/\/+$/, "");
  const url = new URL(input.path.startsWith("/") ? `${base}${input.path}` : `${base}/${input.path}`);
  for (const [key, value] of Object.entries(input.query)) url.searchParams.set(key, value);

  const headers: Record<string, string> = {
    ...config.defaultHeaders,
    ...authHeaders(config, secret),
    ...input.headers,
  };

  const hasBody = input.body !== undefined && input.method !== "GET" && input.method !== "DELETE";
  if (hasBody && !headers["content-type"]) headers["content-type"] = "application/json";

  const response = await fetch(url, {
    method: input.method,
    headers,
    body: hasBody ? JSON.stringify(input.body) : undefined,
    signal: context.signal ?? AbortSignal.timeout(config.timeoutMs),
  });

  const text = await response.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // Non-JSON response — keep the raw text.
  }

  if (!response.ok) {
    throw new Error(`${input.method} ${url.pathname} failed with status ${response.status}: ${text.slice(0, 300)}`);
  }

  return { status: response.status, ok: response.ok, body };
}

const request: ActionDefinition<RestConfig, RestSecret> = {
  key: "request",
  displayName: "HTTP Request",
  description: "Send an authenticated HTTP request to the configured API.",
  latest: "1",
  versions: {
    "1": {
      inputSchema: requestInputSchema,
      run: (input, context) => runRequest(input as RequestInput, context),
    },
  },
};

export const restIntegration: IntegrationType<RestConfig, RestSecret> = {
  type: "rest",
  displayName: "REST API",
  description: "Call an HTTP API endpoint with stored credentials.",
  execution: "server",
  configSchema,
  secretSchema,
  validate: (config, secret) =>
    config.authType === secret.authType
      ? null
      : `Secret auth type (${secret.authType}) does not match config auth type (${config.authType})`,
  actions: [request],
};
