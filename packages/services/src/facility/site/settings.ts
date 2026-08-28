import prisma from "@rw/db";
import { publishEntityEvent } from "../../entity/events.js";
import { SYSTEM_ENTITY_KEYS } from "../../entity/registry.js";

// ============================================================================
// Typed site settings over Site.attrs
// ============================================================================
//
// Site.attrs is a shared JSON blob (logo, settings, …). This module is the
// typed accessor for the settings keys: reads are lenient, writes merge ONLY
// known keys and never replace the blob.

export interface SiteSettings {
  /**
   * The one fulfillment automation: when on, an order whose FIFO coverage
   * reaches 100% is completed automatically, consuming its covered stock
   * (same code path as a manual completion).
   */
  orderAutoComplete: boolean;
}

const SETTINGS_KEYS = ["orderAutoComplete"] as const satisfies ReadonlyArray<keyof SiteSettings>;

export function parseSiteSettings(attrs: unknown): SiteSettings {
  const record = (attrs ?? {}) as Record<string, unknown>;
  return {
    orderAutoComplete: record.orderAutoComplete === true,
  };
}

export async function getSiteSettings(siteId: string) {
  const site = await prisma.site.findUnique({ where: { id: siteId }, select: { attrs: true } });
  if (!site) return { error: "Site not found", code: "SITE_NOT_FOUND" };
  return { data: parseSiteSettings(site.attrs) };
}

export async function updateSiteSettings(siteId: string, patch: Partial<SiteSettings>) {
  const result = await prisma.$transaction(async (tx) => {
    const site = await tx.site.findUnique({ where: { id: siteId }, select: { attrs: true, workspaceId: true } });
    if (!site) return null;
    const attrs = { ...((site.attrs ?? {}) as Record<string, unknown>) };
    for (const key of SETTINGS_KEYS) {
      if (patch[key] !== undefined) attrs[key] = patch[key];
    }
    await tx.site.update({ where: { id: siteId }, data: { attrs } });
    return { workspaceId: site.workspaceId, settings: parseSiteSettings(attrs) };
  });

  if (!result) return { error: "Site not found", code: "SITE_NOT_FOUND" };

  publishEntityEvent({
    action: "updated",
    entityKey: SYSTEM_ENTITY_KEYS.Site,
    entityId: siteId,
    siteId,
    workspaceId: result.workspaceId,
    changedFields: ["attrs"],
  });

  return { data: result.settings };
}
