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
      this.topo = graph.nodes();
    }
  }

  upsertProperties(properties: Iterable<PropertyRuntime>): void {
    for (const property of properties) {
      this.graph.setNode(property.id, { resolverType: property.resolverType });
    }
    this.recomputeTopo();
  }

  removeProperties(propertyIds: Iterable<string>): void {
    for (const propertyId of propertyIds) {
      if (this.graph.hasNode(propertyId)) this.graph.removeNode(propertyId);
    }
    this.recomputeTopo();
  }

  replaceEdges(args: {
    targetPropertyIds?: Iterable<string>;
    removeEdgeIds?: Iterable<string>;
    removeIncidentPropertyIds?: Iterable<string>;
    edges: Iterable<GraphEdgeRuntime>;
  }): void {
    const targetIds = new Set(args.targetPropertyIds ?? []);
    const edgeIds = new Set(args.removeEdgeIds ?? []);
    const incidentIds = new Set(args.removeIncidentPropertyIds ?? []);

    for (const edge of this.graph.edges()) {
      const label = this.graph.edge(edge) as { id?: string } | undefined;
      if (
        targetIds.has(edge.w) ||
        incidentIds.has(edge.v) ||
        incidentIds.has(edge.w) ||
        (label?.id !== undefined && edgeIds.has(label.id))
      ) {
        this.graph.removeEdge(edge);
      }
    }

    for (const edge of args.edges) {
      if (!this.graph.hasNode(edge.fromPropertyId) || !this.graph.hasNode(edge.toPropertyId)) continue;
      this.graph.setEdge(edge.fromPropertyId, edge.toPropertyId, { id: edge.id });
    }

    this.recomputeTopo();
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

  private recomputeTopo(): void {
    try {
      this.topo = graphlib.alg.topsort(this.graph);
    } catch {
      this.topo = this.graph.nodes();
    }
  }
}
