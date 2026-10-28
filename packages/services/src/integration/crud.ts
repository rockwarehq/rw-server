import { randomUUID } from "node:crypto";
import prisma from "@rw/db";
import type { Prisma } from "@rw/db";
import {
  closeSqlServerPools,
  createDefaultIntegrationRegistry,
  encryptionKeyConfigured,
  openSecret,
  sealSecret,
  type IntegrationRegistry,
} from "@rw/integrations";
import { auditRecord } from "../audit/index.js";

// Site-scoped outbound integrations (ADR 0003 error contract). @rw/integrations
// owns config/secret shape; this owns storage, sealing, and redaction.

const registry: IntegrationRegistry = createDefaultIntegrationRegistry();

export interface IntegrationScope {
  workspaceId: string;
  siteId: string;
}

export interface CreateIntegrationInput {
  name: string;
  type: string;
  enabled?: boolean;
  config: Record<string, unknown>;
  secret?: Record<string, unknown>;
}

export interface UpdateIntegrationInput {
  name?: string;
  enabled?: boolean;
  config?: Record<string, unknown>;
  // Omit keeps the stored secret, null clears it, an object replaces it.
  secret?: Record<string, unknown> | null;
}

// Never includes secretCipher: redaction is structural, not per-handler.
const publicSelect = {
  id: true,
  siteId: true,
  name: true,
  type: true,
  enabled: true,
  config: true,
  isDeleted: true,
  createdAt: true,
  updatedAt: true,
} as const;

type PublicIntegration = Prisma.IntegrationGetPayload<{ select: typeof publicSelect }>;

export type IntegrationView = PublicIntegration & { hasSecret: boolean };

function errorResult(code: string, error: string) {
  return { error, code };
}

function toView(row: PublicIntegration, hasSecret: boolean): IntegrationView {
  return { ...row, hasSecret };
}

// Config keys safe to show in the audit trail. URLs and headers stay out: a
// webhook URL or a default header can itself be a credential.
const AUDITED_CONFIG_KEYS = [
  "authType",
  "headerName",
  "method",
  "signatureHeader",
  "host",
  "port",
  "database",
  "username",
  "encrypt",
  "trustServerCertificate",
  "timeoutMs",
  "connectTimeoutMs",
  "poolMax",
  "idleTimeoutMs",
] as const;

const AUDITED_FIELDS = ["name", "type", "enabled", ...AUDITED_CONFIG_KEYS.map((key) => `config.${key}`)];

function auditValues(row: { name: string; type: string; enabled: boolean; config: unknown }) {
  const config = (row.config ?? {}) as Record<string, unknown>;
  return {
    name: row.name,
    type: row.type,
    enabled: row.enabled,
    ...Object.fromEntries(AUDITED_CONFIG_KEYS.map((key) => [`config.${key}`, config[key]])),
  };
}

function unauditedConfigChanged(before: unknown, after: unknown) {
  const strip = (config: unknown) => {
    const rest = { ...((config ?? {}) as Record<string, unknown>) };
    for (const key of AUDITED_CONFIG_KEYS) delete rest[key];
    return JSON.stringify(Object.entries(rest).sort(([a], [b]) => a.localeCompare(b)));
  };
  return strip(before) !== strip(after);
}

async function assertSite(scope: IntegrationScope) {
  const site = await prisma.site.findUnique({ where: { id: scope.siteId }, select: { id: true } });
  if (!site) return errorResult("SITE_NOT_FOUND", "Site not found");
  return null;
}

async function loadForMutation(id: string, scope: IntegrationScope) {
  const current = await prisma.integration.findUnique({
    where: { id },
    select: { ...publicSelect, secretCipher: true },
  });
  if (!current || current.isDeleted) return errorResult("INTEGRATION_NOT_FOUND", "Integration not found");
  if (current.siteId !== scope.siteId) {
    return errorResult("SITE_MISMATCH", "Integration does not belong to this site");
  }
  return { current };
}

