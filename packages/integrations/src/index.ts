import { createIntegrationRegistry, type IntegrationRegistry } from "./registry.js";
import { restIntegration } from "./rest.js";
import { sqlServerIntegration } from "./sqlserver.js";
import { webhookIntegration } from "./webhook.js";

export { buildIntegrationCatalog } from "./catalog.js";
export type { ActionCatalogEntry, IntegrationCatalogEntry } from "./catalog.js";
export { encryptionKeyConfigured, generateEncryptionKey, openSecret, sealSecret } from "./crypto.js";
export { executeAction } from "./execute.js";
export type { ExecuteOptions, IntegrationRecord } from "./execute.js";
export { createIntegrationRegistry } from "./registry.js";
export type { IntegrationRegistry, ValidationIssue } from "./registry.js";
export { isTemplateBinding, resolveInputTemplate, templateFieldNames } from "./template.js";
export type { TemplateBinding } from "./template.js";
export { errorResult } from "./types.js";
export type {
  ActionContext,
  ActionDefinition,
  ActionVersion,
  AnyIntegrationType,
  ExecutionLocation,
  IntegrationRef,
  IntegrationResult,
  IntegrationType,
} from "./types.js";

export { restIntegration } from "./rest.js";
export type { RestConfig, RestResponse, RestSecret } from "./rest.js";
export { closeSqlServerPools, sqlServerIntegration, SQL_PARAMETER_TYPES } from "./sqlserver.js";
export type { SqlServerConfig, SqlServerExecuteInput, SqlServerSecret } from "./sqlserver.js";
export { webhookIntegration } from "./webhook.js";
export type { WebhookConfig, WebhookSecret } from "./webhook.js";

/** Every integration type this build understands. */
export function createDefaultIntegrationRegistry(): IntegrationRegistry {
  return createIntegrationRegistry()
    .register(sqlServerIntegration)
    .register(restIntegration)
    .register(webhookIntegration);
}
