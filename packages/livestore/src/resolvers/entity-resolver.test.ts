import { describe, expect, it, vi, beforeEach } from "vitest";

const readEntityFieldValues = vi.fn();
vi.mock("../graph/index.js", () => ({
  nodes: {
    readEntityFieldValues: (...args: unknown[]) => readEntityFieldValues(...args),
  },
}));

// Default reader: every requested path resolves to "station-7".
const valuesFor = (args: { paths: string[] }) => ({ data: new Map(args.paths.map((path) => [path, "station-7"])) });

const { EntityResolver } = await import("./entity-resolver.js");
import type { LivestoreLogger, PropertyRuntime, ValueEnvelope } from "../types/index.js";
import type { EntityEvent } from "@rw/runtime/entity-events";

const logger: LivestoreLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const entityProperty = (overrides: Partial<PropertyRuntime> = {}): PropertyRuntime => ({
  id: "prop-1",
  nodeId: "node-1",
  name: "stationId",
  resolverType: "entity",
  resolver: { type: "entity", entityType: "imm.station", entityId: "station-7", path: "id" },
  sampleRateMs: null,
  current: { value: null, quality: "stale", timestamp: 0 },
  ...overrides,
});

const event = (overrides: Partial<EntityEvent> = {}): EntityEvent => ({
  id: "evt-1",
  action: "updated",
  entityKey: "imm.station",
  entityId: "station-7",
  siteId: "site-1",
  workspaceId: "ws-1",
  emittedAt: "2026-06-26T00:00:00.000Z",
  ...overrides,
});

function harness(
  node: { siteId: string; site: { workspaceId: string } } | null = { siteId: "site-1", site: { workspaceId: "ws-1" } },
) {
  const commits: Array<{ propertyId: string; envelope: ValueEnvelope; source: string }> = [];
  const sink = {
    commitValue: vi.fn(async (propertyId, envelope, source) => {
      commits.push({ propertyId, envelope, source });
    }),
  };
  const findUnique = vi.fn(async () => node);
  const prisma = { graphNode: { findUnique } } as never;
  const properties = new Map<string, PropertyRuntime>();
  const getProperty = (id: string) => properties.get(id) ?? null;
  const resolver = new EntityResolver(prisma, sink, logger, getProperty);
  return { resolver, sink, commits, properties, findUnique };
}

beforeEach(() => {
  readEntityFieldValues.mockReset();
  readEntityFieldValues.mockImplementation(async (args: { paths: string[] }) => valuesFor(args));
});

