import { describe, expect, it, vi, beforeEach } from "vitest";

const readEntityFieldValue = vi.fn();
vi.mock("../graph/index.js", () => ({
  nodes: {
    readEntityFieldValue: (...args: unknown[]) => readEntityFieldValue(...args),
  },
}));

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
  const prisma = { graphNode: { findUnique: vi.fn(async () => node) } } as never;
  const properties = new Map<string, PropertyRuntime>();
  const getProperty = (id: string) => properties.get(id) ?? null;
  const resolver = new EntityResolver(prisma, sink, logger, getProperty);
  return { resolver, sink, commits, properties };
}

beforeEach(() => {
  readEntityFieldValue.mockReset();
  readEntityFieldValue.mockResolvedValue({ data: "station-7" });
});

describe("EntityResolver", () => {
  it("reads the bound record and commits the value as a good envelope", async () => {
    const { resolver, commits } = harness();

    await resolver.resolveProperty(entityProperty());

    expect(readEntityFieldValue).toHaveBeenCalledWith({
      entityType: "imm.station",
      entityId: "station-7",
      path: "id",
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
    expect(readEntityFieldValue).not.toHaveBeenCalled();
    expect(commits[0]?.envelope.quality).toBe("stale");
  });

  it("commits stale when the entity read fails", async () => {
    readEntityFieldValue.mockResolvedValue({ error: "not found", code: "ENTITY_REF_NOT_FOUND" });
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

  it("handleEntityEvent always re-resolves nested paths (changedFields can't be trusted)", async () => {
    const { resolver, commits, properties } = harness();
    const property = entityProperty({
      resolver: { type: "entity", entityType: "imm.station", entityId: "station-7", path: "currentBlob.standardCycle" },
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
});
