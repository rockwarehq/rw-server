import graphlib from "graphlib";

import type { GraphEdgeRuntime, PropertyRuntime } from "./types.js";

export class DependencyGraph {
  private graph = new graphlib.Graph({ directed: true, multigraph: false, compound: false });
  // Topological order (inputs before outputs), cached on rebuild for the flush pass.
  private topo: string[] = [];

  rebuild(properties: Iterable<PropertyRuntime>, edges: Iterable<GraphEdgeRuntime>): void {
    const graph = new graphlib.Graph({ directed: true, multigraph: false, compound: false });

    for (const property of properties) {
      graph.setNode(property.id, { resolverType: property.resolverType });
    }

    for (const edge of edges) {
      if (!graph.hasNode(edge.fromPropertyId) || !graph.hasNode(edge.toPropertyId)) continue;
      graph.setEdge(edge.fromPropertyId, edge.toPropertyId, { id: edge.id });
    }

    this.graph = graph;
    try {
      this.topo = graphlib.alg.topsort(graph);
    } catch {
      // Cycle: topsort throws. Fall back to node order; save-time cycle prevention is later work.
      this.topo = graph.nodes();
    }
  }

  topoOrder(): string[] {
    return this.topo;
  }

  hasProperty(propertyId: string): boolean {
    return this.graph.hasNode(propertyId);
  }

  getDependents(propertyId: string): string[] {
    return this.graph.successors(propertyId) ?? [];
  }

  getDependencies(propertyId: string): string[] {
    return this.graph.predecessors(propertyId) ?? [];
  }

  propertyCount(): number {
    return this.graph.nodeCount();
  }

  edgeCount(): number {
    return this.graph.edgeCount();
  }
}
