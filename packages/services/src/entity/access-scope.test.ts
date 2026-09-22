import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@rw/db";
import {
  canReadMetricEntity,
  canReadPoint,
  metricPathInScope,
  metricReadWhere,
  stationReadWhere,
} from "./access-scope.js";
import { authorizeEntityInstances } from "./read-authorization.js";
import type { IAMContext } from "@rw/auth/context";

const scope = { workspaceId: "w", siteId: "s", workcenterIds: ["wc-a"] };
const db = {
  station: {
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) => ({
      siteId: where.id === "other-site" ? "other" : "s",
      workcenterId: where.id === "own" ? "wc-a" : "wc-b",
    })),
  },
  workcenter: { findUnique: vi.fn(async () => ({ siteId: "s" })) },
  job: { findUnique: vi.fn(async () => ({ siteId: "s" })) },
} as unknown as PrismaClient;

describe("production read ownership", () => {
  it("checks real ownership rather than trusting a supplied id and site", async () => {
    expect(await canReadMetricEntity(scope, { entityType: "STATION", entityId: "own" }, db)).toBe(true);
    for (const entityId of ["foreign", "other-site"]) {
      expect(await canReadMetricEntity(scope, { entityType: "STATION", entityId }, db)).toBe(false);
    }
    expect(await canReadMetricEntity(scope, { entityType: "WORKCENTER", entityId: "wc-b" }, db)).toBe(false);
  });

  it("refuses unconstrainable totals and points, including an empty grant set", async () => {
    for (const entityType of ["SITE", "JOB"]) {
      expect(await canReadMetricEntity(scope, { entityType, entityId: "s" }, db)).toBe(false);
    }
    expect(await canReadPoint(scope, "known-foreign-point", db)).toBe(false);
    expect(
      await canReadMetricEntity({ ...scope, workcenterIds: [] }, { entityType: "STATION", entityId: "own" }, db),
    ).toBe(false);
    expect(
      await canReadMetricEntity({ ...scope, workcenterIds: undefined }, { entityType: "SITE", entityId: "s" }, db),
    ).toBe(true);
  });

  it("uses exact persisted bucket ownership, not a matching substring or current station location", async () => {
    expect(metricPathInScope(scope, "site.s.workcenter.wc-a.station.moved")).toBe(true);
    for (const path of [
      "site.s.workcenter.wc-b.station.own",
      "site.other.workcenter.wc-a",
      "site.s",
      "site.s.workcenter.wc-ab",
    ]) {
      expect(metricPathInScope(scope, path)).toBe(false);
    }
    expect(stationReadWhere(scope)).toEqual({ siteId: "s", workcenterId: { in: ["wc-a"] } });
    expect(await metricReadWhere({ ...scope, workcenterIds: [] })).toEqual({ siteId: "s", OR: [] });
  });
});

describe("native entity domain dispatch", () => {
  const member: IAMContext = {
    principal: "USER",
    validToken: true,
    id: "u",
    workspaceId: "w",
    siteId: "s",
    permissionSnapshot: {
      systemRole: null,
      assignments: [],
      workcenterGrants: [{ siteId: "s", workcenterId: "wc-a", access: "READ" }],
    },
  };
  const planner: IAMContext = {
    ...member,
    permissionSnapshot: { systemRole: null, assignments: [{ siteId: "s", permissions: ["planning:write"] }] },
  };
  it("WC membership grants operational scope and catalogs, not planning, employee or schema access", async () => {
    expect(await authorizeEntityInstances(member, "imm.station")).toMatchObject({ ok: true, workcenterIds: ["wc-a"] });
    for (const key of ["imm.product", "imm.job", "imm.tool", "imm.material"]) {
      expect(await authorizeEntityInstances(member, key)).toMatchObject({ ok: true });
    }
    for (const key of ["imm.order", "imm.customer", "imm.shiftInstance", "imm.employee", undefined]) {
      expect(await authorizeEntityInstances(member, key)).toMatchObject({ ok: false });
    }
  });
  it("planner references cannot become live production access", async () => {
    expect(await authorizeEntityInstances(planner, "imm.product")).toMatchObject({ ok: true });
    expect(await authorizeEntityInstances(planner, "imm.order")).toMatchObject({ ok: true });
    expect(await authorizeEntityInstances(planner, "imm.station")).toMatchObject({ ok: false });
    expect(await authorizeEntityInstances(planner, "imm.employee")).toMatchObject({ ok: false });
  });
});
