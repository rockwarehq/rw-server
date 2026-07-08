import type { PrismaClient } from "@rw/db";

import type { CvgStore } from "../value/cvg-store.js";
import { DependencyGraph } from "./dependency-graph.js";
import {
  parseGraphResolver,
  staleEnvelope,
  type GraphEdgeRuntime,
  type GraphSnapshotNode,
  type LivestoreLogger,
  type NodeRuntime,
  type PropertyRuntime,
  type ValueEnvelope,
} from "../value/types.js";

interface LoadedNodeDefinition {
  node: NodeRuntime;
  properties: PropertyRuntime[];
  edges: GraphEdgeRuntime[];
}

interface LoadedPropertyDefinition {
  node: NodeRuntime;
  property: PropertyRuntime;
  edges: GraphEdgeRuntime[];
}

export interface KernelPropertyUpsert {
  previous: PropertyRuntime | null;
  current: PropertyRuntime;
}

export interface KernelPatchResult {
  upsertedProperties: KernelPropertyUpsert[];
  removedProperties: PropertyRuntime[];
}

export class GraphKernel {
  private readonly nodes = new Map<string, NodeRuntime>();
  private readonly properties = new Map<string, PropertyRuntime>();
  private readonly dependencyGraph = new DependencyGraph();
  private persistedEdges: GraphEdgeRuntime[] = [];
  private rollupEdges: GraphEdgeRuntime[] = [];

  constructor(
    private readonly prisma: PrismaClient,
    private readonly cvg: CvgStore,
    private readonly logger: LivestoreLogger,
  ) {}

  async load(): Promise<void> {
    const nodes = await this.prisma.graphNode.findMany({
      where: { isDeleted: false },
      include: {
        properties: {
          where: { isDeleted: false },
          orderBy: { name: "asc" },
        },
      },
      orderBy: { name: "asc" },
    });

    const edges = await this.prisma.graphEdge.findMany({
      where: {
        fromProperty: { isDeleted: false, node: { isDeleted: false } },
        toProperty: { isDeleted: false, node: { isDeleted: false } },
      },
    });

    this.nodes.clear();
    this.properties.clear();

    for (const node of nodes) {
      const runtimeNode: NodeRuntime = {
        id: node.id,
        name: node.name,
        siteId: node.siteId,
        typeRef: node.typeRef,
        typeContext: parseTypeContext(node.typeContext),
        propertyIds: [],
      };
      this.nodes.set(node.id, runtimeNode);

      for (const property of node.properties) {
        const current = (await this.cvg.get(property.id)) ?? staleEnvelope();
        const runtimeProperty: PropertyRuntime = {
          id: property.id,
          nodeId: property.nodeId,
          name: property.name,
          resolverType: property.resolverType,
          resolver: parseGraphResolver(property.resolver, property.resolverType),
          sampleRateMs: property.sampleRateMs,
          current,
        };

        runtimeNode.propertyIds.push(property.id);
        this.properties.set(property.id, runtimeProperty);
      }
    }

    const runtimeEdges: GraphEdgeRuntime[] = edges.map((edge) => ({
      id: edge.id,
      fromPropertyId: edge.fromPropertyId,
      toPropertyId: edge.toPropertyId,
    }));
    this.persistedEdges = runtimeEdges;
    this.dependencyGraph.rebuild(this.properties.values(), runtimeEdges);

    this.logger.info(
      {
        nodeCount: this.nodes.size,
        propertyCount: this.properties.size,
        edgeCount: runtimeEdges.length,
      },
      "livestore kernel loaded",
    );
  }

  async loadNodeDefinition(nodeId: string): Promise<LoadedNodeDefinition | null> {
    const node = await this.prisma.graphNode.findFirst({
      where: { id: nodeId, isDeleted: false },
      include: {
        properties: {
          where: { isDeleted: false },
          orderBy: { name: "asc" },
        },
      },
    });
    if (!node) return null;

    const properties: PropertyRuntime[] = [];
    for (const property of node.properties) {
      properties.push(await this.hydrateProperty(property));
    }
    const edges = await this.loadIncomingStaticEdges(properties.map((property) => property.id));

    return {
      node: {
        id: node.id,
        name: node.name,
        siteId: node.siteId,
        typeRef: node.typeRef,
        typeContext: parseTypeContext(node.typeContext),
        propertyIds: properties.map((property) => property.id),
      },
      properties,
      edges,
    };
  }

  async loadPropertyDefinition(propertyId: string): Promise<LoadedPropertyDefinition | null> {
    const property = await this.prisma.graphProperty.findFirst({
      where: { id: propertyId, isDeleted: false, node: { isDeleted: false } },
      include: { node: true },
    });
    if (!property) return null;
    const runtimeProperty = await this.hydrateProperty(property);
    const edges = await this.loadIncomingStaticEdges([property.id]);

    return {
      node: {
        id: property.node.id,
        name: property.node.name,
        siteId: property.node.siteId,
        typeRef: property.node.typeRef,
        typeContext: parseTypeContext(property.node.typeContext),
        propertyIds: [],
      },
      property: runtimeProperty,
      edges,
    };
  }

