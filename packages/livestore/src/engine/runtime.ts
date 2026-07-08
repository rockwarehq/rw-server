import type { PrismaClient } from "@rw/db";
import type { JetStreamClient, JetStreamManager } from "@nats-io/jetstream";
import type { KV } from "@nats-io/kv";
import type { NatsConnection } from "@nats-io/nats-core";
import type { GraphDefinitionEvent } from "../catalog/definitions.js";

import { AggStateStore } from "../store/agg-store.js";
import { CvgStore } from "../store/cvg-store.js";
import { GraphDefinitionConsumer } from "./definition-consumer.js";
import { EntityEventConsumer } from "./entity-event-consumer.js";
import { EntityResolver } from "../resolvers/entity-resolver.js";
import { evaluateExpr } from "../resolvers/expr.js";
import { HookManager } from "../resolvers/hook-manager.js";
import { GraphKernel } from "./kernel.js";
import { MetricResolver, type MetricSubscription } from "../resolvers/metric-resolver.js";
import { evaluateRollup } from "../resolvers/rollup.js";
import { buildRollupEdges } from "../resolvers/rollup-index.js";
import { SampleGate } from "./sample-gate.js";
import { Scheduler } from "./scheduler.js";
import { deriveMetricSubject } from "@rw/runtime/graph-subjects";
import { TagResolver } from "../resolvers/tag-resolver.js";
import { WindowResolver } from "../resolvers/window-resolver.js";
import {
  envelopesEqual,
  isExprResolverConfig,
  isMetricResolver,
  isRollupResolverConfig,
  isWindowResolverConfig,
  staleEnvelope,
  type CommitSource,
  type LivestoreLogger,
  type PropertyRuntime,
  type ValueEnvelope,
} from "../types/index.js";

export interface GraphRuntimeOptions {
  prisma: PrismaClient;
  nc: NatsConnection;
  jetstream: JetStreamClient;
  jetstreamManager: JetStreamManager;
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
  private readonly entityResolver: EntityResolver;
  private readonly windowResolver: WindowResolver;
  private readonly hookManager: HookManager;
  private readonly definitionConsumer: GraphDefinitionConsumer;
  private readonly entityEventConsumer: EntityEventConsumer;
  private readonly scheduler: Scheduler;
  private readonly sampleGate: SampleGate;
  private ready = false;
  private definitionFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private definitionReconcileTimer: ReturnType<typeof setInterval> | null = null;
  private definitionApplyChain: Promise<void> = Promise.resolve();
  private lastDefinitionReconcileAt = new Date();
  private readonly pendingDefinitionEvents = new Map<string, GraphDefinitionEvent>();
  private definitionWaiters: Array<{ resolve: () => void; reject: (err: unknown) => void }> = [];
  private kvPutFailures = 0;

  constructor(private readonly options: GraphRuntimeOptions) {
    this.cvg = new CvgStore(options.kv);
    this.kernel = new GraphKernel(options.prisma, this.cvg, options.logger);
    this.tagResolver = new TagResolver(options.jetstream, options.jetstreamManager, this, options.logger);
    this.metricResolver = new MetricResolver(options.nc, this, options.logger);
    this.entityResolver = new EntityResolver(options.prisma, this, options.logger, (id) => this.kernel.getProperty(id));
    this.hookManager = new HookManager(options.prisma, options.jetstream, options.jetstreamManager, options.logger);
    this.windowResolver = new WindowResolver(new AggStateStore(options.aggKv), this, options.logger);
    this.definitionConsumer = new GraphDefinitionConsumer(
      options.jetstream,
      options.jetstreamManager,
      this,
      options.logger,
    );
    this.entityEventConsumer = new EntityEventConsumer(
      options.jetstream,
      options.jetstreamManager,
      this.entityResolver,
      options.logger,
    );
    this.scheduler = new Scheduler(
      (id) => this.kernel.getDependents(id),
      () => this.kernel.topoOrder(),
      (id) => this.evaluate(id),
      (id) => this.kernel.getProperty(id)?.resolverType === "window",
      options.logger,
      () => this.hookManager.flushPending((id) => this.kernel.getCurrent(id)),
    );
    this.sampleGate = new SampleGate((id) => this.scheduler.markDirtyMany([id]));
  }

