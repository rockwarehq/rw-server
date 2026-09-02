import { describe, expect, it } from "vitest";
import { createActionRegistry } from "./actions.js";
import { statelessContextBuilder } from "./context.js";
import { causeOf, createAutomationFramework, type AutomationFrameworkConfig } from "./framework.js";
import type { FinishRunInput, RunRecorder } from "./recorder.js";
import type { AutomationStore } from "./store.js";
import type { ActionContext } from "./actions.js";
import type { Automation, EventSchema } from "./types.js";

const SITE_A = "site-a";
const SITE_B = "site-b";

const callEvent: EventSchema = {
  type: "call.changed",
  displayName: "Call Changed",
  latest: "1",
  versions: {
    "1": {
      scopeKey: "callId",
      payload: {
        siteId: { type: "string", title: "Site" },
        callId: { type: "string", title: "Call" },
        action: { type: "string", title: "Action", enum: ["opened", "closed"] },
      },
    },
  },
};

function memoryStore(rows: Automation[]): AutomationStore {
  const map = new Map(rows.map((r) => [r.id, r]));
  return {
    list: () => [...map.values()],
    get: (id) => map.get(id),
    async upsert(a) {
      map.set(a.id, a);
      return a;
    },
    async remove(id) {
      return map.delete(id);
    },
    newId: () => globalThis.crypto.randomUUID(),
  };
}

function automation(id: string, partition: string | null, action = "opened"): Automation {
  return {
    id,
    label: id,
    enabled: true,
    event: "call.changed",
    eventVersion: "1",
    partition,
    conditions: { combinator: "and", rules: [{ field: "event.payload.action", operator: "=", value: action }] },
    actions: [{ type: "noop", version: "1", inputs: {} }],
  };
}

function build(rows: Automation[], overrides: Partial<AutomationFrameworkConfig> = {}) {
  const ran: ActionContext[] = [];
  const finished: FinishRunInput[] = [];
  const recorder: RunRecorder = {
    startRun: async () => "run",
    recordAction: async () => {},
    finishRun: async (_id, input) => {
      finished.push(input);
    },
  };
  const actions = createActionRegistry().register({
    type: "noop",
    displayName: "No-op",
    latest: "1",
    versions: {
      "1": {
        inputSchema: { required: [], properties: {} },
        run: (_inputs, ctx) => {
          ran.push(ctx);
        },
      },
    },
  });
  const fw = createAutomationFramework({
    eventSchemas: { [callEvent.type]: callEvent },
    actionSchemas: {
      noop: {
        type: "noop",
        displayName: "No-op",
        latest: "1",
        versions: { "1": { inputSchema: { required: [], properties: {} } } },
      },
    },
    store: memoryStore(rows),
    contextBuilders: { [callEvent.type]: statelessContextBuilder },
    actions,
    recorder,
    partitionField: "siteId",
    ...overrides,
  });
  return { fw, ran, finished };
}

describe("partition", () => {
  it("routes an event to its own partition and to global automations only", async () => {
    const { fw } = build([automation("a", SITE_A), automation("b", SITE_B), automation("g", null)]);
    const r = await fw.fire("call.changed", { siteId: SITE_A, callId: "c1", action: "opened" });
    expect(r.matched.sort()).toEqual(["a", "g"]);
  });

  it("gives an event with no partition value only the global automations", async () => {
    const { fw } = build([automation("a", SITE_A), automation("g", null)]);
    const r = await fw.fire("call.changed", { callId: "c1", action: "opened" });
    expect(r.matched).toEqual(["g"]);
  });

  it("rejects an event schema that omits the partition field at boot", () => {
    const bad: EventSchema = {
      ...callEvent,
      versions: { "1": { payload: { callId: { type: "string", title: "Call" } } } },
    };
    expect(() =>
      build([], { eventSchemas: { [bad.type]: bad }, contextBuilders: { [bad.type]: statelessContextBuilder } }),
    ).toThrow(/partition field "siteId"/);
  });

  it("rejects a scopeKey that is not a payload field at boot", () => {
    const bad: EventSchema = {
      ...callEvent,
      versions: { "1": { scopeKey: "nope", payload: { siteId: { type: "string", title: "Site" } } } },
    };
    expect(() =>
      build([], { eventSchemas: { [bad.type]: bad }, contextBuilders: { [bad.type]: statelessContextBuilder } }),
    ).toThrow(/scopeKey "nope"/);
  });
});

describe("event envelope", () => {
  it("stamps partition, scope, and a fresh chain on a root event", async () => {
    const { fw, ran } = build([automation("a", SITE_A)]);
    const r = await fw.fire("call.changed", { siteId: SITE_A, callId: "c1", action: "opened" });
    const event = ran[0]?.event;
    expect(event?.id).toBe(r.eventId);
    expect(event?.partition).toBe(SITE_A);
    expect(event?.scope).toBe("c1");
    expect(event?.correlationId).toBe(r.eventId);
    expect(event?.causationId).toBeUndefined();
    expect(event?.hop).toBe(0);
  });

  it("continues the chain from a cause", async () => {
    const { fw, ran } = build([automation("a", SITE_A)]);
    await fw.fire("call.changed", { siteId: SITE_A, callId: "c1", action: "opened" });
    const parent = ran[0]!.event;
    await fw.fire("call.changed", { siteId: SITE_A, callId: "c2", action: "opened" }, { cause: causeOf(parent) });
    const child = ran[1]!.event;
    expect(child.correlationId).toBe(parent.id);
    expect(child.causationId).toBe(parent.id);
    expect(child.hop).toBe(1);
  });
});

describe("hop limit", () => {
  it("drops an event past maxHops without running actions and records the drop", async () => {
    const { fw, ran, finished } = build([automation("a", SITE_A)], { maxHops: 2 });
    const cause = { correlationId: "root", causationId: "parent", hop: 2 };
    const r = await fw.fire("call.changed", { siteId: SITE_A, callId: "c1", action: "opened" }, { cause });
    expect(r.matched).toEqual([]);
    expect(r.dropped).toMatch(/hop 3 exceeds maxHops 2/);
    expect(ran).toHaveLength(0);
    expect(finished.at(-1)?.status).toBe("DROPPED");
  });

  it("still evaluates an event at exactly maxHops", async () => {
    const { fw, ran } = build([automation("a", SITE_A)], { maxHops: 2 });
    const cause = { correlationId: "root", causationId: "parent", hop: 1 };
    const r = await fw.fire("call.changed", { siteId: SITE_A, callId: "c1", action: "opened" }, { cause });
    expect(r.dropped).toBeUndefined();
    expect(ran).toHaveLength(1);
  });
});
