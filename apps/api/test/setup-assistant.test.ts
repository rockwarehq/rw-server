import prisma from "@rw/db";
import { ENTITY_KINDS } from "@rw/services/insights/components";
import { loadPerson, UserAccess } from "@rw/auth/iam/access";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RPCContext } from "../src/rpc/context.js";
import { router } from "../src/rpc/index.js";
import { inputJsonSchema } from "../src/setup/catalog.js";
import { allActions, SETUP_DOMAINS } from "../src/setup/manifest.js";
import { applyPlan, type PlanStep, planFor, proposePlan } from "../src/setup/plans.js";
import { makeUser } from "./helpers/access.js";

// The setup assistant: its catalog of actions, how plans are checked, and how
// an approved plan runs as the person (every procedure still checks access).

function routerPaths(): Set<string> {
  const out = new Set<string>();
  const walk = (node: unknown, path: string[]) => {
    if (!node || typeof node !== "object") return;
    if ("~orpc" in node) {
      out.add(path.join("."));
      return;
    }
    for (const [key, value] of Object.entries(node)) walk(value, [...path, key]);
  };
  walk(router, []);
  return out;
}

/** A context that says yes (or no) to every access question, for checks that never reach the database. */
function fakeContext(allowed: boolean): RPCContext {
  const access = {
    can: () => allowed,
    requireAccountAdmin: () => {
      if (!allowed) throw new Error("no");
    },
  };
  return {
    request: { headers: {} },
    current: { kind: "user", user: { id: "u1" }, access } as never,
    access: access as never,
  };
}

const SITE = "11111111-1111-4111-8111-111111111111";

describe("setup catalog", () => {
  it("names only procedures that exist on the router", () => {
    const paths = routerPaths();
    const missing = allActions()
      .map((a) => a.path)
      .filter((p) => !paths.has(p));
    expect(missing).toEqual([]);
  });

  it("depends only on areas that exist, and marks every delete as dangerous", () => {
    for (const [key, domain] of Object.entries(SETUP_DOMAINS)) {
      for (const dep of domain.dependsOn ?? []) expect(SETUP_DOMAINS[dep], `${key} → ${dep}`).toBeDefined();
    }
    for (const action of allActions()) {
      if (action.kind === "delete") expect(action.danger, action.path).toBeTruthy();
    }
  });

  it("can fetch every kind of thing an EntityCard shows", () => {
    const paths = routerPaths();
    expect(ENTITY_KINDS.filter((kind) => !paths.has(`${kind}.get`))).toEqual([]);
  });

  it("describes every write's inputs from the router", async () => {
    const writes = allActions().filter((a) => a.kind !== "read");
    for (const action of writes) {
      const schema = (await inputJsonSchema(action.path)) as Record<string, unknown>;
      // An object, a choice of objects (anyOf/oneOf), or a note when it can't be described.
      const described = schema.type === "object" || "anyOf" in schema || "oneOf" in schema || "note" in schema;
      expect(described, action.path).toBe(true);
    }
  });
});

