import type { PrismaClient } from "@rw/db";
import type { KV } from "@nats-io/kv";
import type { NatsConnection } from "@nats-io/nats-core";

import { AggStateStore } from "./agg-store.js";
import { CvgStore } from "./cvg-store.js";
import { syncDatasourceTags } from "./datasource-tag-sync.js";
import { loadEntityCatalog, type EntityCatalogEntry } from "./entityCatalog.js";
import { evaluateExpr } from "./expr.js";
import { GraphKernel } from "./kernel.js";
import { MetricResolver, type MetricSubscription } from "./metric-resolver.js";
import { syncNodes } from "./node-sync.js";
import { evaluateRollup } from "./rollup.js";
import { buildRollupEdges } from "./rollup-index.js";
import { Scheduler } from "./scheduler.js";
import { deriveMetricSubject } from "@rw/runtime/graph-subjects";
import { TagResolver } from "./tag-resolver.js";
import { WindowResolver } from "./window-resolver.js";
import {
  envelopesEqual,
  isExprResolverConfig,
  isMetricResolver,
  isRollupResolverConfig,
  isWindowResolverConfig,
  staleEnvelope,
  type CommitSource,
  type LivestoreLogger,
  type ValueEnvelope,
} from "./types.js";

export interface GraphRuntimeOptions {
  prisma: PrismaClient;
  nc: NatsConnection;
  kv: KV;
  aggKv: KV;
  logger: LivestoreLogger;
  isNatsReady?: () => boolean;
}

export class GraphRuntime {
  private readonly cvg: CvgStore;
  private readonly kernel: GraphKernel;
  private readonly tagResolver: TagResolver;
  private readonly metricResolver: MetricResolver;
  private readonly windowResolver: WindowResolver;
  private readonly scheduler: Scheduler;
  private catalog: Map<string, EntityCatalogEntry> = new Map();
  private ready = false;

  constructor(private readonly options: GraphRuntimeOptions) {
    this.cvg = new CvgStore(options.kv);
    this.kernel = new GraphKernel(options.prisma, this.cvg, options.logger);
    this.tagResolver = new TagResolver(options.nc, this, options.logger);
    this.metricResolver = new MetricResolver(options.nc, this, options.logger);
    this.windowResolver = new WindowResolver(new AggStateStore(options.aggKv), this, options.logger);
    this.scheduler = new Scheduler(
      (id) => this.kernel.getDependents(id),
      () => this.kernel.topoOrder(),
      (id) => this.evaluate(id),
      (id) => this.kernel.getProperty(id)?.resolverType === "window",
      options.logger,
    );
  }

  async start(): Promise<void> {
    this.catalog = loadEntityCatalog(this.options.prisma);
    this.options.logger.info({ kinds: [...this.catalog.keys()] }, "livestore entity catalog loaded");
    if (process.env.LIVESTORE_SYNC_NODES_ON_BOOT !== "false") {
      const result = await syncNodes(this.options.prisma);
      this.options.logger.info({ ...result }, "livestore node sync complete");
      // TEMPORARY until UI authoring — remove with datasource-tag-sync.ts.
      const tagResult = await syncDatasourceTags(this.options.prisma);
      this.options.logger.info({ ...tagResult }, "livestore datasource tag sync complete");
    }
    await this.kernel.load();

    const rollupEdges = await buildRollupEdges(this.options.prisma, this.kernel, this.options.logger);
    this.kernel.applyRollupEdges(rollupEdges);

    // Windows rehydrate before input subscriptions open, so no live sample can
    // arrive ahead of the resolver's source index.
    await this.windowResolver.start(this.kernel.listProperties(), (id) => this.kernel.getProperty(id));

    this.tagResolver.start(this.kernel.listProperties());
    this.metricResolver.start(this.buildMetricSubscriptions());
    this.ready = true;

    const computedIds = this.kernel
      .listProperties()
      .filter((property) => isRollupResolverConfig(property.resolver) || isExprResolverConfig(property.resolver))
      .map((property) => property.id);
    if (computedIds.length > 0) this.scheduler.markDirtyMany(computedIds);
  }

