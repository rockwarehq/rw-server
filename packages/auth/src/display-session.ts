import prisma from "@rw/db";
import { safeEqual } from "./secrets.js";
import {
  createAccessToken,
  createDisplayRefreshToken,
  hashToken,
  inspectDisplayRefreshToken,
  REFRESH_REUSE_GRACE_MS,
  revokeAllDisplayRefreshTokens,
  revokeDisplayRefreshToken,
  type DisplayAccessTokenPayload,
} from "./tokens.js";

export interface DisplayTokenPair {
  [x: string]: unknown;
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
}

export interface DisplayAuthContext {
  ipAddress?: string;
  userAgent?: string;
}

export interface DisplayAuthResult extends DisplayTokenPair {
  [x: string]: unknown;
  display: {
    [x: string]: unknown;
    id: string;
    name: string | null;
    status: string;
    siteId: string;
    dashboardId: string | null;
    workcenterId: string | null;
    stationId: string | null;
    workspaceId: string;
  };
}

async function getDisplayAuthRecord(displayId: string) {
  return prisma.display.findUnique({
    where: { id: displayId },
    select: {
      id: true,
      name: true,
      status: true,
      siteId: true,
      dashboardId: true,
      workcenterId: true,
      stationId: true,
      bootstrapSecretHash: true,
      site: {
        select: {
          workspaceId: true,
        },
      },
    },
  });
}

function toDisplayAccessPayload(display: {
  id: string;
  siteId: string;
  workspaceId: string;
}): DisplayAccessTokenPayload {
  return {
    principal: "DISPLAY",
    displayId: display.id,
    siteId: display.siteId,
    workspaceId: display.workspaceId,
  };
}

export async function loginDisplay(
  displayId: string,
  bootstrapSecret: string,
  metadata?: DisplayAuthContext,
): Promise<{ success: true; data: DisplayAuthResult } | { success: false; error: string }> {
  const display = await getDisplayAuthRecord(displayId);

  if (!display?.bootstrapSecretHash || !safeEqual(hashToken(bootstrapSecret), display.bootstrapSecretHash)) {
    return { success: false, error: "Invalid display credentials" };
  }

  if (display.status !== "CLAIMED") {
    return { success: false, error: "Display has not been claimed" };
  }

  if (!display.siteId || !display.site?.workspaceId) {
    return { success: false, error: "Display is missing site configuration" };
  }

  const accessToken = createAccessToken(
    toDisplayAccessPayload({
      id: display.id,
      siteId: display.siteId,
      workspaceId: display.site.workspaceId,
    }),
  );
  const { token: refreshToken, expiresAt } = await createDisplayRefreshToken(display.id, metadata);

  await prisma.display.update({
    where: { id: display.id },
    data: { bootstrapSecretLastUsedAt: new Date() },
  });

  return {
    success: true,
    data: {
      accessToken,
      refreshToken,
      expiresAt,
      display: {
        id: display.id,
        name: display.name,
        status: display.status,
        siteId: display.siteId,
        dashboardId: display.dashboardId,
        workcenterId: display.workcenterId,
        stationId: display.stationId,
        workspaceId: display.site.workspaceId,
      },
    },
  };
}

export async function refreshDisplaySession(
  refreshToken: string,
  metadata?: DisplayAuthContext,
): Promise<{ success: true; data: DisplayTokenPair } | { success: false; error: string }> {
  const inspection = await inspectDisplayRefreshToken(refreshToken);

  // Reuse detection with a grace interval (see refreshSession): a token
  // rotated within REFRESH_REUSE_GRACE_MS refreshes normally — displays
  // refresh unattended and are the most exposed to a rotation response lost
  // when the API restarts mid-request. Replay after the grace window signals
  // theft; revoke the whole family so the display must re-authenticate with
  // its bootstrap secret.
  // Only rotation revocations qualify (rotatedAt set) — see revokeRefreshToken.
  const graceReuse =
    inspection.status === "revoked" &&
    inspection.rotatedAt !== undefined &&
    Date.now() - inspection.rotatedAt.getTime() <= REFRESH_REUSE_GRACE_MS;

  if (inspection.status === "revoked" && inspection.displayId && !graceReuse) {
    await revokeAllDisplayRefreshTokens(inspection.displayId);
    return { success: false, error: "Invalid or expired refresh token" };
  }

  if ((inspection.status !== "valid" && !graceReuse) || !inspection.displayId) {
    return { success: false, error: "Invalid or expired refresh token" };
  }

  if (!graceReuse) {
    await revokeDisplayRefreshToken(refreshToken, { rotated: true });
  }

  const display = await getDisplayAuthRecord(inspection.displayId);

  if (!display || display.status !== "CLAIMED") {
    return { success: false, error: "Display is not active" };
  }

  if (!display.siteId || !display.site?.workspaceId) {
    return { success: false, error: "Display is missing site configuration" };
  }

  const accessToken = createAccessToken(
    toDisplayAccessPayload({
      id: display.id,
      siteId: display.siteId,
      workspaceId: display.site.workspaceId,
    }),
  );
  const { token: newRefreshToken, expiresAt } = await createDisplayRefreshToken(display.id, metadata);

  return {
    success: true,
    data: {
      accessToken,
      refreshToken: newRefreshToken,
      expiresAt,
    },
  };
}

export async function logoutDisplay(refreshToken: string): Promise<boolean> {
  return revokeDisplayRefreshToken(refreshToken);
}
