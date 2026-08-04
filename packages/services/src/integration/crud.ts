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

async function assertSite(scope: IntegrationScope) {
  const site = await prisma.site.findUnique({ where: { id: scope.siteId }, select: { workspaceId: true } });
  if (!site) return errorResult("SITE_NOT_FOUND", "Site not found");
  if (site.workspaceId !== scope.workspaceId) {
    return errorResult("WORKSPACE_MISMATCH", "Site does not belong to this workspace");
  }
  return null;
}

async function loadForMutation(id: string, scope: IntegrationScope) {
  const current = await prisma.integration.findUnique({
    where: { id },
    select: { ...publicSelect, secretCipher: true, site: { select: { workspaceId: true } } },
  });
  if (!current || current.isDeleted) return errorResult("INTEGRATION_NOT_FOUND", "Integration not found");
  if (current.site.workspaceId !== scope.workspaceId) {
    return errorResult("WORKSPACE_MISMATCH", "Integration does not belong to this workspace");
  }
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

  const row = existing
    ? await prisma.integration.update({ where: { id: existing.id }, data, select: publicSelect })
    : await prisma.integration.create({ data: { id: rowId, ...data }, select: publicSelect });

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

  const row = await prisma.integration.update({ where: { id }, data, select: publicSelect });

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
  await prisma.integration.update({ where: { id }, data: { isDeleted: true, secretCipher: null } });
  await closeSqlServerPools(id);

  return { data: { success: true as const } };
}

export async function getById(id: string, scope: IntegrationScope) {
  const loaded = await loadForMutation(id, scope);
  if ("error" in loaded) return loaded;
  const { secretCipher, site: _site, ...row } = loaded.current;
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