  async stop(): Promise<void> {
    this.ready = false;
    this.tagResolver.stop();
    this.metricResolver.stop();
    await this.windowResolver.stop(); // drains emit chains + flushes agg state to KV
    this.scheduler.stop();
  }

  private buildMetricSubscriptions(): MetricSubscription[] {
    const subs: MetricSubscription[] = [];
    for (const property of this.kernel.listProperties()) {
      if (!isMetricResolver(property.resolver)) continue;
      const subject = deriveMetricSubject(
        property.resolver.entityId,
        property.resolver.granularity,
        property.resolver.metricKey,
      );
      subs.push({ subject, propertyId: property.id });
    }
    return subs;
  }

  async commitValue(propertyId: string, envelope: ValueEnvelope, source: CommitSource): Promise<void> {
    const property = this.kernel.getProperty(propertyId);
    if (!property) {
      this.options.logger.warn({ propertyId, source }, "livestore commit ignored for unknown property");
      return;
    }

    const previous = property.current;
    this.kernel.applyExternalValue(propertyId, envelope);

    const changed = !envelopesEqual(previous, envelope);
    if (changed) {
      this.scheduler.markDirty(propertyId);
      // Fold before the KV await: windows must see every sample synchronously —
      // the 50ms flush only ever reads the latest current value.
      this.windowResolver.onInput(propertyId, envelope);
      await this.cvg.put(propertyId, envelope);
    }

    this.options.logger.info(
      {
        propertyId,
        resolverType: property.resolverType,
        quality: envelope.quality,
        timestamp: envelope.timestamp,
        source,
        changed,
      },
      "livestore property committed",
    );
  }

  async getCvgValue(propertyId: string): Promise<ValueEnvelope | null> {
    return this.cvg.get(propertyId);
  }

  async watchCvgValue(propertyId: string) {
    return this.cvg.watch(propertyId);
  }

  getCurrentOrStale(propertyId: string): ValueEnvelope {
    return this.kernel.getCurrent(propertyId) ?? staleEnvelope();
  }

  listNodes() {
    return this.kernel.listNodes();
  }

  listCatalog(): EntityCatalogEntry[] {
    return [...this.catalog.values()];
  }

  getNode(nodeId: string) {
    return this.kernel.getNode(nodeId);
  }

  counts() {
    return {
      ...this.kernel.counts(),
      ...this.windowResolver.counts(),
      tagSubscriptionCount: this.tagResolver.subscriptionCount(),
      metricSubscriptionCount: this.metricResolver.subscriptionCount(),
      catalogKindCount: this.catalog.size,
    };
  }

  isReady(): boolean {
    return this.ready && (this.options.isNatsReady?.() ?? true);
  }

  // Evaluate a computed property by its resolver type, 
  // using the current values of its dependencies.
  private async evaluate(propertyId: string): Promise<void> {
    const property = this.kernel.getProperty(propertyId);
    if (!property) return;
    // Windows never compute in a flush — they emit only from their own resolver.
    if (isWindowResolverConfig(property.resolver)) return;
    if (isRollupResolverConfig(property.resolver)) {
      const childIds = this.kernel.getDependencies(propertyId);
      const children = childIds.map((id) => this.kernel.getCurrent(id) ?? staleEnvelope());
      const envelope = evaluateRollup(property.resolver, children);
      await this.commitValue(propertyId, envelope, "rollup");
    } else if (isExprResolverConfig(property.resolver)) {
      const deps = this.kernel
        .getDependencies(propertyId)
        .map((id) => ({ id, current: this.kernel.getCurrent(id) ?? staleEnvelope() }));
      const envelope = evaluateExpr(property.resolver.expression, deps);
      await this.commitValue(propertyId, envelope, "expr");
    }
  }
}
