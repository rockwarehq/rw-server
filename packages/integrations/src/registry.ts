import type { ZodIssue } from "zod";
import {
  errorResult,
  type ActionDefinition,
  type ActionVersion,
  type AnyIntegrationType,
  type IntegrationResult,
  type IntegrationType,
} from "./types.js";

export interface ValidationIssue {
  path: string;
  message: string;
}

export interface IntegrationRegistry {
  register<TConfig, TSecret>(type: IntegrationType<TConfig, TSecret>): IntegrationRegistry;
  get(type: string): AnyIntegrationType | undefined;
  list(): AnyIntegrationType[];
  types(): string[];
  getAction(type: string, actionKey: string): ActionDefinition<unknown, unknown> | undefined;
  getActionVersion(type: string, actionKey: string, version?: string): ActionVersion<unknown, unknown> | undefined;
  /** Validates config + secret together, including the type's cross-field `validate`. */
  validateSettings(
    type: string,
    config: unknown,
    secret: unknown,
  ): IntegrationResult<{ config: unknown; secret: unknown }>;
  validateActionInput(
    type: string,
    actionKey: string,
    version: string | undefined,
    input: unknown,
  ): IntegrationResult<unknown>;
}

function issuePath(path: ReadonlyArray<PropertyKey>): string {
  return path.length === 0 ? "/" : `/${path.map(String).join("/")}`;
}

function toIssues(issues: readonly ZodIssue[] | undefined): ValidationIssue[] {
  return (issues ?? []).map((issue) => ({ path: issuePath(issue.path), message: issue.message }));
}

// Zod issues are flattened into the message so the { error, code } contract
// (ADR-0003) survives unchanged out to the transport layer.
function invalid(code: string, label: string, issues: readonly ZodIssue[] | undefined) {
  const detail = toIssues(issues)
    .map((issue) => `${issue.path}: ${issue.message}`)
    .join("; ");
  return errorResult(code, detail ? `${label}: ${detail}` : label);
}

export function createIntegrationRegistry(): IntegrationRegistry {
  const types = new Map<string, AnyIntegrationType>();

  function requireType(type: string): AnyIntegrationType | undefined {
    return types.get(type);
  }

  const registry: IntegrationRegistry = {
    register(type) {
      if (types.has(type.type)) throw new Error(`Integration type already registered: ${type.type}`);
      types.set(type.type, type as unknown as AnyIntegrationType);
      return registry;
    },

    get(type) {
      return types.get(type);
    },

    list() {
      return [...types.values()];
    },

    types() {
      return [...types.keys()];
    },

    getAction(type, actionKey) {
      return requireType(type)?.actions.find((action) => action.key === actionKey);
    },

    getActionVersion(type, actionKey, version) {
      const action = registry.getAction(type, actionKey);
      if (!action) return undefined;
      return action.versions[version ?? action.latest];
    },

    validateSettings(type, config, secret) {
      const definition = requireType(type);
      if (!definition) return errorResult("UNKNOWN_INTEGRATION_TYPE", `Unknown integration type: ${type}`);

      const parsedConfig = definition.configSchema.safeParse(config);
      if (!parsedConfig.success) {
        return invalid("INTEGRATION_CONFIG_INVALID", `Invalid config for ${type}`, parsedConfig.error.issues);
      }

      const parsedSecret = definition.secretSchema.safeParse(secret);
      if (!parsedSecret.success) {
        return invalid("INTEGRATION_SECRET_INVALID", `Invalid secret for ${type}`, parsedSecret.error.issues);
      }

      const crossCheck = definition.validate?.(parsedConfig.data, parsedSecret.data);
      if (crossCheck) return errorResult("INTEGRATION_SETTINGS_INVALID", crossCheck);

      return { data: { config: parsedConfig.data, secret: parsedSecret.data } };
    },

    validateActionInput(type, actionKey, version, input) {
      const definition = requireType(type);
      if (!definition) return errorResult("UNKNOWN_INTEGRATION_TYPE", `Unknown integration type: ${type}`);

      const action = definition.actions.find((candidate) => candidate.key === actionKey);
      if (!action) {
        return errorResult("UNKNOWN_INTEGRATION_ACTION", `Unknown action for ${type}: ${actionKey}`);
      }

      const resolved = version ?? action.latest;
      const actionVersion = action.versions[resolved];
      if (!actionVersion) {
        const known = Object.keys(action.versions).join(", ");
        return errorResult(
          "UNKNOWN_ACTION_VERSION",
          `Unknown version for ${type}.${actionKey}: ${resolved} (known: ${known})`,
        );
      }

      const parsed = actionVersion.inputSchema.safeParse(input);
      if (!parsed.success) {
        return invalid("ACTION_INPUT_INVALID", `Invalid input for ${type}.${actionKey}`, parsed.error.issues);
      }

      return { data: parsed.data };
    },
  };

  return registry;
}
