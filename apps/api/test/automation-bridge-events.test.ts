import { type AutomationStore, createAutomationFramework } from "@rw/automations";
import { describe, expect, it } from "vitest";
import { ACTION_SCHEMAS, buildActionRegistry } from "../src/automations/actions/index.js";
import { fromCallEvent } from "../src/automations/events/call-changed.js";
import { buildContextBuilders, EVENT_SCHEMAS } from "../src/automations/events/index.js";
import { fromModeEvent } from "../src/automations/events/mode-changed.js";
import { fromNotificationEvent } from "../src/automations/events/notification-changed.js";
import { createRefRegistry } from "@rw/automations";

// Tier 1: the app's event/action catalog boots, and each domain event maps to a payload the
// matching automation event schema accepts (no DB — memory store, no automations).

const emptyStore: AutomationStore = {
  list: () => [],
  get: () => undefined,
  upsert: async (a) => a,
  remove: async () => false,
  newId: () => "x",
};

function framework() {
  const refs = createRefRegistry();
  for (const key of ["users", "workCenters", "stations", "jobs", "callDefinitions", "productionModes", "notificationGroups"]) {
    refs.register({ key, list: async () => [] });
  }
  return createAutomationFramework({
    eventSchemas: EVENT_SCHEMAS,
    actionSchemas: ACTION_SCHEMAS,
    store: emptyStore,
    contextBuilders: buildContextBuilders(),
    actions: buildActionRegistry(),
    refs,
    partitionField: "siteId",
  });
}

const base = { id: "11111111-1111-4111-8111-111111111111", workspaceId: "w", siteId: "s", emittedAt: "2026-09-02T00:00:00.000Z" };

describe("automation bridge events", () => {
  it("call.changed accepts a mapped CallEvent and keeps the domain event id and cause", async () => {
    const fw = framework();
    const cause = { correlationId: "root", causationId: "parent", hop: 1 };
    const r = await fw.fire(
      "call.changed",
      fromCallEvent({
        ...base,
        action: "opened",
        callId: "c1",
        definitionId: "d1",
        definitionName: "Maintenance",
        severity: "ALERT",
        stationId: "st1",
        stationName: "Press 4",
        source: "SYSTEM",
        sourceType: "automation",
        openedAt: base.emittedAt,
        cause,
      }),
      { id: base.id, cause },
    );
    expect(r).toEqual({ eventId: base.id, matched: [] });
  });

  it("mode.changed and notification.changed accept their mapped events", async () => {
    const fw = framework();
    const mode = await fw.fire(
      "mode.changed",
      fromModeEvent({ ...base, action: "cleared", logId: "l1", modeId: "m1", modeName: "Trial", stationId: "st1", stationName: "Press 4", source: "MANUAL", startedAt: base.emittedAt, endedAt: base.emittedAt }),
    );
    expect(mode.matched).toEqual([]);
    const notif = await fw.fire(
      "notification.changed",
      fromNotificationEvent({ ...base, action: "failed", notificationId: "n1", groupId: "g1", groupName: "Ops", subject: "x", source: "SYSTEM", sent: 0, failed: 1, skipped: 2 }),
    );
    expect(notif.matched).toEqual([]);
  });

  it("exposes numeric facts and the new actions in the catalog", () => {
    const fw = framework();
    const catalog = fw.catalog("notification.changed", "notifyGroup");
    expect(catalog.facts.find((f) => f.id === "event.payload.sent")?.type).toBe("number");
    expect(catalog.actions.map((a) => a.type).sort()).toEqual(["clearMode", "closeCall", "forceMode", "notifyGroup", "openCall", "sendAlert"]);
  });
});
