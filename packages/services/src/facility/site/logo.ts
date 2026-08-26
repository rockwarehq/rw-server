import prisma from "@rw/db";
import * as storage from "@rw/runtime/storage";
import { publishEntityEvent } from "../../entity/events.js";
import { SYSTEM_ENTITY_KEYS } from "../../entity/registry.js";

export interface CreateLogoUploadInput {
  filename: string;
  contentType: string;
  size: number;
}

interface SiteLogoAttr {
  key: string;
  filename: string;
  contentType: string;
  size: number;
}

// The logo lives in site.attrs.logo — attrs is the established schemaless
// settings bag (statusReasonColors, locale, …), so a single-slot logo needs
// no dedicated column.
function parseLogoAttr(attrs: unknown): SiteLogoAttr | null {
  if (!attrs || typeof attrs !== "object") return null;
  const logo = (attrs as Record<string, unknown>).logo;
  if (!logo || typeof logo !== "object") return null;
  const { key } = logo as Record<string, unknown>;
  return typeof key === "string" && key.length > 0 ? (logo as unknown as SiteLogoAttr) : null;
}

function getSiteForLogo(siteId: string) {
  return prisma.site.findUnique({
    where: { id: siteId },
    select: { id: true, workspaceId: true, attrs: true },
  });
}

async function deleteObjectBestEffort(key: string) {
  if (!storage.isStorageEnabled()) return;
  try {
    await storage.deleteObject(key);
  } catch {
    // Best-effort: attrs already point at the new state.
  }
}

/**
 * Start a site logo upload: validates, writes attrs.logo, and returns a
 * presigned PUT URL. Replaces any existing logo (old S3 object deleted
 * best-effort). If the client's PUT fails it should call removeLogo to
 * roll back.
 */
export async function createLogoUpload(siteId: string, input: CreateLogoUploadInput, workspaceId?: string) {
  const { filename, contentType, size } = input;

  if (!storage.isStorageEnabled()) {
    return { error: "Storage is not configured", code: "STORAGE_NOT_CONFIGURED" };
  }

  const validationError = storage.validateUpload(contentType, size);
  if (validationError) {
    return { error: validationError, code: "INVALID_UPLOAD" };
  }

  const site = await getSiteForLogo(siteId);
  if (!site) {
    return { error: "Site not found", code: "SITE_NOT_FOUND" };
  }
  if (workspaceId && site.workspaceId !== workspaceId) {
    return { error: "Unauthorized", code: "WORKSPACE_MISMATCH" };
  }

  const previousLogo = parseLogoAttr(site.attrs);
  const key = storage.generateKey(`site-logo/${siteId}`, filename);
  const attrs = site.attrs && typeof site.attrs === "object" ? (site.attrs as Record<string, unknown>) : {};

  await prisma.site.update({
    where: { id: siteId },
    data: { attrs: { ...attrs, logo: { key, filename, contentType, size } } },
  });

  if (previousLogo) {
    await deleteObjectBestEffort(previousLogo.key);
  }

  publishEntityEvent({
    action: "updated",
    entityKey: SYSTEM_ENTITY_KEYS.Site,
    entityId: siteId,
    siteId,
    workspaceId: site.workspaceId,
    changedFields: ["attrs"],
  });

  const uploadUrl = await storage.getPresignedUploadUrl(key, contentType, size);
  return { data: { uploadUrl, key } };
}

/**
 * Remove the site logo (idempotent): clears attrs.logo and deletes the S3
 * object best-effort.
 */
export async function removeLogo(siteId: string, workspaceId?: string) {
  const site = await getSiteForLogo(siteId);
  if (!site) {
    return { error: "Site not found", code: "SITE_NOT_FOUND" };
  }
  if (workspaceId && site.workspaceId !== workspaceId) {
    return { error: "Unauthorized", code: "WORKSPACE_MISMATCH" };
  }

  const logo = parseLogoAttr(site.attrs);
  if (!logo) {
    return { data: { success: true } };
  }

  const attrs = { ...(site.attrs as Record<string, unknown>) };
  delete attrs.logo;

  await prisma.site.update({
    where: { id: siteId },
    data: { attrs },
  });

  await deleteObjectBestEffort(logo.key);

  publishEntityEvent({
    action: "updated",
    entityKey: SYSTEM_ENTITY_KEYS.Site,
    entityId: siteId,
    siteId,
    workspaceId: site.workspaceId,
    changedFields: ["attrs"],
  });

  return { data: { success: true } };
}

/**
 * Resolve a presigned GET URL for a site's logo from its attrs, or null when
 * no logo is set (or storage is disabled). Used by the RPC layer to enrich
 * site.list / site.get responses.
 */
export async function resolveLogoUrl(attrs: unknown): Promise<string | null> {
  const logo = parseLogoAttr(attrs);
  if (!logo || !storage.isStorageEnabled()) return null;
  return storage.getPresignedDownloadUrl(logo.key, { disposition: "inline", contentType: logo.contentType });
}
