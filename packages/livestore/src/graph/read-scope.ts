import prisma, { type PrismaClient } from "@rw/db";
import type { IAMContext } from "@rw/auth/context";
import { authorizeList, authorizeReferenceRead, authorize } from "@rw/auth/iam/policy";
import { canReadMetricEntity, canReadPoint, type ProductionReadScope } from "@rw/services/entity/access-scope";
import { SYSTEM_ENTITY_REGISTRY } from "@rw/services/entity/registry";
import { getLivestoreGraphTypeSchema, parseGraphTypeRef } from "../catalog/graph-types.js";
import { isRecord } from "../types/index.js";

export interface PublishedReadScope extends ProductionReadScope {
  planningRead: boolean;
  configurationRead: boolean;
  plantAdmin: boolean;
  referenceRead: boolean;
}

export async function publishedReadScope(iam: IAMContext, siteId: string): Promise<PublishedReadScope | null> {
  const [production, reference, planning, configuration, plant] = await Promise.all([
    authorizeList(iam, { permission: "production:read", requestedSiteId: siteId }),
    authorizeReferenceRead(iam, { scope: { kind: "site", siteId } }),
    authorize(iam, { permission: "planning:read", scope: { kind: "site", siteId } }),
    authorize(iam, { permission: "configuration:read", scope: { kind: "site", siteId } }),
    authorize(iam, { permission: "plant:admin", scope: { kind: "site", siteId } }),
  ]);
  if (!iam.workspaceId || (!production.ok && !reference.ok && !configuration.ok && !plant.ok)) return null;
  return {
    workspaceId: iam.workspaceId,
    siteId,
    workcenterIds: production.ok ? production.workcenterIds : [],
    planningRead: planning.ok,
    configurationRead: configuration.ok,
    plantAdmin: plant.ok,
    referenceRead: reference.ok,
  };
}

// Explicit scalar catalog fields. Relations/current counters are not shared references.
const REFERENCE_FIELDS = new Set([
  "id",
  "name",
  "description",
  "sku",
  "materialNumber",
  "shortCode",
  "classification",
  "timezone",
  "currentVersion.name",
  "currentVersion.description",
  "currentVersion.sku",
  "currentVersion.materialNumber",
  "currentVersion.shortCode",
  "currentVersion.standardCycle",
  "currentVersion.standardCycleUnit",
  "currentVersion.standardQuantity",
  "currentVersion.standardRate",
  "currentVersion.productsPerCycle",
  "currentVersion.weight",
  "currentVersion.weightUnits",
  "currentVersion.cavityCount",
  "currentVersion.pmLimit",
  "currentVersion.pmWarn",
  "isPlannedDown",
]);
const STATION_FIELDS = new Set([
  "id",
  "name",
  "description",
  "siteId",
  "site",
  "workcenterId",
  "workcenter",
  "currentJob",
  "currentJobId",
  "itemsPerCycle",
  "currentSecondsPerUnit",
  "currentStandardQuantity",
  "currentStandardCycleSeconds",
  "status",
  "statusReasonId",
  "statusReason",
  "statusStartAt",
  "productionMode",
  "productionModeId",
  "productionModeStartAt",
  "openCallCount",
  "callsUpdatedAt",
  "lastCycleSeconds",
  "lastCycleCompletedAt",
]);

const SCALAR_FIELDS = new Map(
  SYSTEM_ENTITY_REGISTRY.map((entity) => [
    entity.key,
    new Set(
      entity.fields
        .filter((field) => !field.relation && field.type !== "OBJECT" && field.type !== "JSON")
        .map((field) => field.path ?? field.name),
    ),
  ]),
);

export const GRAPH_READ_CACHE_TTL_MS = 5_000;
const GRAPH_READ_CACHE_MAX_ENTRIES = 10_000;

interface DefinitionMetadata {
  siteId: string;
  typeRef?: string | null;
  typeContext?: unknown;
  facets?: unknown;
}

interface FacetDefinition {
  key: string;
  resolverType: string;
  resolver: unknown;
}

