import type { z } from "zod";

// An integration is a configured outbound target; the type declares its shape,
// a stored Integration row supplies the values.

export type IntegrationResult<T> = { data: T } | { error: string; code: string };

export function errorResult(code: string, error: string): { error: string; code: string } {
  return { error, code };
}

// All "server" today: rw-server is provisioned onto the plant network on-prem.
// "edge" is reserved for gateway-dispatched types; nothing uses it yet.
export type ExecutionLocation = "server" | "edge";

export interface IntegrationRef {
  id: string;
  type: string;
  name: string;
}

export interface ActionContext<TConfig = unknown, TSecret = unknown> {
  integration: IntegrationRef;
  config: TConfig;
  secret: TSecret;
  signal?: AbortSignal;
}

export interface ActionVersion<TConfig = unknown, TSecret = unknown> {
  inputSchema: z.ZodType;
  // Optional so an edge type can declare a contract with the executor elsewhere.
  run?: (input: unknown, context: ActionContext<TConfig, TSecret>) => Promise<unknown>;
}

export interface ActionDefinition<TConfig = unknown, TSecret = unknown> {
  key: string;
  displayName: string;
  description: string;
  latest: string;
  versions: Record<string, ActionVersion<TConfig, TSecret>>;
}

export interface IntegrationType<TConfig = unknown, TSecret = unknown> {
  type: string;
  displayName: string;
  description: string;
  execution: ExecutionLocation;
  // Plaintext: host, port, base URL, username. Readable by the console, safe to log.
  configSchema: z.ZodType<TConfig>;
  // Encrypted (crypto.ts). Every field is a secret, so redaction needs no allowlist.
  secretSchema: z.ZodType<TSecret>;
  // Cross-field checks one schema can't express (see rest.ts). Message or null.
  validate?: (config: TConfig, secret: TSecret) => string | null;
  actions: readonly ActionDefinition<TConfig, TSecret>[];
}

// Stored erased; `register` casts once so authors keep inference in their file.
export type AnyIntegrationType = IntegrationType<unknown, unknown>;
