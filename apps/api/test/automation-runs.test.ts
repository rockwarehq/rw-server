import prisma from "@rw/db";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensurePlantBucket, makeUser } from "./helpers/access.js";
import { buildServer, loginAs, type TestServer } from "./helpers/build-server.js";
import { rpcCall } from "./helpers/rpc-call.js";

const VIEWER_EMAIL = "automation-runs-viewer@test.local";
const OUTSIDER_EMAIL = "automation-runs-outsider@test.local";
const PASSWORD = "Automation-runs-password-1";

// Tier 2: automations.listRuns reads the recorder's rows back for one automation — newest first,
// only this automation's matches and action runs, paged with `before`, gated on VIEW at its plant.
describe.skipIf(!process.env.TEST_DATABASE_URL)("automations.listRuns (Tier 2)", () => {
  let server: TestServer;
  let siteId: string;
  let automationId: string;
  let otherAutomationId: string;
  let viewerToken: string;
  let outsiderToken: string;
  const runIds: string[] = [];

  async function run(options: {
    firedAt: Date;
    skipped?: string | null;
    actions?: { status: "SUCCESS" | "FAILED" | "SCHEDULED"; error?: string }[];
    alsoOther?: boolean;
  }) {
    const created = await prisma.automationRun.create({
      data: {
        eventType: "station.status.changed",
        eventVersion: "1",
        eventId: randomUUID(),
        payload: { stationName: "Press 4", status: "DOWN" },
        siteId,
        correlationId: randomUUID(),
        status: "SUCCESS",
        firedAt: options.firedAt,
        finishedAt: options.firedAt,
        matches: {
          create: [
            { automationId, matchIdx: 0, skipped: options.skipped ?? null },
            ...(options.alsoOther ? [{ automationId: otherAutomationId, matchIdx: 1 }] : []),
          ],
        },
        actionRuns: {
          create: [
            ...(options.actions ?? []).map((action, actionIdx) => ({
              automationId,
              actionIdx,
              actionType: "notify",
              actionVersion: "1",
              status: action.status,
              error: action.error ?? null,
              startedAt: options.firedAt,
              finishedAt: options.firedAt,
            })),
            ...(options.alsoOther
              ? [
                  {
                    automationId: otherAutomationId,
                    actionIdx: 0,
                    actionType: "openCall",
                    actionVersion: "1",
                    status: "SUCCESS" as const,
                    startedAt: options.firedAt,
                    finishedAt: options.firedAt,
                  },
                ]
              : []),
          ],
        },
      },
      select: { id: true },
    });
    runIds.push(created.id);
    return created.id;
  }

  beforeAll(async () => {
    server = buildServer();
    await server.ready();

    const rockware = await prisma.site.findFirstOrThrow({
      where: { name: "Rockware" },
      select: { id: true, workspaceId: true },
    });
    siteId = rockware.id;
    const siteB = await prisma.site.upsert({
      where: { workspaceId_name: { workspaceId: rockware.workspaceId, name: "AutomationRuns Site B" } },
      update: {},
      create: { name: "AutomationRuns Site B", workspaceId: rockware.workspaceId },
      select: { id: true },
    });
    await ensurePlantBucket(rockware.workspaceId, siteB.id, "AutomationRuns Site B");

    // Straight rows, not the framework store: that one wires NATS for delayed actions.
    const seed = async (label: string) =>
      (
        await prisma.automation.create({
          data: {
            label,
            enabled: false,
            siteId,
            event: "station.status.changed",
            eventVersion: "1",
            conditions: { combinator: "and", rules: [] },
            actions: [{ type: "clearMode", version: "1", inputs: {} }],
          },
          select: { id: true },
        })
      ).id;
    automationId = await seed("runs-test: this one");
    otherAutomationId = await seed("runs-test: another");

    await makeUser(VIEWER_EMAIL, PASSWORD, { plants: [{ siteId, level: "VIEW" }] });
    await makeUser(OUTSIDER_EMAIL, PASSWORD, { plants: [{ siteId: siteB.id, level: "ADMIN" }] });
    viewerToken = (await loginAs(server, VIEWER_EMAIL, PASSWORD)).accessToken;
    outsiderToken = (await loginAs(server, OUTSIDER_EMAIL, PASSWORD)).accessToken;
  }, 30_000);

  afterAll(async () => {
    await prisma.automationRun.deleteMany({ where: { id: { in: runIds } } });
    await prisma.automation.deleteMany({
      where: { id: { in: [automationId, otherAutomationId].filter(Boolean) } },
    });
    await server?.close();
  });

  it("lists this automation's runs newest first, with only its own action runs", async () => {
    const older = await run({
      firedAt: new Date("2026-09-20T10:00:00Z"),
      actions: [{ status: "SCHEDULED" }],
    });
    const newer = await run({
      firedAt: new Date("2026-09-20T10:10:00Z"),
      actions: [{ status: "FAILED", error: "No SMS provider" }],
      alsoOther: true,
    });
    const cooled = await run({ firedAt: new Date("2026-09-20T10:05:00Z"), skipped: "cooldown" });

    const response = await rpcCall(server, "automations/listRuns", { automationId }, viewerToken);
    expect(response.statusCode).toBe(200);
    const body = response.json as {
      data: { runId: string; skipped: string | null; actions: { actionType: string; status: string; error: string | null }[] }[];
      hasMore: boolean;
    };
    expect(body.hasMore).toBe(false);
    expect(body.data.map((row) => row.runId)).toEqual([newer, cooled, older]);
    expect(body.data[0]!.actions).toEqual([
      expect.objectContaining({ actionType: "notify", status: "FAILED", error: "No SMS provider" }),
    ]);
    expect(body.data[1]!.skipped).toBe("cooldown");
    expect(body.data[2]!.actions[0]!.status).toBe("SCHEDULED");
  });

  it("pages with limit and before", async () => {
    const first = await rpcCall(server, "automations/listRuns", { automationId, limit: 2 }, viewerToken);
    const page = first.json as { data: { firedAt: string }[]; hasMore: boolean };
    expect(page.data).toHaveLength(2);
    expect(page.hasMore).toBe(true);
    const next = await rpcCall(
      server,
      "automations/listRuns",
      { automationId, limit: 2, before: page.data[1]!.firedAt },
      viewerToken,
    );
    const rest = next.json as { data: unknown[]; hasMore: boolean };
    expect(rest.data).toHaveLength(1);
    expect(rest.hasMore).toBe(false);
  });

  it("is refused outside the automation's plant, and says when it doesn't exist", async () => {
    const outsider = await rpcCall(server, "automations/listRuns", { automationId }, outsiderToken);
    expect(outsider.statusCode).toBe(403);
    const missing = await rpcCall(
      server,
      "automations/listRuns",
      { automationId: randomUUID() },
      viewerToken,
    );
    expect(missing.statusCode).toBe(404);
  });
});