  applyNodeDefinition(definition: LoadedNodeDefinition): KernelPatchResult {
    const previousProperties = this.getNodeProperties(definition.node.id);
    const previousById = new Map(previousProperties.map((property) => [property.id, this.cloneProperty(property)]));
    const nextIds = new Set(definition.properties.map((property) => property.id));
    const removedProperties = previousProperties
      .filter((property) => !nextIds.has(property.id))
      .map((property) => this.cloneProperty(property));

    const runtimeNode: NodeRuntime = { ...definition.node, propertyIds: [] };
    this.nodes.set(runtimeNode.id, runtimeNode);

    const upsertedProperties: KernelPropertyUpsert[] = [];
    for (const property of definition.properties) {
      const previous = previousById.get(property.id) ?? null;
      const current = { ...property, current: previous?.current ?? property.current };
      runtimeNode.propertyIds.push(current.id);
      this.properties.set(current.id, current);
      upsertedProperties.push({ previous, current });
    }

    for (const property of removedProperties) this.properties.delete(property.id);

    const targetIds = definition.properties.map((property) => property.id);
    const removedIds = removedProperties.map((property) => property.id);
    this.replacePersistedEdges(targetIds, definition.edges, removedIds);
    this.dependencyGraph.removeProperties(removedIds);
    this.dependencyGraph.upsertProperties(definition.properties);
    this.dependencyGraph.replaceEdges({
      targetPropertyIds: targetIds,
      removeIncidentPropertyIds: removedIds,
      edges: [...definition.edges, ...this.rollupEdges],
    });

    return { upsertedProperties, removedProperties };
  }

  applyPropertyDefinition(definition: LoadedPropertyDefinition): KernelPatchResult {
    const node = this.nodes.get(definition.node.id) ?? { ...definition.node, propertyIds: [] };
    node.name = definition.node.name;
    node.typeRef = definition.node.typeRef;
    node.typeContext = definition.node.typeContext;
    this.nodes.set(node.id, node);

    const previous = this.properties.get(definition.property.id);
    const previousSnapshot = previous ? this.cloneProperty(previous) : null;
    const current = { ...definition.property, current: previous?.current ?? definition.property.current };
    this.properties.set(current.id, current);
    if (!node.propertyIds.includes(current.id)) node.propertyIds.push(current.id);
    node.propertyIds.sort((a, b) =>
      (this.properties.get(a)?.name ?? a).localeCompare(this.properties.get(b)?.name ?? b),
    );

    this.replacePersistedEdges([current.id], definition.edges, []);
    this.dependencyGraph.upsertProperties([current]);
    this.dependencyGraph.replaceEdges({
      targetPropertyIds: [current.id],
      edges: [...definition.edges, ...this.rollupEdges],
    });

    return { upsertedProperties: [{ previous: previousSnapshot, current }], removedProperties: [] };
  }

  removeNode(nodeId: string): KernelPatchResult {
    const removedProperties = this.getNodeProperties(nodeId).map((property) => this.cloneProperty(property));
    for (const property of removedProperties) this.properties.delete(property.id);
    this.nodes.delete(nodeId);
    const removedIds = removedProperties.map((property) => property.id);
    this.persistedEdges = this.persistedEdges.filter(
      (edge) => !removedIds.includes(edge.fromPropertyId) && !removedIds.includes(edge.toPropertyId),
    );
    this.dependencyGraph.removeProperties(removedIds);
    this.dependencyGraph.replaceEdges({ removeIncidentPropertyIds: removedIds, edges: this.rollupEdges });
    return { upsertedProperties: [], removedProperties };
  }

  removeProperty(propertyId: string): KernelPatchResult {
    const previous = this.properties.get(propertyId);
    if (!previous) return { upsertedProperties: [], removedProperties: [] };
    const removed = this.cloneProperty(previous);
    this.properties.delete(propertyId);
    const node = this.nodes.get(previous.nodeId);
    if (node) node.propertyIds = node.propertyIds.filter((id) => id !== propertyId);
    this.persistedEdges = this.persistedEdges.filter(
      (edge) => edge.fromPropertyId !== propertyId && edge.toPropertyId !== propertyId,
    );
    this.dependencyGraph.removeProperties([propertyId]);
    this.dependencyGraph.replaceEdges({ removeIncidentPropertyIds: [propertyId], edges: this.rollupEdges });
    return { upsertedProperties: [], removedProperties: [removed] };
  }

