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

export interface EntityCommitSink {
  commitValue(propertyId: string, envelope: ValueEnvelope, source: "entity"): Promise<void>;
}

const entityRefKey = (entityKey: string, entityId: string): string => `${entityKey}|${entityId}`;

// Skip re-resolving a property whose field didn't change. Conservative: no field list
// (create/delete) or a nested path → resolve, since changedFields lists only top-level columns.
function pathAffectedByChange(path: string, changedFields: string[] | undefined): boolean {
  if (!changedFields || changedFields.length === 0) return true;
  if (path === "*" || path.includes(".")) return true;
  // Events carry DB column names while entity reads expose relation aliases
  // (workcenter ← workcenterId, currentJob ← currentJobId, site ← siteId):
  // match the aliased column too, or aliased paths never re-resolve.
  return changedFields.includes(path) || changedFields.includes(`${path}Id`);
}

export class EntityResolver {
  private readonly byEntity = new Map<string, Set<string>>(); // entityRefKey -> propertyIds
  private readonly propertyRef = new Map<string, string>(); // propertyId -> entityRefKey

  constructor(
    private readonly prisma: PrismaClient,
    private readonly sink: EntityCommitSink,
    private readonly logger: LivestoreLogger,
    private readonly getProperty: (propertyId: string) => PropertyRuntime | null,
  ) {}

  // Index + resolve every entity property (engine load).
  async start(properties: PropertyRuntime[]): Promise<void> {
    const entityProperties = properties.filter((property) => isEntityResolver(property.resolver));
    for (const property of properties) this.index(property);
    for (const property of entityProperties) await this.resolveProperty(property);
    if (entityProperties.length > 0) {
      this.logger.info({ properties: entityProperties.length }, "livestore entity resolver started");
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
  async handleEntityEvent(event: EntityEvent): Promise<void> {
    const ids = this.byEntity.get(entityRefKey(event.entityKey, event.entityId));
    if (!ids || ids.size === 0) return;
    let resolved = 0;
    for (const propertyId of [...ids]) {
      const property = this.getProperty(propertyId);
      if (!property || !isEntityResolver(property.resolver)) continue;
      if (!pathAffectedByChange(property.resolver.path, event.changedFields)) continue;
      await this.resolveProperty(property);
      resolved++;
    }
    this.logger.info(
      { entityKey: event.entityKey, entityId: event.entityId, action: event.action, matched: ids.size, resolved },
      "livestore entity resolver handled entity change",
    );
  }

  async resolveProperty(property: PropertyRuntime): Promise<void> {
    const resolver = property.resolver;
    if (!isEntityResolver(resolver)) return;

    const scope = await this.scopeForNode(property.nodeId);
    if (!scope) {
      this.logger.warn(
        { propertyId: property.id, nodeId: property.nodeId },
        "livestore entity resolver: node scope not found",
      );
      await this.commitStale(property.id);
      return;
    }

    const result = await graphNodes.readEntityFieldValue({
      entityType: resolver.entityType,
      entityId: resolver.entityId,
      path: resolver.path,
      scope,
    });
    if ("error" in result) {
      this.logger.warn(
        {
          propertyId: property.id,
          entityType: resolver.entityType,
          entityId: resolver.entityId,
          path: resolver.path,
          code: result.code,
        },
        "livestore entity resolver: read failed",
      );
      await this.commitStale(property.id);
      return;
    }

    await this.commit(property.id, { value: result.data ?? null, quality: "good", timestamp: Date.now() });
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

  private async scopeForNode(nodeId: string): Promise<{ workspaceId: string; siteId: string } | null> {
    const node = await this.prisma.graphNode.findUnique({
      where: { id: nodeId },
      select: { siteId: true, site: { select: { workspaceId: true } } },
    });
    if (!node) return null;
    return { workspaceId: node.site.workspaceId, siteId: node.siteId };
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
