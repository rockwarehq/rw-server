import { randomUUID } from "node:crypto";
import { createRouterClient } from "@orpc/server";
import prisma from "@rw/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadUserCurrent } from "../src/auth/plugin.js";
import { router } from "../src/rpc/index.js";
import type { SetupPlan, SetupRow } from "../src/setup/plan.js";
import { makeUser } from "./helpers/access.js";
import { buildServer, loginAs, type TestServer } from "./helpers/build-server.js";
import { rpcCall } from "./helpers/rpc-call.js";

// Setup changesets: plan by external key, apply in one transaction, re-runs
// come back unchanged, the plant moving under a reviewed plan is refused, and
// a connected agent can propose but never apply.

const MEMBER = { email: "setup-member@test.local", password: "setup-member-password-1" };
const VIEWER = { email: "setup-viewer@test.local", password: "setup-viewer-password-1" };
const ADMIN = { email: "setup-admin@test.local", password: "setup-admin-password-1" };
const RUN = `t${Date.now().toString(36)}`;
const SOURCE = `test-erp-${RUN}`;

const spec = (overrides: { productName?: string } = {}) => ({
  source: SOURCE,
  materials: [
    { key: `RES-${RUN}`, name: `PP Homopolymer ${RUN}`, weightUnits: "KG" },
    { key: `CLR-${RUN}`, name: `Black masterbatch ${RUN}`, weightUnits: "KG" },
  ],
  products: [
    {
      key: `P1-${RUN}`,
      name: overrides.productName ?? `Cap 38mm ${RUN}`,
      weight: 4.2,
      weightUnits: "G",
      materials: [
        { material: `RES-${RUN}`, weight: 4.1, weightUnits: "G" },
        { material: `CLR-${RUN}`, weight: 0.1, weightUnits: "G" },
      ],
    },
    { key: `P2-${RUN}`, name: `Closure ${RUN}` },
  ],
});