  applyExternalValue(propertyId: string, envelope: ValueEnvelope): PropertyRuntime | null {
    const property = this.properties.get(propertyId);
    if (!property) return null;
    property.current = envelope;
    return property;
  }

  getProperty(propertyId: string): PropertyRuntime | null {
    return this.properties.get(propertyId) ?? null;
  }

  getCurrent(propertyId: string): ValueEnvelope | null {
    return this.properties.get(propertyId)?.current ?? null;
  }

  listProperties(): PropertyRuntime[] {
    return Array.from(this.properties.values());
  }

  listNodes(): GraphSnapshotNode[] {
    return Array.from(this.nodes.values()).map((node) => this.snapshotNode(node));
  }

  listNodesForSite(siteId: string): GraphSnapshotNode[] {
    return Array.from(this.nodes.values())
      .filter((node) => node.siteId === siteId)
      .map((node) => this.snapshotNode(node));
  }

  getNode(nodeId: string): GraphSnapshotNode | null {
    const node = this.nodes.get(nodeId);
    return node ? this.snapshotNode(node) : null;
  }

  // Tenancy lookup for subscription authorization: property → node → site.
  // Pure in-memory, O(1); null for unknown properties.
  getPropertySiteId(propertyId: string): string | null {
    const property = this.properties.get(propertyId);
    if (!property) return null;
    return this.nodes.get(property.nodeId)?.siteId ?? null;
  }

  getDependents(propertyId: string): string[] {
    return this.dependencyGraph.getDependents(propertyId);
  }

  getDependencies(propertyId: string): string[] {
    return this.dependencyGraph.getDependencies(propertyId);
  }

  topoOrder(): string[] {
    return this.dependencyGraph.topoOrder();
  }

  // Inject runtime rollup into DAG
  // Rebuilt each boot from the domain model
  applyRollupEdges(rollupEdges: GraphEdgeRuntime[]): void {
    const oldIds = this.rollupEdges.map((edge) => edge.id);
    this.rollupEdges = rollupEdges;
    this.dependencyGraph.replaceEdges({ removeEdgeIds: oldIds, edges: rollupEdges });
    this.logger.info({ rollupEdges: rollupEdges.length }, "livestore rollup edges applied");
  }

  counts(): { nodeCount: number; propertyCount: number; edgeCount: number } {
    return {
      nodeCount: this.nodes.size,
      propertyCount: this.properties.size,
      edgeCount: this.dependencyGraph.edgeCount(),
    };
  }

  private snapshotNode(node: NodeRuntime): GraphSnapshotNode {
    const properties = node.propertyIds
      .map((propertyId) => this.properties.get(propertyId))
      .filter((property): property is PropertyRuntime => Boolean(property))
      .map((property) => ({ ...property, current: property.current }));

    return {
      id: node.id,
      name: node.name,
      siteId: node.siteId,
      typeRef: node.typeRef,
      typeContext: node.typeContext,
      properties,
    };
  }

  private async hydrateProperty(property: {
    id: string;
    nodeId: string;
    name: string;
    resolverType: string;
    resolver: unknown;
    sampleRateMs: number | null;
  }): Promise<PropertyRuntime> {
    const current = (await this.cvg.get(property.id)) ?? staleEnvelope();
    return {
      id: property.id,
      nodeId: property.nodeId,
      name: property.name,
      resolverType: property.resolverType,
      resolver: parseGraphResolver(property.resolver, property.resolverType),
      sampleRateMs: property.sampleRateMs,
      current,
    };
  }

  private async loadIncomingStaticEdges(propertyIds: string[]): Promise<GraphEdgeRuntime[]> {
    if (propertyIds.length === 0) return [];
    const edges = await this.prisma.graphEdge.findMany({
      where: {
        toPropertyId: { in: propertyIds },
        fromProperty: { isDeleted: false, node: { isDeleted: false } },
        toProperty: { isDeleted: false, node: { isDeleted: false } },
      },
    });
    return edges.map((edge) => ({
      id: edge.id,
      fromPropertyId: edge.fromPropertyId,
      toPropertyId: edge.toPropertyId,
    }));
  }

  private replacePersistedEdges(targetIds: string[], edges: GraphEdgeRuntime[], removedIds: string[]): void {
    const targets = new Set(targetIds);
    const removed = new Set(removedIds);
    this.persistedEdges = this.persistedEdges.filter(
      (edge) => !targets.has(edge.toPropertyId) && !removed.has(edge.fromPropertyId) && !removed.has(edge.toPropertyId),
    );
    this.persistedEdges.push(...edges);
  }

  private getNodeProperties(nodeId: string): PropertyRuntime[] {
    return Array.from(this.properties.values()).filter((property) => property.nodeId === nodeId);
  }

  private cloneProperty(property: PropertyRuntime): PropertyRuntime {
    return { ...property, current: property.current };
  }
}

function parseTypeContext(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
