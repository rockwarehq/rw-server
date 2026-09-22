import { ORPCError } from "@orpc/server";
import prisma from "@rw/db";
import { type IAMContext, Principal } from "@rw/auth/context";
import {
  authorize,
  authorizeList,
  authorizeReferenceRead,
  type ScopeRef,
  type SiteGrant,
  type ListScope,
} from "@rw/auth/iam/policy";
import { resolveSiteRef, type ResolvableSiteRef } from "@rw/auth/iam/policy-resolvers";
import {
  authorizeTerminal,
  type TerminalAction,
  type TerminalScopeRef,
  type TerminalLocation,
} from "@rw/auth/iam/terminal";
import { resolveActionActor, type ActionActor } from "@rw/services/employee/actor-role";
import { grant } from "./authz.js";

export function terminalForbidden(reason: string, message: string): never {
  throw new ORPCError("FORBIDDEN", { message, data: { reason } });
}

export type OperationalGrant = SiteGrant & TerminalLocation & { displayId?: string; boundStationId?: string };

export async function assertRelatedSite(siteId: string, refs: ResolvableSiteRef[]) {
  for (const ref of refs) {
    const related = await resolveSiteRef(ref);
    if (!related || related.siteId !== siteId) {
      terminalForbidden("RELATED_RESOURCE_SITE_MISMATCH", "Related resource must belong to the action's site");
    }
  }
}

export async function assertProductionLinks(
  location: TerminalLocation,
  input: { siteId: string; workcenterId?: string; cycleId?: string; shiftInstanceId?: string },
) {
  if (input.siteId !== location.siteId || (input.workcenterId && input.workcenterId !== location.workcenterId)) {
    terminalForbidden("LOCATION_MISMATCH", "Related location ids do not match");
  }
  if (input.cycleId) {
    const cycle = await prisma.cycle.findUnique({
      where: { id: input.cycleId },
      select: { siteId: true, stationId: true },
    });
    if (!cycle || cycle.siteId !== location.siteId || cycle.stationId !== location.stationId) {
      terminalForbidden("CYCLE_STATION_MISMATCH", "Cycle must belong to this station");
    }
  }
  if (input.shiftInstanceId) {
    const shift = await prisma.shiftInstance.findUnique({
      where: { id: input.shiftInstanceId },
      select: { siteId: true, workCenterId: true },
    });
    if (
      !shift ||
      shift.siteId !== location.siteId ||
      (shift.workCenterId && shift.workCenterId !== location.workcenterId)
    ) {
      terminalForbidden("SHIFT_SCOPE_MISMATCH", "Shift must belong to this site/workcenter");
    }
  }
}

/** Explicit terminal mutation OR production permission; DISPLAY reads retain their site-wide contract. */
export async function authorizeTerminalAction(
  iam: IAMContext,
  check: { action: TerminalAction; scope: TerminalScopeRef },
): Promise<OperationalGrant> {
  const read = check.action === "production.read";
  if (iam.principal === Principal.DISPLAY && !read) {
    const result = await authorizeTerminal(iam, check);
    if (!result.ok) {
      if (result.code === "FORBIDDEN") terminalForbidden(result.reason, result.message);
      throw new ORPCError(result.code === "UNAUTHENTICATED" ? "UNAUTHORIZED" : "NOT_FOUND", {
        message: result.message,
        data: { reason: result.reason },
      });
    }
    return result;
  }
  if (iam.principal !== Principal.USER && !(read && iam.principal === Principal.DISPLAY)) {
    terminalForbidden("USER_OR_DISPLAY_REQUIRED", "A user or display is required");
  }
  const resolved = await resolveSiteRef(check.scope);
  if (!resolved?.siteId) throw new ORPCError("NOT_FOUND", { message: "Resource not found" });
  const location = { ...resolved, siteId: resolved.siteId };
  const scope = grant(
    await authorize(iam, {
      permission: read ? "production:read" : "production:write",
      scope: { kind: "site", siteId: location.siteId, workcenterId: location.workcenterId ?? undefined },
    }),
  );
  return { ...scope, ...location, boundStationId: undefined };
}

export async function authorizeProductionList(
  iam: IAMContext,
  input: { siteId?: string; stationId?: string; workcenterId?: string },
): Promise<ListScope & { stationId?: string }> {
  const scope = grant(await authorizeList(iam, { permission: "production:read", requestedSiteId: input.siteId }));
  // A fixed station restricts mutations, not existing site-scoped dashboards or pickers.
  return { ...scope, stationId: input.stationId };
}

/** Site-global catalog pickers deliberately opt in to shared reference access. */
export async function authorizeReferenceList(iam: IAMContext, requestedSiteId?: string) {
  const siteId = requestedSiteId ?? iam.siteId;
  if (!siteId) throw new ORPCError("BAD_REQUEST", { message: "Site context required" });
  return grant(await authorizeReferenceRead(iam, { scope: { kind: "site", siteId } }));
}

/** Definition/configuration operations always evaluate at the actual resource SITE. */
export async function authorizeSiteOperation(
  iam: IAMContext,
  permission: "configuration:read" | "configuration:write" | "production:write",
  scope: ScopeRef,
) {
  if (scope.kind === "workspace" || scope.kind === "anySite") terminalForbidden("SITE_REQUIRED", "A site is required");
  const siteId = scope.kind === "site" ? scope.siteId : (await resolveSiteRef(scope))?.siteId;
  if (!siteId) throw new ORPCError("NOT_FOUND", { message: "Resource not found" });
  return grant(await authorize(iam, { permission, scope: { kind: "site", siteId } }));
}

/** Never probe generic authorize for DISPLAY admin privileges. */
export async function hasProductionAdmin(iam: IAMContext, location: TerminalLocation): Promise<boolean> {
  if (iam.principal !== Principal.USER) return false;
  return (
    (await authorize(iam, { permission: "plant:admin", scope: { kind: "site", siteId: location.siteId } })).ok ||
    (
      await authorize(iam, {
        permission: "production:admin",
        scope: { kind: "site", siteId: location.siteId, workcenterId: location.workcenterId ?? undefined },
      })
    ).ok
  );
}

export async function resolveTerminalActor(
  iam: IAMContext,
  location: { siteId: string; workspaceId: string },
  input: { employeeId?: string; operatorSessionId?: string },
): Promise<ActionActor> {
  const actor = await resolveActionActor({
    ...location,
    employeeId: input.employeeId,
    operatorSessionId: input.operatorSessionId,
    userId: iam.principal === Principal.USER ? iam.id : undefined,
    displayId: iam.principal === Principal.DISPLAY ? iam.displayId : undefined,
  });
  if ("error" in actor) terminalForbidden(actor.reason, actor.error);
  return actor;
}
