import graphlib from "graphlib";

import type { GraphEdgeRuntime, LivestoreLogger, PropertyRuntime } from "../types/index.js";

// Edge labels hold the SET of logical edge ids sharing a (from, to) pair: a
// user-drawn persisted edge and a derived rollup edge can coincide, and the
// graph is not a multigraph — removing one id must not sever the other.
interface EdgeLabel {
  ids: Set<string>;
}

export class DependencyGraph {
  private graph = new graphlib.Graph({ directed: true, multigraph: false, compound: false });
  // Topological order (inputs before outputs), cached on rebuild for the flush pass.
  private topo: string[] = [];
  // Members of dependency cycles, excluded from topo until the cycle is broken.
  private quarantined = new Set<string>();

  constructor(private readonly logger?: LivestoreLogger) {}

  rebuild(properties: Iterable<PropertyRuntime>, edges: Iterable<GraphEdgeRuntime>): void {
    const graph = new graphlib.Graph({ directed: true, multigraph: false, compound: false });

    for (const property of properties) {
      graph.setNode(property.id, { resolverType: property.resolverType });
    }

    this.graph = graph;
    for (const edge of edges) this.addEdge(edge);
    this.recomputeTopo();
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
      if (targetIds.has(edge.w) || incidentIds.has(edge.v) || incidentIds.has(edge.w)) {
        this.graph.removeEdge(edge);
        continue;
      }
      const label = this.graph.edge(edge) as EdgeLabel | undefined;
      if (!label) continue;
      for (const id of label.ids) {
        if (edgeIds.has(id)) label.ids.delete(id);
      }
      if (label.ids.size === 0) this.graph.removeEdge(edge);
    }

    for (const edge of args.edges) this.addEdge(edge);

    this.recomputeTopo();
  }

  topoOrder(): string[] {
    return this.topo;
  }

  hasProperty(propertyId: string): boolean {
    return this.graph.hasNode(propertyId);
  }

  isQuarantined(propertyId: string): boolean {
    return this.quarantined.has(propertyId);
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

  private addEdge(edge: GraphEdgeRuntime): void {
    if (!this.graph.hasNode(edge.fromPropertyId) || !this.graph.hasNode(edge.toPropertyId)) return;
    const existing = this.graph.edge(edge.fromPropertyId, edge.toPropertyId) as EdgeLabel | undefined;
    if (existing) existing.ids.add(edge.id);
    else this.graph.setEdge(edge.fromPropertyId, edge.toPropertyId, { ids: new Set([edge.id]) });
  }

  private recomputeTopo(): void {
    try {
      this.topo = graphlib.alg.topsort(this.graph);
      if (this.quarantined.size > 0) {
        this.logger?.info({ released: this.quarantined.size }, "livestore dependency cycles resolved");
        this.quarantined = new Set();
      }
    } catch {
      // Cycle members are quarantined: excluded from topo so the flush never
      // evaluates them (they'd never converge). The rest of the graph keeps
      // a valid order. Downstream of a cycle evaluates with stale inputs.
      const cycles = graphlib.alg.findCycles(this.graph);
      this.quarantined = new Set(cycles.flat());
      this.logger?.warn(
        { cycles: cycles.length, members: [...this.quarantined].slice(0, 20), total: this.quarantined.size },
        "livestore dependency graph has cycles — cycle members quarantined from evaluation",
      );

      const acyclic = new graphlib.Graph({ directed: true, multigraph: false, compound: false });
      for (const node of this.graph.nodes()) {
        if (!this.quarantined.has(node)) acyclic.setNode(node);
      }
      for (const edge of this.graph.edges()) {
        if (this.quarantined.has(edge.v) || this.quarantined.has(edge.w)) continue;
        acyclic.setEdge(edge.v, edge.w);
      }
      this.topo = graphlib.alg.topsort(acyclic);
    }
  }
}