  private buildMetricSubscriptions(): MetricSubscription[] {
    const subs: MetricSubscription[] = [];
    for (const property of this.kernel.listProperties()) {
      const sub = this.metricSubscriptionForProperty(property);
      if (sub) subs.push(sub);
    }
    return subs;
  }

  private metricSubscriptionForProperty(property: PropertyRuntime): MetricSubscription | null {
    if (!isMetricResolver(property.resolver)) return null;
    return {
      subject: deriveMetricSubject(
        property.resolver.entityId,
        property.resolver.granularity,
        property.resolver.metricKey,
      ),
      propertyId: property.id,
    };
  }

  // Evaluate a computed property by its resolver type,
  // using the current values of its dependencies.
  private async evaluate(propertyId: string): Promise<void> {
    const property = this.kernel.getProperty(propertyId);
    if (!property) return;
    // Windows never compute in a flush — they emit only from their own resolver.
    if (isWindowResolverConfig(property.resolver)) return;
    if (isRollupResolverConfig(property.resolver)) {
      const resolver = property.resolver;
      const deps = this.kernel
        .getDependencies(propertyId)
        .map((id) => this.kernel.getProperty(id))
        .filter((dep) => dep !== null);
      const children = deps
        .filter((dep) => dep.name === resolver.childProperty)
        .map((dep) => ({
          current: dep.current,
          weight: resolver.weightBy
            ? deps.find((weight) => weight.nodeId === dep.nodeId && weight.name === resolver.weightBy)?.current
            : undefined,
        }));
      const envelope = evaluateRollup(resolver, children);
      await this.commitValue(propertyId, envelope, "rollup");
    } else if (isExprResolverConfig(property.resolver)) {
      if (this.sampleGate.shouldDefer(propertyId, property.sampleRateMs)) return;
      const deps = this.kernel.getDependencies(propertyId).map((id) => ({
        id,
        current: this.kernel.getCurrent(id) ?? staleEnvelope(),
      }));
      const envelope = evaluateExpr(property.resolver.expression, deps, {
        logger: this.options.logger,
      });
      this.sampleGate.recordEvaluated(propertyId);
      await this.commitValue(propertyId, envelope, "expr");
    }
  }

  async start(): Promise<void> {
    await this.kernel.load();

    const rollupEdges = await buildRollupEdges(this.options.prisma, this.kernel, this.options.logger);
    this.kernel.applyRollupEdges(rollupEdges);

    await this.hookManager.start();

    // Windows rehydrate before input subscriptions open, so no live sample can
    // arrive ahead of the resolver's source index.
    await this.windowResolver.start(this.kernel.listProperties(), (id) => this.kernel.getProperty(id));

    await this.tagResolver.start(this.kernel.listProperties());
    this.metricResolver.start(this.buildMetricSubscriptions());
    await this.entityResolver.start(this.kernel.listProperties());
    await this.definitionConsumer.start();
    await this.entityEventConsumer.start();
    this.lastDefinitionReconcileAt = new Date();
    this.definitionReconcileTimer = setInterval(() => {
      void this.reconcileDefinitionChanges().catch((err) => {
        this.options.logger.error({ err }, "livestore graph definition reconcile failed");
      });
    }, 30_000);
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
    this.definitionConsumer.stop();
    this.entityEventConsumer.stop();
    if (this.definitionFlushTimer) clearTimeout(this.definitionFlushTimer);
    if (this.definitionReconcileTimer) clearInterval(this.definitionReconcileTimer);
    this.definitionFlushTimer = null;
    this.definitionReconcileTimer = null;
    // Settle enqueueDefinitionChange promises the cleared flush timer would
    // have flushed — a hung waiter leaves its JetStream message un-nak'd.
    const waiters = this.definitionWaiters;
    this.definitionWaiters = [];
    this.pendingDefinitionEvents.clear();
    if (waiters.length > 0) {
      const err = new Error("livestore runtime stopping");
      for (const waiter of waiters) waiter.reject(err);
    }
    // Let any in-flight definition apply finish before tearing down resolvers.
    await this.definitionApplyChain.catch(() => {});
    await this.windowResolver.stop(); // drains emit chains + flushes agg state to KV
    this.sampleGate.stop();
    this.scheduler.stop();
  }