// Services never throw (ADR-0003): a missing/invalid key becomes {error, code}.
function sealOrError(secret: Record<string, unknown>, id: string) {
  if (!encryptionKeyConfigured()) {
    return errorResult("ENCRYPTION_KEY_MISSING", "INTEGRATION_ENCRYPTION_KEY is not configured");
  }
  try {
    return { data: sealSecret(secret, id) };
  } catch (err) {
    return errorResult("SECRET_SEAL_FAILED", err instanceof Error ? err.message : "Secret could not be sealed");
  }
}

export async function create(input: CreateIntegrationInput, scope: IntegrationScope) {
  const siteError = await assertSite(scope);
  if (siteError) return siteError;

  const name = input.name.trim();
  if (!name) return errorResult("INVALID_NAME", "Integration name is required");

  const definition = registry.get(input.type);
  if (!definition) return errorResult("UNKNOWN_INTEGRATION_TYPE", `Unknown integration type: ${input.type}`);

  const settings = registry.validateSettings(input.type, input.config, input.secret ?? {});
  if ("error" in settings) return settings;

  const existing = await prisma.integration.findUnique({
    where: { siteId_name: { siteId: scope.siteId, name } },
    select: { id: true, isDeleted: true },
  });
  if (existing && !existing.isDeleted) {
    return errorResult("INTEGRATION_NAME_EXISTS", "Integration name already exists");
  }

  // Id chosen up front so the AAD-bound seal happens before the single write.
  const rowId = existing?.id ?? randomUUID();
  const hasSecret = Boolean(input.secret && Object.keys(input.secret).length > 0);
  let secretCipher: Uint8Array<ArrayBuffer> | null = null;
  if (hasSecret && input.secret) {
    const sealed = sealOrError(input.secret, rowId);
    if ("error" in sealed) return sealed;
    secretCipher = sealed.data;
  }

  const data = {
    siteId: scope.siteId,
    name,
    type: input.type,
    enabled: input.enabled ?? true,
    config: input.config as Prisma.InputJsonValue,
    isDeleted: false,
    secretCipher,
  };

  const row = await prisma.$transaction(async (tx) => {
    const written = existing
      ? await tx.integration.update({ where: { id: existing.id }, data, select: publicSelect })
      : await tx.integration.create({ data: { id: rowId, ...data }, select: publicSelect });
    await auditRecord(tx, {
      change: "created",
      entityType: "integration",
      entityId: written.id,
      siteId: scope.siteId,
      workspaceId: scope.workspaceId,
      label: written.name,
      after: auditValues(written),
      fields: AUDITED_FIELDS,
      metadata: hasSecret ? { credentialsChanged: true } : undefined,
    });
    return written;
  });

  return { data: toView(row, hasSecret) };
}