describe("propose_plan checks", () => {
  const propose = (steps: PlanStep[], allowed = true) => proposePlan(fakeContext(allowed), SITE, "Test", steps);

  it("refuses unknown actions, reads, and steps that point forward", async () => {
    const result = await propose([
      { id: "a", action: "station.explode", input: {} },
      { id: "b", action: "workcenter.list", input: { siteId: SITE } },
      { id: "c", action: "station.create", input: { siteId: SITE, name: "S", workcenterId: "$later" } },
      { id: "later", action: "workcenter.create", input: { siteId: SITE, name: "W" } },
    ]);
    expect("problems" in result).toBe(true);
    const text = "problems" in result ? result.problems.join("\n") : "";
    expect(text).toContain("station.explode isn't a setup action");
    expect(text).toContain("only reads");
    expect(text).toContain("$later, which isn't an earlier step");
  });

  it("checks inputs against the procedure's own rules", async () => {
    const result = await propose([{ id: "wc", action: "workcenter.create", input: { siteId: SITE } }]);
    expect("problems" in result && result.problems.join(" ")).toContain("name");
  });

  it("refuses steps the person hasn't the access for", async () => {
    const result = await propose([{ id: "wc", action: "workcenter.create", input: { siteId: SITE, name: "W" } }], false);
    expect("problems" in result && result.problems.join(" ")).toContain("admin access");
  });

  it("keeps a good plan, with dangers marked, for its owner only", async () => {
    const result = await propose([
      { id: "lbl", action: "label.create", input: { siteId: SITE, name: "Hot" } },
      { id: "gone", action: "label.delete", input: { id: "$lbl" } },
    ]);
    if (!("plan" in result)) throw new Error(JSON.stringify(result));
    expect(result.plan.steps[1]?.danger).toBeTruthy();
    expect("error" in planFor(result.plan.id, "someone-else")).toBe(true);
    expect("error" in planFor(result.plan.id, "u1")).toBe(false);
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)("applying a plan", () => {
  const EMAIL = "setup-admin@test.local";
  const VIEWER = "setup-viewer@test.local";
  const P = "setup-test";
  let siteId: string;
  let adminContext: RPCContext;
  let viewerContext: RPCContext;

  async function contextFor(email: string): Promise<RPCContext> {
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    const person = await loadPerson(user.id);
    if (!person) throw new Error("no person");
    const access = new UserAccess(person, siteId);
    return {
      request: { headers: {} },
      current: { kind: "user", user: { id: user.id }, workspaceId: user.workspaceId, siteId, access } as never,
      access,
    };
  }

  const collect = async (gen: ReturnType<typeof applyPlan>) => {
    const out = [];
    for await (const r of gen) out.push(r);
    return out;
  };

  beforeAll(async () => {
    const site = await prisma.site.findFirstOrThrow({ where: { name: "Rockware" }, select: { id: true } });
    siteId = site.id;
    await makeUser(EMAIL, "setup-test-password-1", { plants: [{ siteId, level: "ADMIN" }] });
    await makeUser(VIEWER, "setup-test-password-1", { plants: [{ siteId, level: "VIEW" }] });
    adminContext = await contextFor(EMAIL);
    viewerContext = await contextFor(VIEWER);
  }, 30_000);

  afterAll(async () => {
    const workcenters = await prisma.workcenter.findMany({ where: { siteId, name: { startsWith: P } }, select: { id: true } });
    const ids = workcenters.map((w) => w.id);
    const stations = await prisma.station.findMany({ where: { workcenterId: { in: ids } }, select: { id: true } });
    await prisma.station.updateMany({ where: { id: { in: stations.map((s) => s.id) } }, data: { currentVersionId: null } });
    await prisma.stationVersion.deleteMany({ where: { stationId: { in: stations.map((s) => s.id) } } });
    await prisma.station.deleteMany({ where: { id: { in: stations.map((s) => s.id) } } });
    await prisma.bucket.deleteMany({ where: { workcenterId: { in: ids } } });
    await prisma.workcenter.deleteMany({ where: { id: { in: ids } } });
    await prisma.label.deleteMany({ where: { siteId, name: { startsWith: P } } });
    await prisma.user.deleteMany({ where: { email: { in: [EMAIL, VIEWER] } } });
  });

  it("makes a workcenter and puts a new station in it, as the person", async () => {
    const proposed = await proposePlan(adminContext, siteId, "Line", [
      { id: "wc", action: "workcenter.create", input: { siteId, name: `${P}-line` } },
      { id: "s1", action: "station.create", input: { siteId, name: `${P}-press`, workcenterId: "$wc" } },
    ]);
    if (!("plan" in proposed)) throw new Error(JSON.stringify(proposed));
    const results = await collect(applyPlan(adminContext, proposed.plan, new Set()));
    expect(results.every((r) => "ok" in r && r.ok)).toBe(true);
    const station = await prisma.station.findFirstOrThrow({ where: { name: `${P}-press` } });
    const workcenter = await prisma.workcenter.findFirstOrThrow({ where: { name: `${P}-line` } });
    expect(station.workcenterId).toBe(workcenter.id);
    // A plan runs once.
    expect("error" in planFor(proposed.plan.id, (adminContext.current as { user: { id: string } }).user.id)).toBe(true);
  });

  it("skips dangerous steps that weren't ticked, and runs them when they were", async () => {
    const make = await proposePlan(adminContext, siteId, "Labels", [
      { id: "lbl", action: "label.create", input: { siteId, name: `${P}-hot` } },
      { id: "gone", action: "label.delete", input: { id: "$lbl" } },
    ]);
    if (!("plan" in make)) throw new Error(JSON.stringify(make));
    const first = await collect(applyPlan(adminContext, make.plan, new Set()));
    expect(first[1]).toMatchObject({ skipped: "gone" });
    expect(await prisma.label.count({ where: { siteId, name: `${P}-hot` } })).toBe(1);

    const again = await proposePlan(adminContext, siteId, "Labels", [
      { id: "lbl", action: "label.create", input: { siteId, name: `${P}-cold` } },
      { id: "gone", action: "label.delete", input: { id: "$lbl" } },
    ]);
    if (!("plan" in again)) throw new Error(JSON.stringify(again));
    const second = await collect(applyPlan(adminContext, again.plan, new Set(["gone"])));
    expect(second.every((r) => "ok" in r && r.ok)).toBe(true);
    expect(await prisma.label.count({ where: { siteId, name: `${P}-cold` } })).toBe(0);
  });

  it("won't plan admin changes for a viewer, and the server refuses them anyway", async () => {
    const proposed = await proposePlan(viewerContext, siteId, "Nope", [
      { id: "wc", action: "workcenter.create", input: { siteId, name: `${P}-nope` } },
    ]);
    expect("problems" in proposed).toBe(true);
    // Even a plan made for someone else can't be run by the viewer.
    const made = await proposePlan(adminContext, siteId, "Admin's", [
      { id: "wc", action: "workcenter.create", input: { siteId, name: `${P}-admins` } },
    ]);
    if (!("plan" in made)) throw new Error(JSON.stringify(made));
    const results = await collect(applyPlan(viewerContext, made.plan, new Set()));
    expect(results[0]).toMatchObject({ ok: false });
    expect(await prisma.workcenter.count({ where: { name: `${P}-admins` } })).toBe(0);
  });
});
