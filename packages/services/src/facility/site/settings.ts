import prisma from "@rw/db";
import { BASE_WORKCENTER_ACCESS_KEY, type BaseWorkcenterAccess } from "@rw/auth/iam/permissions";
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
  /**
   * Base workcenter access for read-tier site roles (GitHub's org "base
   * permissions" at plant scope): ALL (default) = members see live floor
   * data site-wide; GRANTS_REQUIRED = floor reads (status/calls/modes)
   * come only from explicit workcenter grants. The permission evaluator
   * (@rw/auth iam/permissions.ts) reads the raw attrs key directly.
   */
  baseWorkcenterAccess: BaseWorkcenterAccess;
}

const SETTINGS_KEYS = ["orderAutoComplete", "baseWorkcenterAccess"] as const satisfies ReadonlyArray<
  keyof SiteSettings
>;

export function parseSiteSettings(attrs: unknown): SiteSettings {
  const record = (attrs ?? {}) as Record<string, unknown>;
  return {
    orderAutoComplete: record.orderAutoComplete === true,
    baseWorkcenterAccess: record[BASE_WORKCENTER_ACCESS_KEY] === "GRANTS_REQUIRED" ? "GRANTS_REQUIRED" : "ALL",
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
