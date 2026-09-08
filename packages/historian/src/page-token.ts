import { decodeCursor, encodeCursor } from "./cursor.js";
import { isHistorianError, type HistorianError, type ResolvedRange, type ShiftWindow } from "./types.js";

export interface SnapshotWindow {
  range: ResolvedRange;
  shift: ShiftWindow | null;
}

/** Wrap the series keyset token so relative ranges and shift metadata cannot drift between pages. */
export function encodeSnapshotPageToken(
  seriesType: string,
  scope: unknown,
  window: SnapshotWindow,
  pageToken: string,
): string {
  return Buffer.from(
    JSON.stringify({
      v: 1,
      kind: "snapshot",
      cursor: encodeCursor(seriesType, scope, window.range, Date.now()),
      shift: window.shift,
      pageToken,
    }),
    "utf8",
  ).toString("base64url");
}

export async function resolveSnapshotPage(
  seriesType: string,
  scope: unknown,
  pageToken: string | undefined,
  resolve: () => Promise<SnapshotWindow | null>,
): Promise<(SnapshotWindow & { pageToken: string | null }) | null | HistorianError> {
  if (!pageToken) {
    const window = await resolve();
    return window ? { ...window, pageToken: null } : null;
  }

  try {
    const payload = JSON.parse(Buffer.from(pageToken, "base64url").toString("utf8"));
    // Shipped tokens only held (startTime, id), so their missing range must
    // still be resolved from the request. Subsequent tokens use the envelope.
    if (payload?.kind === undefined && Number.isFinite(payload?.s) && typeof payload?.i === "string") {
      return resolve().then((window) => (window ? { ...window, pageToken } : null));
    }
    if (
      payload?.kind !== "snapshot" ||
      payload.v !== 1 ||
      typeof payload.cursor !== "string" ||
      typeof payload.pageToken !== "string" ||
      !payload.pageToken
    ) {
      return { error: "Malformed snapshot page token", code: "BAD_CURSOR" };
    }
    const decoded = decodeCursor(payload.cursor, seriesType, scope, Date.now());
    if (isHistorianError(decoded)) return decoded;
    let shift: ShiftWindow | null = null;
    if (payload.shift !== null) {
      const value = payload.shift;
      if (
        typeof value?.shiftInstanceId !== "string" ||
        typeof value.shiftName !== "string" ||
        typeof value.shiftStart !== "string" ||
        typeof value.shiftEnd !== "string" ||
        !Number.isFinite(Date.parse(value.shiftStart)) ||
        !Number.isFinite(Date.parse(value.shiftEnd))
      ) {
        return { error: "Malformed snapshot shift metadata", code: "BAD_CURSOR" };
      }
      shift = {
        range: decoded.range,
        shiftInstanceId: value.shiftInstanceId,
        shiftName: value.shiftName,
        shiftStart: new Date(value.shiftStart),
        shiftEnd: new Date(value.shiftEnd),
      };
    }
    return { range: decoded.range, shift, pageToken: payload.pageToken };
  } catch {
    return { error: "Malformed snapshot page token", code: "BAD_CURSOR" };
  }
}
