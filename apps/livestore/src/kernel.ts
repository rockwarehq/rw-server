import type { PrismaClient } from "@rw/db";

import type { CvgStore } from "./cvg-store.js";
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
} from "./types.js";

export class GraphKernel {
  private readonly nodes = new Map<string, NodeRuntime>();
  private readonly properties = new Map<string, PropertyRuntime>();
  private readonly dependencyGraph = new DependencyGraph();

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
        kind: node.kind,
        entityType: node.entityType,
        entityId: node.entityId,
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

  getNode(nodeId: string): GraphSnapshotNode | null {
    const node = this.nodes.get(nodeId);
    return node ? this.snapshotNode(node) : null;
  }

  getDependents(propertyId: string): string[] {
    return this.dependencyGraph.getDependents(propertyId);
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
      kind: node.kind,
      entityType: node.entityType,
      entityId: node.entityId,
      properties,
    };
  }
}