describe.skipIf(!process.env.TEST_DATABASE_URL)("setup changesets (Tier 2)", () => {
  let server: TestServer;
  let siteId: string;
  let memberToken: string;
  let viewerToken: string;
  let adminToken: string;

  async function siteToken(email: string, password: string) {
    const login = await loginAs(server, email, password);
    const switched = await server.inject({
      method: "POST",
      url: "/auth/switch-site",
      headers: { authorization: `Bearer ${login.accessToken}` },
      payload: { siteId },
    });
    return (switched.json() as { accessToken: string }).accessToken;
  }

  async function propose(body: unknown, token = memberToken) {
    return rpcCall(server, "setup/changeset/create", { siteId, title: "test import", spec: body }, token);
  }

  /** A small import of its own: two materials, two products with BOM links. */
  const ownSpec = (tag: string, count = 2) => ({
    source: SOURCE,
    materials: [
      { key: `${tag}-M1-${RUN}`, name: `Resin ${tag}`, weightUnits: "KG" },
      { key: `${tag}-M2-${RUN}`, name: `Colour ${tag}`, weightUnits: "KG" },
    ],
    products: Array.from({ length: count }, (_, i) => ({
      key: `${tag}-P${i}-${RUN}`,
      name: `Part ${tag} ${i}`,
      weight: 3,
      weightUnits: "G",
      materials: [
        { material: `${tag}-M1-${RUN}`, weight: 2.9, weightUnits: "G" },
        { material: `${tag}-M2-${RUN}`, weight: 0.1, weightUnits: "G" },
      ],
    })),
  });

  async function proposeAndApply(body: unknown) {
    const proposed = await propose(body);
    expect(proposed.statusCode).toBe(200);
    const { id } = proposed.json as { id: string };
    const applied = await rpcCall(server, "setup/changeset/apply", { id }, memberToken);
    expect(applied.statusCode).toBe(200);
    return { id, status: (applied.json as { status: string }).status };
  }

  /** Wait for a background apply or rollback to settle; returns the changeset. */
  async function settled(id: string) {
    for (let i = 0; i < 200; i++) {
      const got = await rpcCall(server, "setup/changeset/get", { id }, memberToken);
      const body = got.json as { status: string } & Record<string, unknown>;
      if (body.status !== "APPLYING" && body.status !== "ROLLING_BACK") return body;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error("still running");
  }

  const productByKey = (key: string) =>
    prisma.product.findFirst({ where: { siteId, currentVersion: { sku: key } }, include: { currentVersion: true } });

  /** A changeset's planned rows, as the review page pages them. */
  async function rowsOf(id: string, filter: Record<string, unknown> = {}) {
    const page = await rpcCall(server, "setup/changeset/rows", { id, limit: 500, ...filter }, memberToken);
    expect(page.statusCode).toBe(200);
    return (page.json as { total: number; rows: SetupRow[] }).rows;
  }

  beforeAll(async () => {
    server = buildServer();
    await server.ready();
    siteId = (await prisma.site.findFirstOrThrow({ where: { name: "Rockware" }, select: { id: true } })).id;
    await makeUser(MEMBER.email, MEMBER.password, { plants: [{ siteId, level: "MANAGE" }] });
    await makeUser(VIEWER.email, VIEWER.password, { plants: [{ siteId, level: "VIEW" }] });
    await makeUser(ADMIN.email, ADMIN.password, { plants: [{ siteId, level: "ADMIN" }] });
    memberToken = await siteToken(MEMBER.email, MEMBER.password);
    viewerToken = await siteToken(VIEWER.email, VIEWER.password);
    adminToken = await siteToken(ADMIN.email, ADMIN.password);
  }, 30_000);

  afterAll(async () => {
    await prisma.externalRef.deleteMany({ where: { source: SOURCE } });
    await prisma.setupChangeset.deleteMany({ where: { source: SOURCE } });
    await prisma.user.deleteMany({ where: { email: { in: [MEMBER.email, VIEWER.email, ADMIN.email] } } });
    await server.close();
  });

  it("needs MANAGE to propose", async () => {
    expect((await propose(spec(), viewerToken)).statusCode).toBe(403);
  });

  it("plans creates, applies them in one go, and a re-run comes back unchanged", async () => {
    const proposed = await propose(spec());
    expect(proposed.statusCode).toBe(200);
    const { id, plan } = proposed.json as { id: string; plan: SetupPlan };
    expect(plan.applicable).toBe(true);
    expect(plan.summary).toMatchObject({ material: { create: 2 }, product: { create: 2 } });
    const cap = (await rowsOf(id)).find((row) => row.key === `P1-${RUN}`);
    expect(cap?.links?.map((link) => link.action)).toEqual(["create", "create"]);

    const applied = await rpcCall(server, "setup/changeset/apply", { id }, memberToken);
    expect(applied.statusCode).toBe(200);

    const product = await prisma.product.findFirstOrThrow({
      where: { siteId, currentVersion: { sku: `P1-${RUN}` } },
      include: { currentVersion: true, materials: true },
    });
    expect(product.currentVersion?.name).toBe(`Cap 38mm ${RUN}`);
    expect(product.materials).toHaveLength(2);
    expect(await prisma.externalRef.count({ where: { source: SOURCE } })).toBe(4);
    expect(
      await prisma.auditLog.count({ where: { action: "SETUP_CHANGESET_APPLIED", metadata: { path: ["changesetId"], equals: id } } }),
    ).toBe(1);

    // Already up to date: planned, but not saved for anyone to review.
    const saved = await prisma.setupChangeset.count({ where: { source: SOURCE } });
    const again = await propose(spec());
    const rerun = again.json as { id: string | null; plan: SetupPlan };
    expect(rerun.id).toBeNull();
    expect(rerun.plan.summary.material).toMatchObject({ create: 0, update: 0, unchanged: 2 });
    expect(rerun.plan.summary.product).toMatchObject({ create: 0, update: 0, unchanged: 2 });
    expect(await prisma.setupChangeset.count({ where: { source: SOURCE } })).toBe(saved);
  });

  it("plans a changed field as an update with its diff", async () => {
    const proposed = await propose(spec({ productName: `Cap 38mm v2 ${RUN}` }));
    const cap = (await rowsOf((proposed.json as { id: string }).id, { action: "update" })).find(
      (row) => row.key === `P1-${RUN}`,
    );
    expect(cap).toMatchObject({ action: "update", matchedBy: "ref" });
    expect(cap?.changes).toEqual([{ field: "name", from: `Cap 38mm ${RUN}`, to: `Cap 38mm v2 ${RUN}` }]);
  });

  it("finds a record made by hand through its natural key", async () => {
    const sku = `HAND-${RUN}`;
    await rpcCall(server, "product/create", { siteId, sku, name: "Made by hand" }, memberToken);
    const proposed = await propose({ source: SOURCE, products: [{ key: sku, name: "Made by hand, renamed" }] });
    const [row] = await rowsOf((proposed.json as { id: string }).id);
    expect(row).toMatchObject({ action: "update", matchedBy: "natural" });
  });

  it("reports duplicates and unknown materials instead of guessing", async () => {
    const proposed = await propose({
      source: SOURCE,
      materials: [
        { key: `DUP-${RUN}`, name: "a" },
        { key: `DUP-${RUN}`, name: "b" },
      ],
      products: [{ key: `P3-${RUN}`, materials: [{ material: `NOPE-${RUN}` }] }],
    });
    const { plan, problems } = proposed.json as { plan: SetupPlan; problems: SetupRow[] };
    expect(plan.applicable).toBe(false);
    const codes = problems.flatMap((row) => row.issues.map((issue) => issue.code));
    expect(codes).toContain("DUPLICATE_KEY");
    expect(codes).toContain("UNKNOWN_MATERIAL");

    const id = (proposed.json as { id: string }).id;
    const applied = await rpcCall(server, "setup/changeset/apply", { id }, memberToken);
    expect(applied.statusCode).toBe(400);
  });

  it("refuses to apply a plan the plant has moved away from, and keeps the fresh plan", async () => {
    const proposed = await propose(spec({ productName: `Cap stale ${RUN}` }));
    const { id } = proposed.json as { id: string };
    const product = await prisma.product.findFirstOrThrow({ where: { siteId, currentVersion: { sku: `P1-${RUN}` } } });
    await rpcCall(server, "product/update", { id: product.id, name: `Renamed in IMM ${RUN}` }, memberToken);

    const applied = await rpcCall(server, "setup/changeset/apply", { id }, memberToken);
    expect(applied.statusCode).toBe(409);
    const after = await rpcCall(server, "setup/changeset/get", { id }, memberToken);
    const body = after.json as { status: string; plan: SetupPlan };
    expect(body.status).toBe("DRAFT");
    const cap = (await rowsOf(id)).find((row) => row.key === `P1-${RUN}`);
    expect(cap?.changes[0]).toMatchObject({ from: `Renamed in IMM ${RUN}`, to: `Cap stale ${RUN}` });
  });

  async function upload(filename: string, csv: string, token = memberToken) {
    const created = await rpcCall(server, "setup/upload/create", { siteId, filename }, token);
    expect(created.statusCode).toBe(200);
    const { id, token: uploadToken, path } = created.json as { id: string; token: string; path: string };
    const sent = await server.inject({
      method: "PUT",
      url: path,
      headers: { "x-upload-token": uploadToken, "content-type": "text/csv" },
      payload: csv,
    });
    expect(sent.statusCode).toBe(200);
    return { id, uploadToken, path };
  }

  it("takes an upload once, with its token only", async () => {
    const created = await rpcCall(server, "setup/upload/create", { siteId, filename: "x.csv" }, memberToken);
    const { token, path } = created.json as { token: string; path: string };
    const put = (headers: Record<string, string>) =>
      server.inject({ method: "PUT", url: path, headers: { "content-type": "text/csv", ...headers }, payload: "a,b\n1,2\n" });
    expect((await put({})).statusCode).toBe(401);
    expect((await put({ "x-upload-token": "rw_upl_wrong" })).statusCode).toBe(401);
    expect((await put({ "x-upload-token": token })).statusCode).toBe(200);
    expect((await put({ "x-upload-token": token })).statusCode).toBe(409);
    expect((await rpcCall(server, "setup/upload/create", { siteId, filename: "x.csv" }, viewerToken)).statusCode).toBe(403);
  });

  it("builds an import from uploaded files and a column mapping, pointing problems at file lines", async () => {
    const materials = await upload(
      "materials.csv",
      [`Item No;Description;UoM;Std Cost`, `FM1-${RUN};"Resin; natural";kgs;"1.234,50"`, `FM2-${RUN};Colorant;Kilo;6,10`].join("\r\n"),
    );
    const products = await upload(
      "products.csv",
      [
        "Part No,Part Name,Shot Weight (g),Resin,Resin (g)",
        `FP1-${RUN},Cap,4.2,FM1-${RUN},4.1`,
        `FP2-${RUN},Lid,heavy,FM1-${RUN},`,
        `FP3-${RUN},Spout,3.1,,`,
      ].join("\n"),
    );
    const bom = await upload("bom.csv", ["Parent,Component,Qty", `FP1-${RUN},FM2-${RUN},0.1`, `NOPE-${RUN},FM2-${RUN},1`].join("\n"));

    const proposed = await rpcCall(
      server,
      "setup/changeset/create",
      {
        siteId,
        title: "from files",
        source: `${SOURCE}-files`,
        files: {
          numbers: { decimal: "," },
          materials: {
            upload: materials.id,
            columns: { key: "Item No", name: "Description", weightUnits: "UoM", unitCost: "Std Cost" },
          },
          products: {
            upload: products.id,
            columns: { key: "Part No", name: "Part Name", weight: "Shot Weight (g)", weightUnits: { value: "G" } },
            materials: [{ material: "Resin", weight: "Resin (g)", weightUnits: { value: "G" } }],
          },
          bom: {
            upload: bom.id,
            columns: { product: "Parent", material: "Component", weight: "Qty", weightUnits: { value: "G" } },
          },
        },
      },
      memberToken,
    );
    expect(proposed.statusCode).toBe(200);
    const { id, plan } = proposed.json as { id: string; plan: SetupPlan };
    expect(plan.summary).toMatchObject({ material: { create: 2 }, product: { create: 3 } });
    // "heavy" isn't a number (decimal "," reads 4.2 as 42, which is still a number), and NOPE isn't in the import.
    expect(plan.applicable).toBe(false);
    expect(plan.issues.map((issue) => [issue.code, issue.path])).toEqual([
      ["BAD_VALUE", "products.csv line 3, weight"],
      ["UNKNOWN_PRODUCT", "bom.csv line 3, product"],
    ]);

    const rows = await rowsOf(id);
    const resin = rows.find((row) => row.key === `FM1-${RUN}`);
    expect(resin?.origin).toEqual({ file: "materials.csv", line: 2 });
    expect(resin?.changes).toEqual(
      expect.arrayContaining([
        { field: "name", from: null, to: "Resin; natural" },
        { field: "weightUnits", from: null, to: "KG" },
        { field: "unitCost", from: null, to: 1234.5 },
      ]),
    );
    const cap = rows.find((row) => row.key === `FP1-${RUN}`);
    expect(cap?.origin).toEqual({ file: "products.csv", line: 2 });
    expect(cap?.links?.map((link) => link.materialKey)).toEqual([`FM1-${RUN}`, `FM2-${RUN}`]);
    expect(rows.find((row) => row.key === `FP3-${RUN}`)?.links).toEqual([]);

    // The file's problems stay until the files are fixed and proposed again.
    const replanned = await rpcCall(server, "setup/changeset/replan", { id }, memberToken);
    expect((replanned.json as { plan: SetupPlan }).plan.applicable).toBe(false);
    expect((await rpcCall(server, "setup/changeset/apply", { id }, memberToken)).statusCode).toBe(400);

    const page = await rpcCall(server, "setup/changeset/rows", { id, entity: "product", q: "spout" }, memberToken);
    expect((page.json as { total: number }).total).toBe(1);

    // A value that couldn't be read is pinned on the row from its line; a line that became no row isn't.
    const lid = (await rowsOf(id)).find((row) => row.key === `FP2-${RUN}`);
    expect(lid?.issues).toEqual([
      expect.objectContaining({ code: "BAD_VALUE", at: { file: "products.csv", line: 3, column: "weight" } }),
    ]);
    const pinned = (replanned.json as { plan: SetupPlan }).plan.issues;
    expect(pinned[0]).toMatchObject({ code: "BAD_VALUE", row: { entity: "product", key: `FP2-${RUN}` } });
    expect(pinned[1]).toMatchObject({ code: "UNKNOWN_PRODUCT", at: { file: "bom.csv", line: 3 } });
    expect(pinned[1]?.row).toBeUndefined();

    // Rows page by file, and "problems" finds the rows that need fixing whatever their action.
    const fromProducts = await rpcCall(server, "setup/changeset/rows", { id, file: "products.csv" }, memberToken);
    expect((fromProducts.json as { total: number }).total).toBe(3);
    const toFix = await rpcCall(server, "setup/changeset/rows", { id, problems: true }, memberToken);
    expect((toFix.json as { rows: Array<{ key: string }> }).rows.map((row) => row.key)).toEqual([`FP2-${RUN}`]);

    const detail = (await rpcCall(server, "setup/changeset/get", { id }, memberToken)).json as {
      fileTotals: Array<{ file: string; counts: Record<string, number>; problems: number }>;
      history: Array<{ kind: string; by: string | null; files: string[] | null }>;
    };
    expect(detail.fileTotals).toEqual([
      { file: "materials.csv", counts: { create: 2, update: 0, unchanged: 0, conflict: 0 }, problems: 0 },
      { file: "products.csv", counts: { create: 3, update: 0, unchanged: 0, conflict: 0 }, problems: 1 },
    ]);
    // What happened, from the audit log: proposed with its files, then checked again.
    expect(detail.history.map((event) => event.kind)).toEqual(["proposed", "checked"]);
    expect(detail.history[0]?.files).toEqual(["materials.csv", "products.csv", "bom.csv"]);
  });

  it("names the columns a file has when the mapping gets one wrong", async () => {
    const file = await upload("parts.csv", "Part No,Name\nX1,Thing\n");
    const proposed = await rpcCall(
      server,
      "setup/changeset/create",
      {
        siteId,
        title: "bad mapping",
        source: SOURCE,
        files: { products: { upload: file.id, columns: { key: "Part Number" } } },
      },
      memberToken,
    );
    expect(proposed.statusCode).toBe(400);
    expect(JSON.stringify(proposed.json)).toContain('Its columns are: \\"Part No\\", \\"Name\\"');
  });

  it("sends anything over the inline limit to uploads", async () => {
    const products = Array.from({ length: 2001 }, (_, i) => ({ key: `BIG-${RUN}-${i}` }));
    const proposed = await propose({ source: SOURCE, products });
    expect(proposed.statusCode).toBe(400);
    expect(JSON.stringify(proposed.json)).toContain("Upload the files instead");
  });

  it("applies a big import a chunk at a time in the background", async () => {
    const body = ownSpec("BIG", 620);
    const { id, status } = await proposeAndApply(body);
    expect(status).toBe("APPLYING");
    const done = await settled(id);
    expect(done.status).toBe("APPLIED");
    expect(done.progress).toMatchObject({ phase: "apply", total: 622, done: 622, written: 622 });
    expect(await prisma.product.count({ where: { siteId, currentVersion: { sku: { startsWith: "BIG-P", endsWith: RUN } } } })).toBe(620);
    expect(await prisma.setupChangesetWrite.count({ where: { changesetId: id, entity: "link" } })).toBe(1240);
    expect(
      await prisma.auditLog.count({ where: { action: "SETUP_CHANGESET_APPLIED", metadata: { path: ["changesetId"], equals: id } } }),
    ).toBe(1);
  }, 120_000);

  it("rolls an import back: deletes what it made, restores what it changed, skips what changed since", async () => {
    const first = await proposeAndApply(ownSpec("RB"));
    // A second import renames one part and adds a third.
    const second = ownSpec("RB", 3);
    second.products[0]!.name = "Part RB 0, renamed";
    const { id } = await proposeAndApply(second);
    // Someone edits the new part by hand afterwards.
    const added = await productByKey(`RB-P2-${RUN}`);
    await rpcCall(server, "product/update", { id: added!.id, name: "Edited by hand" }, memberToken);

    const rolled = await rpcCall(server, "setup/changeset/rollback", { id }, memberToken);
    expect(rolled.statusCode).toBe(200);
    const done = (await settled(id)) as { status: string; journal: { skipped: Array<{ key: string; reason: string }> } };
    expect(done.status).toBe("ROLLED_BACK");
    expect((await productByKey(`RB-P0-${RUN}`))?.currentVersion?.name).toBe("Part RB 0");
    // Changed since: left alone, with the reason; so are its links' material refs' targets.
    const kept = await productByKey(`RB-P2-${RUN}`);
    expect(kept?.deletedAt).toBeNull();
    expect(done.journal.skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: `RB-P2-${RUN}`, reason: expect.stringContaining("Changed since") }),
      ]),
    );
    // ...and keeps its materials list with it.
    expect(await prisma.productMaterial.count({ where: { productId: kept!.id } })).toBe(2);
    // The first import is untouched and can still be rolled back on its own.
    expect((await productByKey(`RB-P1-${RUN}`))?.deletedAt).toBeNull();
    expect(
      await prisma.auditLog.count({ where: { action: "SETUP_CHANGESET_ROLLED_BACK", metadata: { path: ["changesetId"], equals: id } } }),
    ).toBe(1);

    const again = await rpcCall(server, "setup/changeset/rollback", { id: first.id }, memberToken);
    expect(again.statusCode).toBe(200);
    expect((await settled(first.id)).status).toBe("ROLLED_BACK");
    const gone = await prisma.product.findFirst({ where: { siteId, currentVersion: { sku: `RB-P1-${RUN}` } } });
    expect(gone?.deletedAt).not.toBeNull();
    expect(await prisma.externalRef.count({ where: { source: SOURCE, key: `RB-P1-${RUN}` } })).toBe(0);
  });

  it("removes an import completely, for plant admins only, and clears its data", async () => {
    const { id } = await proposeAndApply(ownSpec("RM"));
    const made = await productByKey(`RM-P0-${RUN}`);
    expect((await rpcCall(server, "setup/changeset/rollback", { id, mode: "remove" }, memberToken)).statusCode).toBe(403);

    const removed = await rpcCall(server, "setup/changeset/rollback", { id, mode: "remove" }, adminToken);
    expect(removed.statusCode).toBe(200);
    const done = (await settled(id)) as { status: string; clearedAt: string | null; journal: { outcomes: Record<string, number> } };
    expect(done.status).toBe("ROLLED_BACK");
    expect(done.clearedAt).not.toBeNull();
    expect(await prisma.product.findUnique({ where: { id: made!.id } })).toBeNull();
    expect(await prisma.productVersion.count({ where: { productId: made!.id } })).toBe(0);
    expect(await prisma.stockItem.count({ where: { stockableId: made!.id } })).toBe(0);
    expect(await prisma.material.count({ where: { siteId, currentVersion: { materialNumber: `RM-M1-${RUN}` } } })).toBe(0);
    expect(await prisma.setupChangesetWrite.count({ where: { changesetId: id } })).toBe(0);
    expect(
      await prisma.auditLog.count({ where: { action: "SETUP_CHANGESET_CLEARED", metadata: { path: ["changesetId"], equals: id } } }),
    ).toBe(1);
  });

  it("puts a changed record back on its earlier version when an import is removed completely", async () => {
    await proposeAndApply(ownSpec("RV"));
    const before = await productByKey(`RV-P0-${RUN}`);
    const renamed = ownSpec("RV");
    renamed.products[0]!.name = "Renamed by import";
    const { id } = await proposeAndApply(renamed);
    await rpcCall(server, "setup/changeset/rollback", { id, mode: "remove" }, adminToken);
    await settled(id);
    const after = await productByKey(`RV-P0-${RUN}`);
    expect(after?.currentVersionId).toBe(before?.currentVersionId);
    expect(after?.currentVersion?.name).toBe("Part RV 0");
  });

  it("keeps the import's version when removing completely if a disposition was logged against it", async () => {
    await proposeAndApply(ownSpec("DL"));
    const before = await productByKey(`DL-P0-${RUN}`);
    const renamed = ownSpec("DL");
    renamed.products[0]!.name = "Renamed before scrap was logged";
    const { id } = await proposeAndApply(renamed);
    const imported = await productByKey(`DL-P0-${RUN}`);
    const station = await prisma.station.create({ data: { siteId, name: `DL station ${RUN}` } });
    await prisma.itemDispositionLog.create({
      data: { siteId, stationId: station.id, productId: imported!.id, productVersionId: imported!.currentVersionId! },
    });

    await rpcCall(server, "setup/changeset/rollback", { id, mode: "remove" }, adminToken);
    expect((await settled(id)).status).toBe("ROLLED_BACK");
    const after = await productByKey(`DL-P0-${RUN}`);
    expect(after?.currentVersionId).toBe(before?.currentVersionId);
    expect(await prisma.productVersion.count({ where: { id: imported!.currentVersionId! } })).toBe(1);
  });

  it("stops a rollback with an entry it can't undo, keeps the rest undone, and carries on when rolled back again", async () => {
    await proposeAndApply(ownSpec("SF"));
    const before = await productByKey(`SF-P0-${RUN}`);
    const changed = ownSpec("SF", 3);
    changed.products[0]!.name = "Renamed, then removed";
    const { id } = await proposeAndApply(changed);
    // Point the rename's journal entry at a version that doesn't exist, so undoing it throws.
    const entry = await prisma.setupChangesetWrite.findFirstOrThrow({
      where: { changesetId: id, entity: "product", action: "update", entityId: before!.id },
    });
    await prisma.setupChangesetWrite.update({ where: { id: entry.id }, data: { beforeVersionId: randomUUID() } });

    const first = await rpcCall(server, "setup/changeset/rollback", { id, mode: "remove" }, adminToken);
    expect(first.statusCode).toBe(200);
    const stopped = (await settled(id)) as {
      status: string;
      clearedAt: string | null;
      canRollBack: boolean;
      journal: { failed: Array<{ key: string; reason: string }> };
    };
    expect(stopped.status).toBe("ROLLBACK_STOPPED");
    expect(stopped.clearedAt).toBeNull();
    // A stopped rollback can be carried on.
    expect(stopped.canRollBack).toBe(true);
    expect(stopped.journal.failed).toEqual([
      expect.objectContaining({ key: `SF-P0-${RUN}`, reason: expect.stringContaining("Couldn't undo") }),
    ]);
    // The rest of the chunk went through: the part the import added is gone.
    expect(await productByKey(`SF-P2-${RUN}`)).toBeNull();
    // The failed entry left its record as the import made it.
    expect((await productByKey(`SF-P0-${RUN}`))?.currentVersion?.name).toBe("Renamed, then removed");

    // Fixed; removing again retries just that entry and finishes.
    await prisma.setupChangesetWrite.update({
      where: { id: entry.id },
      data: { beforeVersionId: entry.beforeVersionId },
    });
    const again = await rpcCall(server, "setup/changeset/rollback", { id, mode: "remove" }, adminToken);
    expect(again.statusCode).toBe(200);
    expect((await settled(id)).status).toBe("ROLLED_BACK");
    expect((await productByKey(`SF-P0-${RUN}`))?.currentVersionId).toBe(before?.currentVersionId);
  });

  it("puts a material's stock back on its earlier unit when an import that changed it is removed completely", async () => {
    await proposeAndApply(ownSpec("SU"));
    const material = await prisma.material.findFirstOrThrow({
      where: { siteId, currentVersion: { materialNumber: `SU-M1-${RUN}` } },
    });
    const stockUnit = async () =>
      (
        await prisma.stockItem.findUniqueOrThrow({
          where: { stockableType_stockableId: { stockableType: "MATERIAL", stockableId: material.id } },
        })
      ).baseUnit;
    expect(await stockUnit()).toBe("KG");

    const relabelled = ownSpec("SU");
    relabelled.materials[0]!.weightUnits = "LB";
    const { id } = await proposeAndApply(relabelled);
    expect(await stockUnit()).toBe("LB");

    await rpcCall(server, "setup/changeset/rollback", { id, mode: "remove" }, adminToken);
    await settled(id);
    const after = await prisma.material.findUniqueOrThrow({ where: { id: material.id }, include: { currentVersion: true } });
    expect(after.currentVersion?.weightUnits).toBe("KG");
    expect(await stockUnit()).toBe("KG");
  });

  it("clears an applied import's data but keeps its record, and then can't roll it back", async () => {
    const { id, status } = await proposeAndApply(ownSpec("CL"));
    // One chunk was the whole import: done before the request answered.
    expect(status).toBe("APPLIED");
    const cleared = await rpcCall(server, "setup/changeset/clear", { id }, memberToken);
    expect(cleared.statusCode).toBe(200);
    const row = await prisma.setupChangeset.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ status: "APPLIED", spec: null });
    expect(row.clearedAt).not.toBeNull();
    expect(await prisma.setupChangesetRow.count({ where: { changesetId: id } })).toBe(0);
    expect(await prisma.setupChangesetWrite.count({ where: { changesetId: id } })).toBe(0);
    expect((await productByKey(`CL-P0-${RUN}`))?.deletedAt).toBeNull();
    expect((await rpcCall(server, "setup/changeset/rollback", { id }, memberToken)).statusCode).toBe(400);
  });

  it("lets a connected agent propose and revise, never apply", async () => {
    const person = await prisma.user.findUniqueOrThrow({ where: { email: MEMBER.email }, select: { id: true } });
    const site = await prisma.site.findUniqueOrThrow({ where: { id: siteId }, select: { workspaceId: true } });
    const current = await loadUserCurrent(person.id, site.workspaceId, siteId);
    if (current?.kind !== "user") throw new Error("expected a user");
    const client = (scopes: string[]) =>
      createRouterClient(router, {
        context: {
          request: { headers: {} },
          current: { ...current, via: { kind: "oauth" as const, grantId: randomUUID(), clientId: "c", clientName: "Claude Code", scopes } },
          access: current.access,
        },
      });

    await expect(
      client(["read"]).setup.changeset.create({ siteId, title: "read only", spec: spec() as never }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const agent = client(["read", "setup:propose"]);
    const proposal = await agent.setup.changeset.create({
      siteId,
      title: "from an agent",
      spec: spec({ productName: `Cap from an agent ${RUN}` }) as never,
    });
    if (!proposal.id) throw new Error("expected a saved proposal");
    const created = { id: proposal.id };
    const row = await prisma.setupChangeset.findUniqueOrThrow({ where: { id: created.id } });
    expect(row).toMatchObject({ author: "AGENT", clientName: "Claude Code" });

    await expect(agent.setup.changeset.replan({ id: created.id })).resolves.toBeDefined();
    // A fix goes to the same import: same id, new rows, and its history says so.
    const revised = await agent.setup.changeset.revise({
      id: created.id,
      spec: spec({ productName: `Cap, fixed ${RUN}` }) as never,
    });
    expect(revised.id).toBe(created.id);
    const afterRevise = await agent.setup.changeset.get({ id: created.id });
    expect(afterRevise.history.map((event) => event.kind)).toEqual(["proposed", "checked", "revised"]);
    expect(afterRevise.history[2]).toMatchObject({ via: "Claude Code" });
    const fixed = await agent.setup.changeset.rows({ id: created.id, q: "fixed" });
    expect(fixed.total).toBe(1);
    await expect(agent.setup.changeset.apply({ id: created.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(agent.setup.changeset.rollback({ id: created.id, mode: "rollback" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(agent.setup.changeset.clear({ id: created.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const detail = await agent.setup.changeset.get({ id: created.id });
    expect(detail.canApply).toBe(false);
  });
});