  enqueueDefinitionChange(event: GraphDefinitionEvent): Promise<void> {
    return new Promise((resolve, reject) => {
      this.pendingDefinitionEvents.set(`${event.entity}:${event.entityId}`, event);
      this.definitionWaiters.push({ resolve, reject });
      if (this.definitionFlushTimer) return;
      this.definitionFlushTimer = setTimeout(() => this.flushDefinitionChanges(), 100);
    });
  }

  private flushDefinitionChanges(): void {
    this.definitionFlushTimer = null;
    const events = [...this.pendingDefinitionEvents.values()];
    const waiters = this.definitionWaiters;
    this.pendingDefinitionEvents.clear();
    this.definitionWaiters = [];

    if (events.length === 0) {
      for (const waiter of waiters) waiter.resolve();
      return;
    }

    const run = () => this.applyDefinitionChanges(events);
    this.definitionApplyChain = this.definitionApplyChain.then(run, run);
    for (const waiter of waiters) this.definitionApplyChain.then(waiter.resolve, waiter.reject);
  }

  private async reconcileDefinitionChanges(): Promise<void> {
    const since = this.lastDefinitionReconcileAt;
    const next = new Date();
    const [nodes, properties, hooks] = await Promise.all([
      this.options.prisma.graphNode.findMany({
        where: { updatedAt: { gt: since } },
        select: { id: true, siteId: true },
      }),
      this.options.prisma.graphProperty.findMany({
        where: { updatedAt: { gt: since } },
        select: { id: true, nodeId: true, node: { select: { siteId: true } } },
      }),
      this.options.prisma.graphHook.findMany({
        where: { updatedAt: { gt: since } },
        select: { id: true, siteId: true },
      }),
    ]);

    const emittedAt = next.toISOString();
    const events: GraphDefinitionEvent[] = [
      ...nodes.map((node) => ({
        id: `reconcile:node:${node.id}:${emittedAt}`,
        entity: "node" as const,
        action: "updated" as const,
        entityId: node.id,
        siteId: node.siteId,
        emittedAt,
      })),
      ...properties.map((property) => ({
        id: `reconcile:property:${property.id}:${emittedAt}`,
        entity: "property" as const,
        action: "updated" as const,
        entityId: property.id,
        nodeId: property.nodeId,
        siteId: property.node.siteId,
        emittedAt,
      })),
      ...hooks.map((hook) => ({
        id: `reconcile:hook:${hook.id}:${emittedAt}`,
        entity: "hook" as const,
        action: "updated" as const,
        entityId: hook.id,
        siteId: hook.siteId,
        emittedAt,
      })),
    ];

    if (events.length > 0) await this.applyDefinitionChanges(events);
    this.lastDefinitionReconcileAt = next;
  }

