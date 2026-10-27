import type { PrismaClient } from "@rw/db";
import { nodes as graphNodes } from "../graph/index.js";
import type { EntityEvent } from "@rw/runtime/entity-events";

import {
  isEntityResolver,
  staleEnvelope,
  type EntityResolverConfig,
  type LivestoreLogger,
  type PropertyRuntime,
  type ValueEnvelope,
} from "../types/index.js";

// Resolves `entity` properties: reads the bound Postgres record via the shared @rw/services reader
// (same one the facets use) and commits it — at load, on definition change, and on entity events.
//
// Every property bound to one record shares a single read. Events for a record that is already
// being read are merged and answered by one more read once it finishes (that read may have
// started before their write committed). Different records are read in parallel, up to
// MAX_PARALLEL_READS, which stays inside the livestore Prisma pool.

const MAX_PARALLEL_READS = 4;

export interface EntityCommitSink {
  commitValue(propertyId: string, envelope: ValueEnvelope, source: "entity"): Promise<void>;
}

type Scope = { workspaceId: string; siteId: string };

const entityRefKey = (entityKey: string, entityId: string): string => `${entityKey}|${entityId}`;

// Skip re-resolving a property whose field didn't change. Conservative: no field list
// (create/delete) or a nested path → resolve, since changedFields lists only top-level columns.
function pathAffectedByChange(path: string, changedFields: ReadonlySet<string> | undefined): boolean {
  if (!changedFields || changedFields.size === 0) return true;
  if (path === "*" || path.includes(".")) return true;
  // Events carry DB column names while entity reads expose relation aliases
  // (workcenter ← workcenterId, currentJob ← currentJobId, site ← siteId):
  // match the aliased column too, or aliased paths never re-resolve.
  return changedFields.has(path) || changedFields.has(`${path}Id`);
}

// Events waiting on the next read of one record. `changedFields` undefined = everything.
interface PendingRead {
  changedFields: Set<string> | undefined;
  events: number;
  waiters: Array<{ resolve: () => void; reject: (err: unknown) => void }>;
}

class Semaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly max: number) {}

  async acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
  }

  release(): void {
    const next = this.queue.shift();
    if (next) next();
    else this.active--;
  }
}

export class EntityResolver {
  private readonly byEntity = new Map<string, Set<string>>(); // entityRefKey -> propertyIds
  private readonly propertyRef = new Map<string, string>(); // propertyId -> entityRefKey
  private readonly scopes = new Map<string, Scope>(); // nodeId -> scope (a node never changes site)
  private readonly pending = new Map<string, PendingRead>(); // entityRefKey -> events awaiting a read
  private readonly reading = new Set<string>(); // entityRefKeys with a read in flight
  private readonly reads = new Semaphore(MAX_PARALLEL_READS);

  constructor(
    private readonly prisma: PrismaClient,
    private readonly sink: EntityCommitSink,
    private readonly logger: LivestoreLogger,
    private readonly getProperty: (propertyId: string) => PropertyRuntime | null,
  ) {}

  // Index + resolve every entity property (engine load), one read per record.
  async start(properties: PropertyRuntime[]): Promise<void> {
    const entityProperties = properties.filter((property) => isEntityResolver(property.resolver));
    for (const property of properties) this.index(property);
    const byRecord = new Map<string, PropertyRuntime[]>();
    for (const property of entityProperties) {
      const key = this.propertyRef.get(property.id) as string;
      byRecord.set(key, [...(byRecord.get(key) ?? []), property]);
    }
    await Promise.all([...byRecord.values()].map((group) => this.withReadSlot(() => this.resolveGroup(group))));
    if (entityProperties.length > 0) {
      this.logger.info(
        { properties: entityProperties.length, records: byRecord.size },
        "livestore entity resolver started",
      );
    }
  }

  // Re-index a property (added/changed) and resolve it if it's an entity property.
  async upsertProperty(property: PropertyRuntime): Promise<void> {
    this.index(property);
    if (isEntityResolver(property.resolver)) await this.resolveProperty(property);
  }

  removeProperty(propertyId: string): void {
    const ref = this.propertyRef.get(propertyId);
    if (!ref) return;
    this.propertyRef.delete(propertyId);
    const ids = this.byEntity.get(ref);
    if (!ids) return;
    ids.delete(propertyId);
    if (ids.size === 0) this.byEntity.delete(ref);
  }

  // Re-resolve entity properties bound to the changed instance whose field the event touched.
  // Resolves once the read covering this event has committed; rejects if that read threw.
  handleEntityEvent(event: EntityEvent): Promise<void> {
    const key = entityRefKey(event.entityKey, event.entityId);
    if (!this.byEntity.get(key)?.size) return Promise.resolve();

    const next = this.pending.get(key) ?? { changedFields: new Set<string>(), events: 0, waiters: [] };
    if (!event.changedFields?.length) next.changedFields = undefined;
    else for (const field of event.changedFields) next.changedFields?.add(field);
    next.events++;
    this.pending.set(key, next);
    const done = new Promise<void>((resolve, reject) => next.waiters.push({ resolve, reject }));

    if (!this.reading.has(key)) void this.drainRecord(key, event.entityKey, event.entityId);
    return done;
  }

