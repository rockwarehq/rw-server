import prisma from "@rw/db";
import { type IAMContext, Principal } from "../context.js";

/** Deliberately separate from account permissions. Existing DISPLAY credentials suffice. */
export type TerminalAction =
  | "operator.logon"
  | "job.select"
  | "job.correct"
  | "downtime.split"
  | "downtime.reason"
  | "call.open"
  | "call.close"
  | "mode.force"
  | "mode.clear"
  | "disposition.record"
  | "comment.create"
  | "comment.edit"
  | "production.read"
  | "product.alternate";

export type TerminalScopeRef = {
  kind: "station" | "stationStateLog" | "call" | "dispositionLog" | "shiftComment" | "workcenter" | "productAltGroup";
  id: string;
};

export interface TerminalLocation {
  siteId: string;
  stationId?: string | null;
  workcenterId?: string | null;
}

export interface TerminalGrant extends TerminalLocation {
  ok: true;
  workspaceId: string;
  displayId: string;
  boundStationId?: string;
}

export interface TerminalDenial {
  ok: false;
  code: "UNAUTHENTICATED" | "FORBIDDEN" | "NOT_FOUND";
  message: string;
  reason: string;
}

export interface TerminalPolicyDeps {
  getDisplay(id: string): Promise<{
    id: string;
    status: string;
    siteId: string | null;
    stationId: string | null;
    site: { workspaceId: string } | null;
  } | null>;
  resolveScope(ref: TerminalScopeRef): Promise<TerminalLocation | null>;
}

const denied = (reason: string, message: string, code: TerminalDenial["code"] = "FORBIDDEN"): TerminalDenial => ({
  ok: false,
  code,
  reason,
  message,
});

const actionScopes: Record<TerminalAction, readonly TerminalScopeRef["kind"][]> = {
  "operator.logon": ["station"],
  "job.select": ["station"],
  "job.correct": ["station"],
  "downtime.split": ["stationStateLog"],
  "downtime.reason": ["stationStateLog"],
  "call.open": ["station"],
  "call.close": ["call"],
  "mode.force": ["station"],
  "mode.clear": ["station"],
  "disposition.record": ["station", "dispositionLog"],
  "comment.create": ["station", "workcenter"],
  "comment.edit": ["shiftComment"],
  "production.read": ["station", "stationStateLog", "call", "dispositionLog", "shiftComment", "workcenter"],
  "product.alternate": ["productAltGroup"],
};

export function createTerminalPolicy(deps: TerminalPolicyDeps) {
  return async function authorizeTerminal(
    iam: IAMContext | undefined,
    check: { action: TerminalAction; scope: TerminalScopeRef },
  ): Promise<TerminalGrant | TerminalDenial> {
    if (!iam?.validToken) {
      return denied("AUTHENTICATION_REQUIRED", "Authentication required", "UNAUTHENTICATED");
    }
    if (iam.principal !== Principal.DISPLAY || !iam.displayId) {
      return denied("DISPLAY_REQUIRED", "This action requires a display");
    }
    if (!actionScopes[check.action]?.includes(check.scope.kind)) {
      return denied("TERMINAL_ACTION_NOT_ALLOWED", "This action is not available to terminals");
    }
    // Read the current binding, including for old tokens without embedded display metadata.
    const display = await deps.getDisplay(iam.displayId);
    if (!display || display.status !== "CLAIMED" || !display.siteId || !display.site) {
      return denied("DISPLAY_NOT_CLAIMED", "Display is not claimed at a site");
    }
    if (display.siteId !== iam.siteId || display.site.workspaceId !== iam.workspaceId) {
      return denied("DISPLAY_SCOPE_CHANGED", "Display credentials do not match its current site");
    }
    const target = await deps.resolveScope(check.scope);
    if (!target) return denied("RESOURCE_NOT_FOUND", "Resource not found", "NOT_FOUND");
    if (target.siteId !== display.siteId) {
      return denied("TERMINAL_SITE_MISMATCH", "Resource is outside the display's site");
    }

    // The alternate selector is an explicit shared-plant exception. It never accepts a station input.
    if (check.action !== "product.alternate" && check.action !== "production.read" && display.stationId) {
      if (target.stationId) {
        if (target.stationId !== display.stationId) {
          return denied("TERMINAL_STATION_MISMATCH", "Display is assigned to a different station");
        }
      } else {
        // WC-wide comment mutations belong to the fixed station's WC.
        const station = await deps.resolveScope({ kind: "station", id: display.stationId });
        if (
          !station ||
          station.siteId !== display.siteId ||
          !station.workcenterId ||
          station.workcenterId !== target.workcenterId
        ) {
          return denied("TERMINAL_WORKCENTER_MISMATCH", "Resource is outside the display station's workcenter");
        }
      }
    }
    // display.workcenterId is presentation/provisioning metadata, never an additional restriction.
    return {
      ok: true,
      workspaceId: display.site.workspaceId,
      displayId: display.id,
      boundStationId: check.action === "production.read" ? undefined : (display.stationId ?? undefined),
      ...target,
    };
  };
}

const stationSelect = { id: true, siteId: true, workcenterId: true } as const;
const fromStation = (
  station: { id: string; siteId: string; workcenterId: string | null } | null | undefined,
): TerminalLocation | null =>
  station ? { siteId: station.siteId, stationId: station.id, workcenterId: station.workcenterId } : null;

/** Resolve actual station lineage rather than trusting supplied site/workcenter ids. */
export async function resolveTerminalScope(ref: TerminalScopeRef): Promise<TerminalLocation | null> {
  switch (ref.kind) {
    case "station":
      return fromStation(await prisma.station.findUnique({ where: { id: ref.id }, select: stationSelect }));
    case "stationStateLog":
      return fromStation(
        (
          await prisma.stationStateLog.findUnique({
            where: { id: ref.id },
            select: { station: { select: stationSelect } },
          })
        )?.station,
      );
    case "call":
      return fromStation(
        (
          await prisma.call.findUnique({
            where: { id: ref.id },
            select: { station: { select: stationSelect } },
          })
        )?.station,
      );
    case "dispositionLog":
      return fromStation(
        (
          await prisma.itemDispositionLog.findUnique({
            where: { id: ref.id },
            select: { station: { select: stationSelect } },
          })
        )?.station,
      );
    case "shiftComment":
      return prisma.shiftComment.findUnique({
        where: { id: ref.id },
        select: { siteId: true, workcenterId: true, stationId: true },
      });
    case "workcenter": {
      const row = await prisma.workcenter.findUnique({ where: { id: ref.id }, select: { siteId: true } });
      return row ? { siteId: row.siteId, workcenterId: ref.id } : null;
    }
    case "productAltGroup": {
      const row = await prisma.productMaterialAltGroup.findUnique({
        where: { id: ref.id },
        select: { product: { select: { siteId: true } } },
      });
      return row ? { siteId: row.product.siteId } : null;
    }
  }
}

export const authorizeTerminal = createTerminalPolicy({
  getDisplay: (id) =>
    prisma.display.findUnique({
      where: { id },
      select: { id: true, status: true, siteId: true, stationId: true, site: { select: { workspaceId: true } } },
    }),
  resolveScope: resolveTerminalScope,
});
