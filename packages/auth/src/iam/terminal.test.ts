import { describe, expect, it, vi } from "vitest";
vi.mock("@rw/db", () => ({ default: {} }));
import type { IAMContext } from "../context.js";
import {
  createTerminalPolicy,
  type TerminalAction,
  type TerminalLocation,
  type TerminalPolicyDeps,
  type TerminalScopeRef,
} from "./terminal.js";

const oldToken: IAMContext = {
  principal: "DISPLAY",
  validToken: true,
  displayId: "display",
  siteId: "site",
  workspaceId: "workspace",
};
const locations: Record<string, TerminalLocation> = {
  a: { siteId: "site", stationId: "a", workcenterId: "wc-a" },
  b: { siteId: "site", stationId: "b", workcenterId: "wc-b" },
  c: { siteId: "other-site", stationId: "c", workcenterId: "wc-c" },
  "wc-a": { siteId: "site", workcenterId: "wc-a" },
  "wc-b": { siteId: "site", workcenterId: "wc-b" },
  group: { siteId: "site" },
};
function policy(stationId: string | null = "a") {
  const deps: TerminalPolicyDeps = {
    getDisplay: vi.fn(async () => ({
      id: "display",
      status: "CLAIMED",
      siteId: "site",
      stationId,
      workcenterId: "irrelevant",
      site: { workspaceId: "workspace" },
    })),
    resolveScope: vi.fn(async (ref: TerminalScopeRef) => locations[ref.id] ?? null),
  };
  return { authorize: createTerminalPolicy(deps), deps };
}

describe("existing display terminals", () => {
  it.each([
    "operator.logon",
    "job.select",
    "job.correct",
    "call.open",
    "mode.force",
    "mode.clear",
    "disposition.record",
  ] as const)("allows %s without any employee, new claim or mode", async (action) => {
    expect(await policy().authorize(oldToken, { action, scope: { kind: "station", id: "a" } })).toMatchObject({
      ok: true,
      stationId: "a",
    });
  });
  it("fixed terminals reject another station even in their site", async () => {
    expect(
      await policy().authorize(oldToken, { action: "job.select", scope: { kind: "station", id: "b" } }),
    ).toMatchObject({ ok: false, reason: "TERMINAL_STATION_MISMATCH" });
  });
  it("fixed-terminal reads retain site scope rather than inheriting mutation bindings", async () => {
    const { authorize } = policy();
    expect(await authorize(oldToken, { action: "production.read", scope: { kind: "station", id: "b" } })).toMatchObject(
      { ok: true, boundStationId: undefined },
    );
    expect(await authorize(oldToken, { action: "production.read", scope: { kind: "station", id: "c" } })).toMatchObject(
      { ok: false, reason: "TERMINAL_SITE_MISMATCH" },
    );
  });
  it("site-free terminals can select any station in the site regardless of display workcenter", async () => {
    const { authorize } = policy(null);
    for (const id of ["a", "b"])
      expect(await authorize(oldToken, { action: "job.correct", scope: { kind: "station", id } })).toMatchObject({
        ok: true,
      });
    expect(await authorize(oldToken, { action: "job.select", scope: { kind: "station", id: "c" } })).toMatchObject({
      ok: false,
      reason: "TERMINAL_SITE_MISMATCH",
    });
  });
  it.each([
    "stationStateLog",
    "call",
    "dispositionLog",
  ] as const)("resolves %s ownership rather than taking a station from input", async (kind) => {
    const action =
      kind === "call" ? "call.close" : kind === "stationStateLog" ? "downtime.split" : "disposition.record";
    expect(await policy().authorize(oldToken, { action, scope: { kind, id: "b" } })).toMatchObject({
      ok: false,
      reason: "TERMINAL_STATION_MISMATCH",
    });
  });
  it("allows WC comments only in a fixed station's WC", async () => {
    const { authorize } = policy();
    expect(
      await authorize(oldToken, { action: "comment.create", scope: { kind: "workcenter", id: "wc-a" } }),
    ).toMatchObject({ ok: true });
    expect(
      await authorize(oldToken, { action: "comment.create", scope: { kind: "workcenter", id: "wc-b" } }),
    ).toMatchObject({ ok: false });
  });
  it("keeps the shared plant alternate selector as a narrow exception", async () => {
    expect(
      await policy().authorize(oldToken, {
        action: "product.alternate",
        scope: { kind: "productAltGroup", id: "group" },
      }),
    ).toMatchObject({ ok: true });
    expect(
      await policy().authorize(oldToken, { action: "job.select", scope: { kind: "productAltGroup", id: "group" } }),
    ).toMatchObject({ ok: false });
    expect(
      await policy().authorize(oldToken, { action: "product.alternate", scope: { kind: "station", id: "a" } }),
    ).toMatchObject({ ok: false });
  });
  it("has no administrative action, even with forged account permissions in the context", async () => {
    const iam = { ...oldToken, permissionSnapshot: { systemRole: "SUPER_ADMIN", assignments: [] } };
    expect(
      await policy().authorize(iam, {
        action: "production:admin" as TerminalAction,
        scope: { kind: "station", id: "a" },
      }),
    ).toMatchObject({ ok: false, reason: "TERMINAL_ACTION_NOT_ALLOWED" });
  });
  it("reloads current binding for old tokens and fails closed on unclaim or changed site", async () => {
    const { authorize, deps } = policy();
    vi.mocked(deps.getDisplay).mockResolvedValueOnce(null);
    expect(await authorize(oldToken, { action: "job.select", scope: { kind: "station", id: "a" } })).toMatchObject({
      ok: false,
    });
    expect(
      await authorize(
        { ...oldToken, siteId: "old-site" },
        { action: "job.select", scope: { kind: "station", id: "a" } },
      ),
    ).toMatchObject({ ok: false, reason: "DISPLAY_SCOPE_CHANGED" });
    expect(
      await authorize(
        { ...oldToken, validToken: false },
        { action: "job.select", scope: { kind: "station", id: "a" } },
      ),
    ).toMatchObject({ code: "UNAUTHENTICATED" });
  });
});