  async resolveProperty(property: PropertyRuntime): Promise<void> {
    if (!isEntityResolver(property.resolver)) return;
    await this.resolveGroup([property]);
  }

  // Keep reading a record while events for it keep arriving; one read per batch.
  private async drainRecord(key: string, entityKey: string, entityId: string): Promise<void> {
    this.reading.add(key);
    try {
      for (;;) {
        const batch = this.pending.get(key);
        if (!batch) break;
        this.pending.delete(key);
        try {
          await this.withReadSlot(() => this.resolveChanged(key, entityKey, entityId, batch));
          for (const waiter of batch.waiters) waiter.resolve();
        } catch (err) {
          for (const waiter of batch.waiters) waiter.reject(err);
        }
      }
    } finally {
      this.reading.delete(key);
    }
  }

  private async resolveChanged(key: string, entityKey: string, entityId: string, batch: PendingRead): Promise<void> {
    const ids = this.byEntity.get(key);
    if (!ids || ids.size === 0) return;
    const matched: PropertyRuntime[] = [];
    for (const propertyId of ids) {
      const property = this.getProperty(propertyId);
      if (!property || !isEntityResolver(property.resolver)) continue;
      if (!pathAffectedByChange(property.resolver.path, batch.changedFields)) continue;
      matched.push(property);
    }
    if (matched.length > 0) await this.resolveGroup(matched);
    this.logger.info(
      { entityKey, entityId, events: batch.events, matched: ids.size, resolved: matched.length },
      "livestore entity resolver handled entity change",
    );
  }

  // Resolve properties bound to one record: one read per site they live in (in practice, one).
  private async resolveGroup(properties: PropertyRuntime[]): Promise<void> {
    const byScope = new Map<string, { scope: Scope; properties: PropertyRuntime[] }>();
    for (const property of properties) {
      const scope = await this.scopeForNode(property.nodeId);
      if (!scope) {
        this.logger.warn(
          { propertyId: property.id, nodeId: property.nodeId },
          "livestore entity resolver: node scope not found",
        );
        await this.commitStale(property.id);
        continue;
      }
      const scopeKey = `${scope.workspaceId}|${scope.siteId}`;
      const group = byScope.get(scopeKey) ?? { scope, properties: [] };
      group.properties.push(property);
      byScope.set(scopeKey, group);
    }
    for (const { scope, properties: group } of byScope.values()) await this.readAndCommit(group, scope);
  }

  private async readAndCommit(properties: PropertyRuntime[], scope: Scope): Promise<void> {
    const resolver = properties[0].resolver as EntityResolverConfig;
    const paths = [...new Set(properties.map((property) => (property.resolver as EntityResolverConfig).path))];
    const result = await graphNodes.readEntityFieldValues({
      entityType: resolver.entityType,
      entityId: resolver.entityId,
      paths,
      scope,
    });
    if ("error" in result) {
      this.logger.warn(
        {
          propertyIds: properties.map((property) => property.id),
          entityType: resolver.entityType,
          entityId: resolver.entityId,
          paths,
          code: result.code,
        },
        "livestore entity resolver: read failed",
      );
      for (const property of properties) await this.commitStale(property.id);
      return;
    }

    const timestamp = Date.now();
    for (const property of properties) {
      const value = result.data.get((property.resolver as EntityResolverConfig).path);
      await this.commit(property.id, { value: value ?? null, quality: "good", timestamp });
    }
  }

  private async withReadSlot<T>(fn: () => Promise<T>): Promise<T> {
    await this.reads.acquire();
    try {
      return await fn();
    } finally {
      this.reads.release();
    }
  }

  private index(property: PropertyRuntime): void {
    const previous = this.propertyRef.get(property.id) ?? null;
    const next = isEntityResolver(property.resolver)
      ? entityRefKey(
          (property.resolver as EntityResolverConfig).entityType,
          (property.resolver as EntityResolverConfig).entityId,
        )
      : null;
    if (previous === next) return;
    if (previous) this.removeProperty(property.id);
    if (next) {
      const ids = this.byEntity.get(next) ?? new Set<string>();
      ids.add(property.id);
      this.byEntity.set(next, ids);
      this.propertyRef.set(property.id, next);
    }
  }

  private async scopeForNode(nodeId: string): Promise<Scope | null> {
    const cached = this.scopes.get(nodeId);
    if (cached) return cached;
    const node = await this.prisma.graphNode.findUnique({
      where: { id: nodeId },
      select: { siteId: true, site: { select: { workspaceId: true } } },
    });
    if (!node) return null;
    const scope = { workspaceId: node.site.workspaceId, siteId: node.siteId };
    this.scopes.set(nodeId, scope);
    return scope;
  }

  private async commit(propertyId: string, envelope: ValueEnvelope): Promise<void> {
    try {
      await this.sink.commitValue(propertyId, envelope, "entity");
    } catch (err) {
      this.logger.error({ err, propertyId }, "livestore entity resolver commit failed");
    }
  }

  private commitStale(propertyId: string): Promise<void> {
    return this.commit(propertyId, staleEnvelope());
  }
}
