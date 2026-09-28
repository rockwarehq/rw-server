import prisma from "@rw/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureWorkcenterBucket, makeUser } from "./helpers/access.js";
import { buildServer, loginAs, type TestServer } from "./helpers/build-server.js";
import { rpcCall } from "./helpers/rpc-call.js";

const MANAGER_EMAIL = "decks-manager@test.local";
const OUTSIDER_EMAIL = "decks-outsider@test.local";
const PASSWORD = "decks-password-1";
const DAY_MS = 86_400_000;

const dateOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

// Tier 2: report decks (ADR-0018) — a deck, an edition made from it, and a
// link that opens the edition without signing in.
describe.skipIf(!process.env.TEST_DATABASE_URL)("report decks (Tier 2)", () => {
  let server: TestServer;
  let siteId: string;
  let workcenterId: string;
  let otherWorkcenterId: string;
  let managerToken: string;
  let outsiderToken: string;
  let deckId: string;
  const yesterday = dateOf(Date.now() - DAY_MS);

  beforeAll(async () => {
    server = buildServer();
    await server.ready();
    const site = await prisma.site.findFirstOrThrow({ where: { name: "Rockware" }, select: { id: true, workspaceId: true } });
    siteId = site.id;
    const workcenter = async (name: string) => {
      const row =
        (await prisma.workcenter.findFirst({ where: { siteId, name }, select: { id: true } })) ??
        (await prisma.workcenter.create({ data: { name, siteId }, select: { id: true } }));
      await ensureWorkcenterBucket(site.workspaceId, siteId, row.id, name);
      return row.id;
    };
    workcenterId = await workcenter("decks-wc");
    otherWorkcenterId = await workcenter("decks-wc-other");

    // Yesterday's one shift, finished.
    const pattern = await prisma.shiftPattern.create({ data: { name: "decks-pattern", siteId }, select: { id: true } });
    const assignment = await prisma.shiftAssignment.create({
      data: { patternId: pattern.id, siteId, workCenterId: workcenterId, rotationStartDate: new Date("2026-01-01") },
      select: { id: true },
    });
    await prisma.shiftInstance.create({
      data: {
        assignmentId: assignment.id,
        siteId,
        workCenterId: workcenterId,
        shiftName: "1st",
        businessDate: new Date(yesterday),
        startTime: new Date(`${yesterday}T00:00:00Z`),
        endTime: new Date(`${yesterday}T08:00:00Z`),
      },
    });

    await makeUser(MANAGER_EMAIL, PASSWORD, { workcenters: [{ workcenterId, level: "MANAGE" }] });
    await makeUser(OUTSIDER_EMAIL, PASSWORD, { workcenters: [{ workcenterId: otherWorkcenterId, level: "MANAGE" }] });
    managerToken = (await loginAs(server, MANAGER_EMAIL, PASSWORD)).accessToken;
    outsiderToken = (await loginAs(server, OUTSIDER_EMAIL, PASSWORD)).accessToken;
  }, 30_000);

  afterAll(async () => {
    await prisma.reportDeckLink.deleteMany({ where: { siteId } });
    await prisma.reportDeck.deleteMany({ where: { workcenterId: { in: [workcenterId, otherWorkcenterId] } } });
    await prisma.user.deleteMany({ where: { email: { in: [MANAGER_EMAIL, OUTSIDER_EMAIL] } } });
    await prisma.shiftInstance.deleteMany({ where: { workCenterId: workcenterId } });
    await prisma.shiftAssignment.deleteMany({ where: { workCenterId: workcenterId } });
    await prisma.shiftPattern.deleteMany({ where: { siteId, name: "decks-pattern" } });
    await server.close();
  });

  it("creates a deck for a workcenter the caller manages, and no other", async () => {
    const slides = [
      {
        id: "s1",
        kind: "explore",
        title: "Cycles",
        params: {},
        queries: {
          result: { mode: "query", fact: "cycles", measures: ["cycles"], dimensions: [] },
          log: { mode: "rows", fact: "cycles", columns: ["station", "start"] },
        },
      },
    ];
    const created = await rpcCall(
      server,
      "deck/create",
      { siteId, name: "Decks test", range: "yesterday", workcenterId, slides },
      managerToken,
    );
    expect(created.statusCode).toBe(200);
    deckId = (created.json as { id: string }).id;

    const elsewhere = await rpcCall(
      server,
      "deck/create",
      { siteId, name: "Nope", range: "yesterday", workcenterId: otherWorkcenterId, slides: [] },
      managerToken,
    );
    expect(elsewhere.statusCode).toBe(403);
    expect((await rpcCall(server, "deck/get", { id: deckId }, outsiderToken)).statusCode).toBe(403);
  });

  it("makes an edition covering yesterday with every query's results stored", async () => {
    const made = await rpcCall(server, "deck/makeEdition", { deckId }, managerToken);
    expect(made.statusCode).toBe(200);
    const edition = await rpcCall(server, "deck/getEdition", { id: (made.json as { id: string }).id }, managerToken);
    const body = edition.json as {
      dateFrom: string;
      dateTo: string;
      pages: { results: Record<string, { rows?: unknown[]; total?: number }> }[];
      facts: Record<string, unknown>;
    };
    expect(body).toMatchObject({ dateFrom: yesterday, dateTo: yesterday });
    expect(body.pages[0]?.results.result?.rows).toHaveLength(1);
    expect(body.pages[0]?.results.log).toMatchObject({ rows: [], total: 0 });
    expect(Object.keys(body.facts)).toEqual(["cycles"]);
  });

  it("opens an edition from a link without signing in, until it is revoked", async () => {
    const [edition] = (await rpcCall(server, "deck/listEditions", { deckId }, managerToken)).json as { id: string }[];
    const link = await rpcCall(
      server,
      "deck/createLink",
      { editionIds: [edition!.id], label: "Decks test", expiresInHours: 168 },
      managerToken,
    );
    const { id, token } = link.json as { id: string; token: string };

    const opened = await rpcCall(server, "deck/viewLink", { token });
    expect(opened.statusCode).toBe(200);
    expect((opened.json as { editions: unknown[] }).editions).toHaveLength(1);
    expect((await rpcCall(server, "deck/viewLink", { token: `${token}x` })).statusCode).toBe(404);

    expect((await rpcCall(server, "deck/revokeLink", { id }, outsiderToken)).statusCode).toBe(403);
    expect((await rpcCall(server, "deck/revokeLink", { id }, managerToken)).statusCode).toBe(200);
    expect((await rpcCall(server, "deck/viewLink", { token })).statusCode).not.toBe(200);
  });
});
