import { randomUUID } from "node:crypto";
import type { ActionContext } from "@rw/automations";
import prisma from "@rw/db";
import * as notification from "@rw/services/notification/index";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handler as makeEditions } from "../src/automations/actions/deck-make-editions.js";
import { handler as sendLatest } from "../src/automations/actions/deck-send-latest.js";
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

  it("says which days the deck covers now", async () => {
    const span = await rpcCall(server, "deck/span", { range: "yesterday-7", workcenterId }, managerToken);
    expect(span.json).toMatchObject({ dateTo: yesterday, shifts: [{ shiftName: "1st" }] });
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

  it("keeps shift recaps out of the Decks list, and lists them by kind", async () => {
    const recap = await rpcCall(
      server,
      "deck/create",
      {
        siteId,
        kind: "SHIFT_RECAP",
        name: "decks-wc 1st shift recap",
        range: "last-shift",
        workcenterId,
        slides: [{ id: "r1", kind: "shift-recap", title: "Shift recap", shiftNames: ["1st"] }],
      },
      managerToken,
    );
    expect(recap.statusCode).toBe(200);
    const recapId = (recap.json as { id: string }).id;

    const decks = (await rpcCall(server, "deck/list", { siteId }, managerToken)).json as { id: string }[];
    expect(decks.map((deck) => deck.id)).not.toContain(recapId);
    const recaps = (await rpcCall(server, "deck/list", { siteId, kind: "SHIFT_RECAP", workcenterId }, managerToken))
      .json as { id: string }[];
    expect(recaps.map((deck) => deck.id)).toEqual([recapId]);

    // A recap is one recap page over the last shift; a deck never is.
    const toDays = await rpcCall(server, "deck/update", { id: recapId, range: "yesterday" }, managerToken);
    expect(toDays.statusCode).toBe(400);
    const deckOverShift = await rpcCall(
      server,
      "deck/create",
      { siteId, name: "Nope", range: "last-shift", workcenterId, slides: [] },
      managerToken,
    );
    expect(deckOverShift.statusCode).toBe(400);
  });

  it("makes a recap edition as of an earlier moment: that shift's, not the latest", async () => {
    const [recap] = (await rpcCall(server, "deck/list", { siteId, kind: "SHIFT_RECAP" }, managerToken)).json as {
      id: string;
    }[];
    // An older "1st" shift, three days back, beside yesterday's.
    const earlier = dateOf(Date.now() - 3 * DAY_MS);
    const assignment = await prisma.shiftAssignment.findFirstOrThrow({
      where: { workCenterId: workcenterId },
      select: { id: true },
    });
    const shift = await prisma.shiftInstance.create({
      data: {
        assignmentId: assignment.id,
        siteId,
        workCenterId: workcenterId,
        shiftName: "1st",
        businessDate: new Date(earlier),
        startTime: new Date(`${earlier}T00:00:00Z`),
        endTime: new Date(`${earlier}T08:00:00Z`),
      },
      select: { id: true },
    });
    try {
      const pagesOf = async (editionId: string) =>
        (
          (await rpcCall(server, "deck/getEdition", { id: editionId }, managerToken)).json as {
            pages: { shifts: { shiftName: string; businessDate: string }[] }[];
          }
        ).pages;

      // As of the earlier shift's end, the last finished "1st" shift is that one.
      const past = await rpcCall(
        server,
        "deck/makeEdition",
        { deckId: recap!.id, asOf: `${earlier}T08:00:00Z` },
        managerToken,
      );
      expect(past.statusCode).toBe(200);
      const pastEdition = past.json as { id: string; asOf: string; dateFrom: string };
      expect(new Date(pastEdition.asOf).toISOString()).toBe(`${earlier}T08:00:00.000Z`);
      expect(pastEdition.dateFrom).toBe(earlier);
      expect((await pagesOf(pastEdition.id))[0]?.shifts).toMatchObject([{ shiftName: "1st", businessDate: earlier }]);

      // A moment still to come is now: an edition is what had finished by then.
      const future = await rpcCall(
        server,
        "deck/makeEdition",
        { deckId: recap!.id, asOf: new Date(Date.now() + 7 * DAY_MS).toISOString() },
        managerToken,
      );
      expect(future.statusCode).toBe(200);
      const futureEdition = future.json as { id: string; asOf: string; dateFrom: string };
      expect(new Date(futureEdition.asOf).getTime()).toBeLessThanOrEqual(Date.now());
      expect(futureEdition.dateFrom).toBe(yesterday);

      await rpcCall(server, "deck/deleteEdition", { id: pastEdition.id }, managerToken);
      await rpcCall(server, "deck/deleteEdition", { id: futureEdition.id }, managerToken);
    } finally {
      await prisma.shiftInstance.delete({ where: { id: shift.id } });
    }
  });

  it("opens a recap edition's shift live from its link, and nothing else", async () => {
    const [recap] = (await rpcCall(server, "deck/list", { siteId, kind: "SHIFT_RECAP" }, managerToken)).json as {
      id: string;
    }[];
    const made = await rpcCall(server, "deck/makeEdition", { deckId: recap!.id }, managerToken);
    const editionId = (made.json as { id: string }).id;
    const edition = (await rpcCall(server, "deck/getEdition", { id: editionId }, managerToken)).json as {
      pages: { key: string; shifts: { shiftName: string; businessDate: string }[] }[];
    };
    expect(edition.pages).toHaveLength(1);
    expect(edition.pages[0]?.shifts).toMatchObject([{ shiftName: "1st", businessDate: yesterday }]);

    const link = await rpcCall(
      server,
      "deck/createLink",
      { editionIds: [editionId], label: "Recap test", expiresInHours: 24 },
      managerToken,
    );
    const { id, token } = link.json as { id: string; token: string };
    const pageKey = edition.pages[0]!.key;

    const read = await rpcCall(server, "deck/linkRecap", { token, editionId, pageKey });
    expect(read.statusCode).toBe(200);
    expect(read.json).toMatchObject({ shift: { shiftName: "1st" }, workcenter: { id: workcenterId } });
    // Each station comes with the unit its items are counted in.
    for (const station of (read.json as { stations: Record<string, unknown>[] }).stations) {
      expect(station).toHaveProperty("quantityUnit");
      expect(station).not.toHaveProperty("siteId");
    }

    // Only a page of an edition the link names.
    expect((await rpcCall(server, "deck/linkRecap", { token, editionId, pageKey: "other" })).statusCode).toBe(404);
    const [deckEdition] = (await rpcCall(server, "deck/listEditions", { deckId }, managerToken)).json as {
      id: string;
    }[];
    expect(
      (await rpcCall(server, "deck/linkRecap", { token, editionId: deckEdition!.id, pageKey })).statusCode,
    ).toBe(404);

    await rpcCall(server, "deck/revokeLink", { id }, managerToken);
    expect((await rpcCall(server, "deck/linkRecap", { token, editionId, pageKey })).statusCode).not.toBe(200);
  });

  it("makes a recap's edition on its schedule, and a subscription sends the latest, like a deck", async () => {
    const [recap] = (await rpcCall(server, "deck/list", { siteId, kind: "SHIFT_RECAP" }, managerToken)).json as {
      id: string;
    }[];
    const site = await prisma.site.findUniqueOrThrow({ where: { id: siteId }, select: { workspaceId: true } });
    const person = await prisma.employee.create({ data: { workspaceId: site.workspaceId }, select: { id: true } });
    const version = await prisma.employeeVersion.create({
      data: { employeeId: person.id, version: 1, firstName: "Recap", lastName: "Reader", email: "decks-recap@test.local" },
      select: { id: true },
    });
    await prisma.employee.update({ where: { id: person.id }, data: { versionId: version.id } });

    const sent: string[] = [];
    const email = notification.notifier.adapter("EMAIL");
    notification.setChannelAdapter("EMAIL", {
      async send(_to, message) {
        sent.push(message.body);
        return { ok: true, providerMessageId: "m" };
      },
    });
    const tick = (label: string) => {
      const scheduledAt = new Date().toISOString();
      return {
        scheduledAt,
        ctx: {
          automation: { id: randomUUID(), label },
          event: {
            id: randomUUID(),
            type: "time.daily",
            version: "1",
            ts: scheduledAt,
            payload: { scheduledAt },
            partition: siteId,
          },
          eventId: randomUUID(),
          actionIdx: 0,
        } as unknown as ActionContext,
      };
    };
    const schedule = tick("Recap schedule");
    const subscription = tick("Recap subscription");
    const inputs = { deckIds: [recap!.id], employeeIds: [person.id], subject: "Recap", body: "Last shift:" };
    try {
      // A subscription alone makes nothing: it sends the latest edition.
      await sendLatest.versions["1"]!.run(inputs, subscription.ctx);
      expect(
        await prisma.reportDeckEdition.count({
          where: { deckId: recap!.id, automationId: subscription.ctx.automation.id },
        }),
      ).toBe(0);

      await makeEditions.versions["1"]!.run({ deckIds: [recap!.id] }, schedule.ctx);
      // A redelivered tick finds the edition it already made.
      await makeEditions.versions["1"]!.run({ deckIds: [recap!.id] }, schedule.ctx);
      sent.length = 0;
      // The next day's tick of the same subscription: a new event, so not a redelivery.
      const nextTick = {
        ...subscription.ctx,
        event: { ...subscription.ctx.event, id: randomUUID() },
      } as ActionContext;
      await sendLatest.versions["1"]!.run(inputs, nextTick);
    } finally {
      if (email) notification.setChannelAdapter("EMAIL", email);
    }

    const made = await prisma.reportDeckEdition.findMany({
      where: { deckId: recap!.id, automationId: schedule.ctx.automation.id },
      select: { id: true, source: true, asOf: true },
    });
    expect(made).toMatchObject([{ source: "SCHEDULE", asOf: new Date(schedule.scheduledAt) }]);
    const latest = await prisma.reportDeckEdition.findFirstOrThrow({
      where: { deckId: recap!.id },
      orderBy: { asOf: "desc" },
      select: { id: true },
    });
    expect(latest.id).toBe(made[0]!.id);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/^Last shift:\n.+: .+\/decks\/[A-Za-z0-9_-]{32}$/);

    await prisma.employee.update({ where: { id: person.id }, data: { versionId: null } });
    await prisma.employeeVersion.deleteMany({ where: { employeeId: person.id } });
    await prisma.employee.delete({ where: { id: person.id } });
  });
});
