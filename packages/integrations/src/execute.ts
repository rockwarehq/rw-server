import { openSecret } from "./crypto.js";
import type { IntegrationRegistry } from "./registry.js";
import { errorResult, type ActionContext, type IntegrationResult } from "./types.js";

// A stored integration, as the service layer reads it. `secretCipher` is the
// only field that ever holds plaintext-derived data, and it is opened here and
// nowhere else.
export interface IntegrationRecord {
  id: string;
  type: string;
  name: string;
  config: unknown;
  secretCipher: Uint8Array | null;
}

export interface ExecuteOptions {
  signal?: AbortSignal;
}

/**
 * Run one action against one stored integration, in this process. No built-in
 * type needs dispatching elsewhere today; a type that declares itself "edge"
 * without a `run` gets EDGE_EXECUTION_REQUIRED rather than a confusing crash.
 */
export async function executeAction(
  registry: IntegrationRegistry,
  record: IntegrationRecord,
  actionKey: string,
  version: string | undefined,
  input: unknown,
  options: ExecuteOptions = {},
): Promise<IntegrationResult<unknown>> {
  const definition = registry.get(record.type);
  if (!definition) {
    return errorResult("UNKNOWN_INTEGRATION_TYPE", `Unknown integration type: ${record.type}`);
  }

  let secret: Record<string, unknown>;
  try {
    secret = record.secretCipher ? openSecret(record.secretCipher, record.id) : {};
  } catch (err) {
    return errorResult(
      "INTEGRATION_SECRET_UNREADABLE",
      err instanceof Error ? err.message : "Integration secret could not be opened",
    );
  }

  const settings = registry.validateSettings(record.type, record.config, secret);
  if ("error" in settings) return settings;

  const parsedInput = registry.validateActionInput(record.type, actionKey, version, input);
  if ("error" in parsedInput) return parsedInput;

  const actionVersion = registry.getActionVersion(record.type, actionKey, version);
  if (!actionVersion) {
    return errorResult("UNKNOWN_INTEGRATION_ACTION", `Unknown action for ${record.type}: ${actionKey}`);
  }

  if (!actionVersion.run) {
    return errorResult(
      "EDGE_EXECUTION_REQUIRED",
      `${record.type}.${actionKey} declares edge execution and cannot run in this process`,
    );
  }

  const context: ActionContext = {
    integration: { id: record.id, type: record.type, name: record.name },
    config: settings.data.config,
    secret: settings.data.secret,
    signal: options.signal,
  };

  try {
    return { data: await actionVersion.run(parsedInput.data, context) };
  } catch (err) {
    return errorResult(
      "INTEGRATION_ACTION_FAILED",
      err instanceof Error ? err.message : `${record.type}.${actionKey} failed`,
    );
  }
}