/** Per-read evaluator. A graph definition is not an ownership claim: prove every input. */
export class PublishedGraphAccess {
  private readonly cache = new Map<string, Promise<unknown>>();
  private expiresAt: number;
  private generation = 0;

  constructor(
    readonly scope: PublishedReadScope,
    private readonly db: PrismaClient = prisma,
    private readonly now: () => number = Date.now,
  ) {
    this.expiresAt = now() + GRAPH_READ_CACHE_TTL_MS;
  }

  /** Per-request/connection only. Revalidation replaces the scope and evaluator. */
  invalidate(): void {
    this.cache.clear();
    this.generation += 1;
    this.expiresAt = this.now() + GRAPH_READ_CACHE_TTL_MS;
  }

  private revision(): number {
    if (this.now() >= this.expiresAt) this.invalidate();
    return this.generation;
  }

  private memo<T>(key: string, load: () => Promise<T>): Promise<T> {
    this.revision();
    const cached = this.cache.get(key);
    if (cached) return cached as Promise<T>;
    if (this.cache.size >= GRAPH_READ_CACHE_MAX_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    const pending = load().catch((error: unknown) => {
      if (this.cache.get(key) === pending) this.cache.delete(key);
      throw error;
    });
    this.cache.set(key, pending);
    return pending;
  }

  private async decision(key: string, check: () => Promise<boolean>): Promise<boolean> {
    const revision = this.revision();
    const allowed = await this.memo(key, check);
    // An in-flight lookup cannot resurrect an invalidated decision.
    return revision === this.revision() && allowed;
  }

  metric(entityType: string, entityId: string): Promise<boolean> {
    return this.decision(JSON.stringify(["metric", entityType, entityId]), () =>
      canReadMetricEntity(this.scope, { entityType, entityId }, this.db),
    );
  }

  entity(entityType: string, entityId: string, path: string): Promise<boolean> {
    return this.decision(JSON.stringify(["entity", entityType, entityId, path]), () =>
      this.readEntity(entityType, entityId, path),
    );
  }

  private async readEntity(entityType: string, entityId: string, path: string): Promise<boolean> {
    if (entityType === "imm.station") {
      if (!STATION_FIELDS.has(path) && !SCALAR_FIELDS.get(entityType)?.has(path)) return false;
      return this.metric("STATION", entityId);
    }
    if (entityType === "imm.workcenter") {
      // Children/parent pointers can disclose other WCs, including from a granted parent.
      if (!["id", "name", "description", "siteId", "site"].includes(path)) {
        if (this.scope.workcenterIds !== undefined) return false;
        if (path === "stations") {
          const foreignStation = await this.db.station.findFirst({
            where: { workcenterId: entityId, siteId: { not: this.scope.siteId } },
            select: { id: true },
          });
          if (foreignStation) return false;
        } else if (path === "parent" || path === "parentId" || path === "children") {
          const row = await this.db.workcenter.findUnique({
            where: { id: entityId },
            select: { parent: { select: { siteId: true } }, children: { select: { siteId: true } } },
          });
          if (
            !row ||
            (row.parent && row.parent.siteId !== this.scope.siteId) ||
            row.children.some((child) => child.siteId !== this.scope.siteId)
          )
            return false;
        } else return false;
      }
      return this.metric("WORKCENTER", entityId);
    }
    if (entityType === "imm.site") {
      return (
        this.scope.referenceRead &&
        entityId === this.scope.siteId &&
        (REFERENCE_FIELDS.has(path) ||
          (this.scope.workcenterIds === undefined && ["stations", "workcenters"].includes(path)))
      );
    }
    const references = {
      "imm.job": this.db.job,
      "imm.product": this.db.product,
      "imm.material": this.db.material,
      "imm.tool": this.db.tool,
      "imm.statusReason": this.db.statusReason,
      "imm.statusCategory": this.db.statusCategory,
    };
    if (entityType in references) {
      if (entityType === "imm.job" && path === "stations" && this.scope.workcenterIds === undefined) {
        const job = await this.db.job.findUnique({
          where: { id: entityId },
          select: { siteId: true, currentOfStations: { select: { siteId: true } } },
        });
        return (
          job?.siteId === this.scope.siteId &&
          job.currentOfStations.every((station) => station.siteId === this.scope.siteId)
        );
      }
      if (!this.scope.referenceRead || (!REFERENCE_FIELDS.has(path) && !SCALAR_FIELDS.get(entityType)?.has(path)))
        return false;
      // Tool counters are production totals, not shared tooling catalog metadata.
      if (["pmCount", "lifeCount"].includes(path) && this.scope.workcenterIds !== undefined) return false;
      // Delegates share the narrow id/site projection but their generated overloads differ.
      const delegate = references[entityType as keyof typeof references] as unknown as {
        findUnique(args: { where: { id: string }; select: { siteId: true } }): Promise<{ siteId: string } | null>;
      };
      return (
        (await delegate.findUnique({ where: { id: entityId }, select: { siteId: true } }))?.siteId === this.scope.siteId
      );
    }
    const planning = {
      "imm.order": this.db.order,
      "imm.customer": this.db.customer,
      "imm.workOrder": this.db.workOrder,
      "imm.shiftInstance": this.db.shiftInstance,
    };
    if (entityType in planning) {
      if (!this.scope.planningRead || !SCALAR_FIELDS.get(entityType)?.has(path)) return false;
      const delegate = planning[entityType as keyof typeof planning] as unknown as {
        findUnique(args: { where: { id: string }; select: { siteId: true } }): Promise<{ siteId: string } | null>;
      };
      // No native relation traversal through published properties.
      if (["stations", "workcenters", "children", "sites", "workcenter", "workcenterId"].includes(path)) return false;
      return (
        (await delegate.findUnique({ where: { id: entityId }, select: { siteId: true } }))?.siteId === this.scope.siteId
      );
    }
    if (entityType === "imm.employee") {
      return (
        this.scope.plantAdmin &&
        !!(await this.db.employee.findFirst({
          where: {
            id: entityId,
            workspaceId: this.scope.workspaceId,
            siteAccess: { some: { siteId: this.scope.siteId, status: "ACTIVE" } },
          },
          select: { id: true },
        }))
      );
    }
    if (entityType === "datasource.point") {
      return ["id", "name", "description", "staticValue"].includes(path) && canReadPoint(this.scope, entityId, this.db);
    }
    if (!this.scope.configurationRead) return false;
    return !!(await this.db.objectInstance.findFirst({
      where: {
        id: entityId,
        siteId: this.scope.siteId,
        schema: { workspaceId: this.scope.workspaceId, source: "DOCUMENT", isDeleted: false },
        isDeleted: false,
      },
      select: { id: true },
    }));
  }

  async property(id: string, seen = new Set<string>(), valueTimestamp?: number): Promise<boolean> {
    const revision = this.revision();
    if (seen.has(id) || seen.size >= 100) return false;
    const next = new Set(seen).add(id);
    // Cache definitions separately from timestamps: every new value can reuse
    // the same ownership proof while still checking freshness on every delivery.
    const property = await this.memo(`property:${id}`, () =>
      this.db.graphProperty.findUnique({
        where: { id },
        select: {
          isDeleted: true,
          updatedAt: true,
          resolver: true,
          resolverType: true,
          node: { select: { siteId: true, isDeleted: true } },
        },
      }),
    );
    if (!property || property.isDeleted || property.node.isDeleted || property.node.siteId !== this.scope.siteId)
      return false;
    // A cached value predating a resolver edit may still contain the previous
    // owner's data until the engine evaluates its new definition.
    if (
      valueTimestamp !== undefined &&
      (!Number.isFinite(valueTimestamp) || valueTimestamp < property.updatedAt.getTime())
    )
      return false;
    const allowed = await this.resolver(property.resolverType, property.resolver, next, valueTimestamp);
    return revision === this.revision() && allowed;
  }

  async resolver(type: string, value: unknown, seen = new Set<string>(), valueTimestamp?: number): Promise<boolean> {
    if (!isRecord(value)) return false;
    if (type === "entity") {
      return (
        typeof value.entityType === "string" &&
        typeof value.entityId === "string" &&
        typeof value.path === "string" &&
        this.entity(value.entityType, value.entityId, value.path)
      );
    }
    if (type === "metric") {
      return (
        typeof value.entityType === "string" &&
        typeof value.entityId === "string" &&
        this.metric(value.entityType.toUpperCase(), value.entityId)
      );
    }
    if (type === "expr" || type === "window" || type === "totalizer") {
      const ids: string[] = [];
      if (type === "expr") {
        if (typeof value.expression !== "string") return false;
        for (const match of value.expression.matchAll(
          /\bp_([0-9a-f]{8}_[0-9a-f]{4}_[0-9a-f]{4}_[0-9a-f]{4}_[0-9a-f]{12})\b/gi,
        ))
          ids.push(match[1].replaceAll("_", "-"));
      } else {
        if (typeof value.sourcePropertyId !== "string") return false;
        ids.push(value.sourcePropertyId);
        for (const trigger of [value.trigger, value.reset]) {
          if (trigger === undefined) continue;
          if (!isRecord(trigger) || !isRecord(trigger.source) || typeof trigger.source.propertyId !== "string")
            return false;
          ids.push(trigger.source.propertyId);
        }
      }
      if (!ids.length) return this.scope.workcenterIds === undefined;
      for (const id of ids) if (!(await this.property(id, seen, valueTimestamp))) return false;
      return true;
    }
    // Dynamic rollup inputs and raw tags lack a stable exclusive WC read contract.
    // Site readers retain these production values; scoped readers fail closed.
    return (type === "rollup" || type === "tag") && this.scope.workcenterIds === undefined;
  }

  private facetDefinitions(typeRef: string): Promise<readonly FacetDefinition[]> {
    return this.memo(`facets:${typeRef}`, async () => {
      let parsed: ReturnType<typeof parseGraphTypeRef>;
      try {
        parsed = parseGraphTypeRef(typeRef);
      } catch {
        return [];
      }
      if (parsed.namespace) return getLivestoreGraphTypeSchema(typeRef)?.facets ?? [];
      const type = await this.db.graphNodeType.findUnique({
        where: { siteId_key: { siteId: this.scope.siteId, key: parsed.key } },
        select: {
          isDeleted: true,
          facets: { where: { isDeleted: false }, select: { key: true, resolverType: true, resolver: true } },
        },
      });
      return type && !type.isDeleted ? type.facets : [];
    });
  }

  /** Config inputs are editable definitions; materialized facet outputs are data. */
  async definitionMetadata<T extends DefinitionMetadata>(node: T): Promise<T> {
    if (!this.scope.configurationRead || node.siteId !== this.scope.siteId) {
      return { ...node, typeContext: {}, facets: {} };
    }
    if (!isRecord(node.facets) || Object.keys(node.facets).length === 0) return node;
    const revision = this.revision();
    const definitions = node.typeRef ? await this.facetDefinitions(node.typeRef) : [];
    const context = isRecord(node.typeContext) ? node.typeContext : {};
    const facets: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node.facets)) {
      const definition = definitions.find((facet) => facet.key === key);
      const resolver = definition?.resolver;
      facets[key] = null;
      if (definition?.resolverType !== "entity" || !isRecord(resolver) || !isRecord(resolver.entityRef)) continue;
      const { key: entityType, id } = resolver.entityRef;
      const template = typeof id === "string" ? /^\$(?:input|context)\.([a-zA-Z0-9_-]+)$/.exec(id) : null;
      const entityId = template ? context[template[1]] : id;
      if (typeof entityType !== "string" || typeof entityId !== "string" || typeof resolver.path !== "string") continue;
      if (await this.entity(entityType, entityId, resolver.path)) facets[key] = value;
    }
    if (revision !== this.revision()) {
      for (const key of Object.keys(facets)) facets[key] = null;
    }
    return { ...node, facets };
  }

  /** RPC property records carry definition metadata, sometimes a whole parent node. */
  async propertyMetadata<T>(property: T): Promise<T> {
    if (!this.scope.configurationRead) return publishedProperty(property);
    if (!isRecord(property) || !isRecord(property.node) || property.node.siteId !== this.scope.siteId) return property;
    const node = property.node as unknown as DefinitionMetadata;
    return { ...property, node: await this.definitionMetadata(node) };
  }

  async node<T extends { id: string; siteId: string; properties: { id: string }[] }>(node: T): Promise<T | null> {
    if (node.siteId !== this.scope.siteId) return null;
    const properties = [];
    for (const p of node.properties) {
      const current = (p as { current?: unknown }).current;
      if (this.scope.configurationRead) {
        // Keep every editable property definition, even when its value is denied.
        if (
          current !== undefined &&
          (!isRecord(current) ||
            typeof current.timestamp !== "number" ||
            !(await this.property(p.id, new Set(), current.timestamp)))
        ) {
          properties.push({ ...p, current: { value: null, quality: "stale", timestamp: 0 } });
        } else properties.push(p);
      } else {
        if (!(await this.property(p.id))) continue;
        if (
          isRecord(current) &&
          typeof current.timestamp === "number" &&
          !(await this.property(p.id, new Set(), current.timestamp))
        ) {
          properties.push({ ...p, current: { value: null, quality: "stale", timestamp: current.timestamp } });
        } else properties.push(p);
      }
    }
    const requested = (node as T & { requestedProperties?: Record<string, { id: string } | null> }).requestedProperties;
    const byId = new Map(properties.map((p) => [p.id, p]));
    // Rebind to the shaped property; the original alias may still carry a denied current envelope.
    const requestedProperties =
      requested &&
      Object.fromEntries(
        Object.entries(requested).map(([key, value]) => [key, value ? (byId.get(value.id) ?? null) : null]),
      );
    if (this.scope.configurationRead) {
      return this.definitionMetadata({ ...node, properties, requestedProperties });
    }
    if (!properties.length && (this.scope.workcenterIds !== undefined || node.properties.length > 0)) return null;
    // Facets/typeContext may embed arbitrary foreign ids. Preserve only built-in
    // ownership inputs proved against the real resource; never trust stored facets.
    const definition = node as T & { typeRef?: string | null; typeContext?: unknown };
    const input = isRecord(definition.typeContext) ? definition.typeContext : {};
    let typeContext: Record<string, unknown> = {};
    let facets: Record<string, unknown> = {};
    if (definition.typeRef === "@imm/station" && typeof input.stationId === "string") {
      if (!(await this.metric("STATION", input.stationId))) return null;
      const stationId = input.stationId;
      const station = await this.memo(`station:${stationId}`, () =>
        this.db.station.findUnique({ where: { id: stationId }, select: { workcenterId: true } }),
      );
      typeContext = { stationId: input.stationId };
      facets = { stationId: input.stationId, workcenterId: station?.workcenterId ?? null };
    } else if (definition.typeRef === "@imm/workcenter" && typeof input.workcenterId === "string") {
      if (!(await this.metric("WORKCENTER", input.workcenterId))) return null;
      typeContext = { workcenterId: input.workcenterId };
      facets = { workcenterId: input.workcenterId, siteId: this.scope.siteId };
    } else if (definition.typeRef === "@imm/site" && input.siteId === this.scope.siteId) {
      typeContext = { siteId: this.scope.siteId };
      facets = typeContext;
    }
    return { ...node, typeContext, facets, properties, requestedProperties };
  }
}

/** Property.get includes a complete parent node; never publish its siblings or facets. */
export function publishedProperty<T>(value: T): T {
  if (!isRecord(value) || !isRecord(value.node)) return value;
  return { ...value, node: { id: value.node.id, siteId: value.node.siteId } };
}