describe("EntityResolver", () => {
  it("reads the bound record and commits the value as a good envelope", async () => {
    const { resolver, commits } = harness();

    await resolver.resolveProperty(entityProperty());

    expect(readEntityFieldValues).toHaveBeenCalledWith({
      entityType: "imm.station",
      entityId: "station-7",
      paths: ["id"],
      scope: { workspaceId: "ws-1", siteId: "site-1" },
    });
    expect(commits[0]).toMatchObject({
      propertyId: "prop-1",
      source: "entity",
      envelope: { value: "station-7", quality: "good" },
    });
  });

  it("commits stale when the node scope is not found", async () => {
    const { resolver, commits } = harness(null);
    await resolver.resolveProperty(entityProperty());
    expect(readEntityFieldValues).not.toHaveBeenCalled();
    expect(commits[0]?.envelope.quality).toBe("stale");
  });

  it("commits stale when the entity read fails", async () => {
    readEntityFieldValues.mockResolvedValue({ error: "not found", code: "ENTITY_REF_NOT_FOUND" });
    const { resolver, commits } = harness();
    await resolver.resolveProperty(entityProperty());
    expect(commits[0]?.envelope.quality).toBe("stale");
  });

  it("start() indexes + resolves entity properties and skips non-entity ones", async () => {
    const { resolver, commits } = harness();
    const metric = entityProperty({ id: "prop-metric", resolverType: "metric", resolver: { type: "metric" } as never });

    await resolver.start([metric, entityProperty()]);

    expect(commits).toHaveLength(1);
    expect(commits[0]?.propertyId).toBe("prop-1");
  });

  it("handleEntityEvent re-resolves indexed properties matching the event's entityKey+entityId", async () => {
    const { resolver, commits, properties } = harness();
    const property = entityProperty();
    properties.set(property.id, property);
    await resolver.upsertProperty(property); // index + initial resolve (1 commit)

    await resolver.handleEntityEvent(event()); // re-resolve (2nd commit)

    expect(commits).toHaveLength(2);
    expect(commits.every((c) => c.propertyId === "prop-1")).toBe(true);
  });

  it("handleEntityEvent skips a property whose flat field isn't in changedFields", async () => {
    const { resolver, commits, properties } = harness();
    const property = entityProperty(); // path: "id"
    properties.set(property.id, property);
    await resolver.upsertProperty(property);
    commits.length = 0;

    await resolver.handleEntityEvent(event({ changedFields: ["name"] }));

    expect(commits).toHaveLength(0);
  });

  it("handleEntityEvent re-resolves when the field is in changedFields", async () => {
    const { resolver, commits, properties } = harness();
    const property = entityProperty(); // path: "id"
    properties.set(property.id, property);
    await resolver.upsertProperty(property);
    commits.length = 0;

    await resolver.handleEntityEvent(event({ changedFields: ["id"] }));

    expect(commits).toHaveLength(1);
  });

  it("handleEntityEvent re-resolves an aliased path when its DB column changed", async () => {
    const { resolver, commits, properties } = harness();
    // Path "currentJob" is served from the raw column currentJobId; events
    // carry the column name.
    const property = entityProperty({
      resolver: { type: "entity", entityType: "imm.station", entityId: "station-7", path: "currentJob" },
    });
    properties.set(property.id, property);
    await resolver.upsertProperty(property);
    commits.length = 0;

    await resolver.handleEntityEvent(event({ changedFields: ["currentJobId"] }));

    expect(commits).toHaveLength(1);
  });

  it("handleEntityEvent re-resolves both statusReasonId and statusReason paths for a statusReasonId change", async () => {
    const { resolver, commits, properties } = harness();
    // "statusReason" (the reason name) matches changedFields ["statusReasonId"] via the `${path}Id` rule.
    for (const [id, path] of [
      ["prop-reason-id", "statusReasonId"],
      ["prop-reason", "statusReason"],
    ] as const) {
      const property = entityProperty({
        id,
        resolver: { type: "entity", entityType: "imm.station", entityId: "station-7", path },
      });
      properties.set(id, property);
      await resolver.upsertProperty(property);
    }
    commits.length = 0;

    await resolver.handleEntityEvent(event({ changedFields: ["statusReasonId"] }));

    expect(commits.map((c) => c.propertyId).sort()).toEqual(["prop-reason", "prop-reason-id"]);
  });

  it("handleEntityEvent always re-resolves nested paths (changedFields can't be trusted)", async () => {
    const { resolver, commits, properties } = harness();
    const property = entityProperty({
      resolver: {
        type: "entity",
        entityType: "imm.station",
        entityId: "station-7",
        path: "currentVersion.standardCycle",
      },
    });
    properties.set(property.id, property);
    await resolver.upsertProperty(property);
    commits.length = 0;

    await resolver.handleEntityEvent(event({ changedFields: ["name"] }));

    expect(commits).toHaveLength(1);
  });

  it("handleEntityEvent ignores events for unbound instances", async () => {
    const { resolver, commits, properties } = harness();
    const property = entityProperty();
    properties.set(property.id, property);
    await resolver.upsertProperty(property);
    commits.length = 0;

    await resolver.handleEntityEvent(event({ entityId: "other-station" }));

    expect(commits).toHaveLength(0);
  });

  it("removeProperty drops it from the index so events no longer match", async () => {
    const { resolver, commits, properties } = harness();
    const property = entityProperty();
    properties.set(property.id, property);
    await resolver.upsertProperty(property);
    resolver.removeProperty(property.id);
    commits.length = 0;

    await resolver.handleEntityEvent(event());

    expect(commits).toHaveLength(0);
  });

  it("start() reads each record once for all the properties bound to it", async () => {
    const { resolver, commits } = harness();
    const a = entityProperty({ id: "prop-a" });
    const b = entityProperty({
      id: "prop-b",
      resolver: { type: "entity", entityType: "imm.station", entityId: "station-7", path: "name" },
    });
    const other = entityProperty({
      id: "prop-other",
      resolver: { type: "entity", entityType: "imm.station", entityId: "station-8", path: "id" },
    });

    await resolver.start([a, b, other]);

    expect(readEntityFieldValues).toHaveBeenCalledTimes(2);
    expect(readEntityFieldValues).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: "station-7", paths: ["id", "name"] }),
    );
    expect(commits.map((c) => c.propertyId).sort()).toEqual(["prop-a", "prop-b", "prop-other"]);
  });

  it("handleEntityEvent reads the record once and commits each matched property's own value", async () => {
    const { resolver, commits, properties } = harness();
    for (const [id, path] of [
      ["prop-status", "status"],
      ["prop-since", "statusStartAt"],
      ["prop-job", "currentJob"],
    ] as const) {
      const property = entityProperty({
        id,
        resolver: { type: "entity", entityType: "imm.station", entityId: "station-7", path },
      });
      properties.set(id, property);
      await resolver.upsertProperty(property);
    }
    readEntityFieldValues.mockClear();
    readEntityFieldValues.mockImplementation(async (args: { paths: string[] }) => ({
      data: new Map(args.paths.map((path) => [path, `value-of-${path}`])),
    }));
    commits.length = 0;

    await resolver.handleEntityEvent(event({ changedFields: ["status", "statusStartAt"] }));

    expect(readEntityFieldValues).toHaveBeenCalledTimes(1);
    expect(readEntityFieldValues.mock.calls[0][0].paths.sort()).toEqual(["status", "statusStartAt"]);
    expect(Object.fromEntries(commits.map((c) => [c.propertyId, c.envelope.value]))).toEqual({
      "prop-status": "value-of-status",
      "prop-since": "value-of-statusStartAt",
    });
  });

  it("merges events that arrive while the record is being read into one follow-up read", async () => {
    const { resolver, properties } = harness();
    const property = entityProperty();
    properties.set(property.id, property);
    await resolver.upsertProperty(property);
    readEntityFieldValues.mockClear();

    let release: () => void = () => {};
    readEntityFieldValues.mockImplementationOnce(
      (args: { paths: string[] }) => new Promise((resolve) => (release = () => resolve(valuesFor(args)))),
    );

    const first = resolver.handleEntityEvent(event({ id: "evt-1" }));
    await vi.waitFor(() => expect(readEntityFieldValues).toHaveBeenCalledTimes(1));
    const later = [2, 3, 4].map((n) => resolver.handleEntityEvent(event({ id: `evt-${n}` })));
    release();
    await Promise.all([first, ...later]);

    // One read for evt-1, one more covering evt-2..4 (they may have been written after it started).
    expect(readEntityFieldValues).toHaveBeenCalledTimes(2);
  });

  it("merged events re-resolve the union of their changed fields", async () => {
    const { resolver, properties } = harness();
    for (const [id, path] of [
      ["prop-status", "status"],
      ["prop-cycle", "lastCycleSeconds"],
      ["prop-name", "name"],
    ] as const) {
      const property = entityProperty({
        id,
        resolver: { type: "entity", entityType: "imm.station", entityId: "station-7", path },
      });
      properties.set(id, property);
      await resolver.upsertProperty(property);
    }
    readEntityFieldValues.mockClear();

    let release: () => void = () => {};
    readEntityFieldValues.mockImplementationOnce(
      (args: { paths: string[] }) => new Promise((resolve) => (release = () => resolve(valuesFor(args)))),
    );
    const first = resolver.handleEntityEvent(event({ changedFields: ["name"] }));
    await vi.waitFor(() => expect(readEntityFieldValues).toHaveBeenCalledTimes(1));
    const second = resolver.handleEntityEvent(event({ changedFields: ["status"] }));
    const third = resolver.handleEntityEvent(event({ changedFields: ["lastCycleSeconds"] }));
    release();
    await Promise.all([first, second, third]);

    expect(readEntityFieldValues.mock.calls[1][0].paths.sort()).toEqual(["lastCycleSeconds", "status"]);
  });

  it("reads different records in parallel", async () => {
    const { resolver, properties } = harness();
    for (const stationId of ["station-7", "station-8"]) {
      const property = entityProperty({
        id: `prop-${stationId}`,
        resolver: { type: "entity", entityType: "imm.station", entityId: stationId, path: "id" },
      });
      properties.set(property.id, property);
      await resolver.upsertProperty(property);
    }
    readEntityFieldValues.mockClear();
    const releases: Array<() => void> = [];
    readEntityFieldValues.mockImplementation(
      (args: { paths: string[] }) => new Promise((resolve) => releases.push(() => resolve(valuesFor(args)))),
    );

    const done = Promise.all([
      resolver.handleEntityEvent(event({ entityId: "station-7" })),
      resolver.handleEntityEvent(event({ entityId: "station-8" })),
    ]);
    await vi.waitFor(() => expect(readEntityFieldValues).toHaveBeenCalledTimes(2));
    for (const release of releases) release();
    await done;
  });

  it("looks up a node's site once and reuses it", async () => {
    const { resolver, properties, findUnique } = harness();
    const property = entityProperty();
    properties.set(property.id, property);
    await resolver.upsertProperty(property);

    await resolver.handleEntityEvent(event());
    await resolver.handleEntityEvent(event());

    expect(findUnique).toHaveBeenCalledTimes(1);
  });

  it("rejects the event when the read throws, so the consumer can redeliver it", async () => {
    const { resolver, properties } = harness();
    const property = entityProperty();
    properties.set(property.id, property);
    await resolver.upsertProperty(property);
    readEntityFieldValues.mockRejectedValueOnce(new Error("db down"));

    await expect(resolver.handleEntityEvent(event())).rejects.toThrow("db down");
    // The next event reads again.
    await expect(resolver.handleEntityEvent(event())).resolves.toBeUndefined();
  });
});