export async function update(id: string, input: UpdateIntegrationInput, scope: IntegrationScope) {
  const loaded = await loadForMutation(id, scope);
  if ("error" in loaded) return loaded;
  const { current } = loaded;

  // Validate merged: a config edit must still agree with the stored secret.
  const nextConfig = input.config ?? (current.config as Record<string, unknown>);
  let nextSecret: Record<string, unknown>;
  try {
    if (input.secret === null) nextSecret = {};
    else if (input.secret) nextSecret = input.secret;
    else nextSecret = current.secretCipher ? openSecret(current.secretCipher, id) : {};
  } catch (err) {
    return errorResult(
      "INTEGRATION_SECRET_UNREADABLE",
      err instanceof Error ? err.message : "Stored secret could not be opened",
    );
  }

  const settings = registry.validateSettings(current.type, nextConfig, nextSecret);
  if ("error" in settings) return settings;

  const data: Prisma.IntegrationUpdateInput = {};
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) return errorResult("INVALID_NAME", "Integration name is required");
    if (name !== current.name) {
      const conflict = await prisma.integration.findUnique({
        where: { siteId_name: { siteId: scope.siteId, name } },
        select: { id: true },
      });
      if (conflict) return errorResult("INTEGRATION_NAME_EXISTS", "Integration name already exists");
    }
    data.name = name;
  }
  if (input.enabled !== undefined) data.enabled = input.enabled;
  if (input.config !== undefined) data.config = input.config as Prisma.InputJsonValue;
  if (input.secret === null) data.secretCipher = null;
  else if (input.secret) {
    const sealed = sealOrError(input.secret, id);
    if ("error" in sealed) return sealed;
    data.secretCipher = sealed.data;
  }

  const row = await prisma.$transaction(async (tx) => {
    const written = await tx.integration.update({ where: { id }, data, select: publicSelect });
    const credentialsChanged = input.secret !== undefined;
    const configChanged = unauditedConfigChanged(current.config, written.config);
    await auditRecord(tx, {
      change: "updated",
      entityType: "integration",
      entityId: id,
      siteId: scope.siteId,
      workspaceId: scope.workspaceId,
      label: written.name,
      before: auditValues(current),
      after: auditValues(written),
      fields: AUDITED_FIELDS,
      metadata:
        credentialsChanged || configChanged
          ? { ...(credentialsChanged ? { credentialsChanged } : {}), ...(configChanged ? { configChanged } : {}) }
          : undefined,
    });
    return written;
  });

  // Connection details may have changed under a live pool.
  await closeSqlServerPools(id);

  const hasSecret = input.secret === null ? false : Boolean(input.secret) || Boolean(current.secretCipher);
  return { data: toView(row, hasSecret) };
}

export async function remove(id: string, scope: IntegrationScope) {
  const loaded = await loadForMutation(id, scope);
  if ("error" in loaded) return loaded;

  const triggers = await prisma.integrationTrigger.count({ where: { integrationId: id, isDeleted: false } });
  if (triggers > 0) {
    return errorResult("INTEGRATION_HAS_TRIGGERS", `Integration is used by ${triggers} trigger(s)`);
  }

  // Secret is dropped on delete rather than left sealed in a dead row.
  await prisma.$transaction(async (tx) => {
    await tx.integration.update({ where: { id }, data: { isDeleted: true, secretCipher: null } });
    await auditRecord(tx, {
      change: "deleted",
      entityType: "integration",
      entityId: id,
      siteId: scope.siteId,
      workspaceId: scope.workspaceId,
      label: loaded.current.name,
      fields: [],
    });
  });
  await closeSqlServerPools(id);

  return { data: { success: true as const } };
}

export async function getById(id: string, scope: IntegrationScope) {
  const loaded = await loadForMutation(id, scope);
  if ("error" in loaded) return loaded;
  const { secretCipher, ...row } = loaded.current;
  return { data: toView(row, Boolean(secretCipher)) };
}

export interface ListIntegrationsFilter {
  type?: string;
  enabled?: boolean;
  limit?: number;
  offset?: number;
}

export async function list(filter: ListIntegrationsFilter, scope: IntegrationScope) {
  const { type, enabled, limit = 50, offset = 0 } = filter;
  const where = {
    isDeleted: false,
    siteId: scope.siteId,
    site: { workspaceId: scope.workspaceId },
    ...(type ? { type } : {}),
    ...(enabled !== undefined ? { enabled } : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.integration.findMany({
      where,
      select: { ...publicSelect, secretCipher: true },
      take: limit > 0 ? limit : undefined,
      skip: offset,
      orderBy: { name: "asc" },
    }),
    prisma.integration.count({ where }),
  ]);

  const data = rows.map(({ secretCipher, ...row }) => toView(row, Boolean(secretCipher)));
  return { data, total, limit, offset };
}

/** Opens the stored secret. The one caller-facing path that touches ciphertext. */
export async function loadForExecution(id: string) {
  const row = await prisma.integration.findUnique({
    where: { id },
    select: { id: true, type: true, name: true, config: true, secretCipher: true, enabled: true, isDeleted: true },
  });
  if (!row || row.isDeleted) return errorResult("INTEGRATION_NOT_FOUND", "Integration not found");
  if (!row.enabled) return errorResult("INTEGRATION_DISABLED", "Integration is disabled");
  return { data: row };
}