  private async applyDefinitionChanges(events: GraphDefinitionEvent[]): Promise<void> {
    const dirty = new Set<string>();
    const touched: Array<{ previous: PropertyRuntime | null; current: PropertyRuntime }> = [];
    const removed: PropertyRuntime[] = [];
    let graphChanged = false;
    let hookEvents = 0;

    for (const event of events) {
      if (event.entity === "hook") {
        hookEvents += 1;
        if (event.action === "deleted") this.hookManager.removeHook(event.entityId);
        else await this.hookManager.loadHookDefinition(event.entityId);
        continue;
      }

      graphChanged = true;

      if (event.entity === "node") {
        const definition = event.action === "deleted" ? null : await this.kernel.loadNodeDefinition(event.entityId);
        const result = definition
          ? this.kernel.applyNodeDefinition(definition)
          : this.kernel.removeNode(event.entityId);
        touched.push(...result.upsertedProperties);
        removed.push(...result.removedProperties);
        continue;
      }

      const definition = event.action === "deleted" ? null : await this.kernel.loadPropertyDefinition(event.entityId);
      const result = definition
        ? this.kernel.applyPropertyDefinition(definition)
        : this.kernel.removeProperty(event.entityId);
      touched.push(...result.upsertedProperties);
      removed.push(...result.removedProperties);
    }

    if (!graphChanged) {
      this.options.logger.info({ events: events.length, hooks: hookEvents }, "livestore graph definitions patched");
      return;
    }

    for (const property of removed) await this.unconfigureProperty(property);
    for (const change of touched) {
      await this.configureProperty(change.current);
      if (isExprResolverConfig(change.current.resolver) || isRollupResolverConfig(change.current.resolver)) {
        dirty.add(change.current.id);
      }
    }

    const rollupEdges = await buildRollupEdges(this.options.prisma, this.kernel, this.options.logger);
    this.kernel.applyRollupEdges(rollupEdges);
    for (const property of this.kernel.listProperties()) {
      if (isRollupResolverConfig(property.resolver)) dirty.add(property.id);
    }
    if (dirty.size > 0) this.scheduler.markDirtyMany(dirty);

    this.options.logger.info(
      { events: events.length, hooks: hookEvents, touched: touched.length, removed: removed.length, dirty: dirty.size },
      "livestore graph definitions patched",
    );
  }

  private async configureProperty(property: PropertyRuntime): Promise<void> {
    this.tagResolver.upsertProperty(property);
    const metricSub = this.metricSubscriptionForProperty(property);
    if (metricSub) this.metricResolver.upsertSubscription(metricSub);
    else this.metricResolver.removeProperty(property.id);
    await this.windowResolver.upsertProperty(property, (id) => this.kernel.getProperty(id));
    await this.entityResolver.upsertProperty(property);
  }

  private async unconfigureProperty(property: PropertyRuntime): Promise<void> {
    this.tagResolver.removeProperty(property.id);
    this.metricResolver.removeProperty(property.id);
    this.entityResolver.removeProperty(property.id);
    this.sampleGate.forget(property.id);
    await this.windowResolver.removeProperty(property.id);
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
      try {
        await this.cvg.put(propertyId, envelope);
      } catch (err) {
        // A KV blip must not throw through resolver consume loops or the flush.
        // The in-memory value is already applied; the next changed commit (or
        // WS clients falling back to getCurrentOrStale) repairs KV drift.
        this.kvPutFailures += 1;
        this.options.logger.error({ err, propertyId, source }, "livestore CVG put failed — in-memory value retained");
      }
      const hookQueued = this.hookManager.onPropertyCommitted({ propertyId, previous, current: envelope });
      if (hookQueued) this.scheduler.scheduleTerminal();
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

  listNodesForSite(siteId: string) {
    return this.kernel.listNodesForSite(siteId);
  }

  getNode(nodeId: string) {
    return this.kernel.getNode(nodeId);
  }

  getPropertySiteId(propertyId: string) {
    return this.kernel.getPropertySiteId(propertyId);
  }

  counts() {
    return {
      ...this.kernel.counts(),
      ...this.windowResolver.counts(),
      tagSubscriptionCount: this.tagResolver.subscriptionCount(),
      metricSubscriptionCount: this.metricResolver.subscriptionCount(),
      ...this.hookManager.counts(),
    };
  }

  isReady(): boolean {
    return this.ready && (this.options.isNatsReady?.() ?? true);
  }

  // Health snapshot for the /metrics route. scheduler.flushStats() resets its
  // windowed flushMaxMs, so this is a sample-once-per-scrape call.
  healthStats() {
    return {
      ready: this.isReady(),
      engine: { ...this.scheduler.flushStats(), ...this.kernel.counts(), kvPutFailures: this.kvPutFailures },
      hooks: this.hookManager.hookStats(),
    };
  }
}
