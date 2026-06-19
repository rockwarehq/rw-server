import prisma from "@rw/db";

import { errorResult, type GraphScope } from "./types.js";

const SYSTEM_RECORD_MODELS = new Set(["Site", "Workcenter", "Station"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function fieldBindingPath(field: { name: string; key?: string; config: unknown }): string {
  const fallback = field.key ?? field.name;
  if (!isRecord(field.config) || !isRecord(field.config.binding)) return fallback;
  return typeof field.config.binding.path === "string" ? field.config.binding.path : fallback;
}

export async function assertRecordInSite(model: string, recordId: string, scope: GraphScope) {
  if (!SYSTEM_RECORD_MODELS.has(model)) {
    return errorResult("INVALID_RECORD_MODEL", `Unsupported record model "${model}"`);
  }

  if (model === "Site") {
    if (recordId !== scope.siteId) return errorResult("RECORD_SITE_MISMATCH", "Record is outside this graph site");
    const site = await prisma.site.findFirst({ where: { id: recordId, workspaceId: scope.workspaceId } });
    return site ? null : errorResult("RECORD_SITE_MISMATCH", "Record is outside this graph site");
  }

  if (model === "Workcenter") {
    const workcenter = await prisma.workcenter.findFirst({
      where: { id: recordId, siteId: scope.siteId, site: { workspaceId: scope.workspaceId } },
    });
    return workcenter ? null : errorResult("RECORD_SITE_MISMATCH", "Record is outside this graph site");
  }

  const station = await prisma.station.findFirst({
    where: { id: recordId, siteId: scope.siteId, site: { workspaceId: scope.workspaceId } },
  });
  return station ? null : errorResult("RECORD_SITE_MISMATCH", "Record is outside this graph site");
}
