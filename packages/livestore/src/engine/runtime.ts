import type { PrismaClient } from "@rw/db";
import type { JetStreamClient, JetStreamManager } from "@nats-io/jetstream";
import type { KV } from "@nats-io/kv";
import type { NatsConnection } from "@nats-io/nats-core";
import type { EntityEvent } from "@rw/runtime/entity-events";
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

// Reconcile re-scans this far behind its last cursor (clock skew + commit lag).
const RECONCILE_OVERLAP_MS = 60_000;

// Coalesce entity-event-driven rollup rebuilds (one DB query per rollup each).
const ROLLUP_REBUILD_DEBOUNCE_MS = 1_000;

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
  private reconcileInFlight = false;
  private lastDefinitionReconcileAt = new Date();
  // Entity kinds participating in any rollup (childKind / parent.model);
  // rebuilt lazily, invalidated on definition changes.
  private rollupEntityKinds: Set<string> | null = null;
  private rollupRebuildTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly pendingDefinitionEvents = new Map<string, GraphDefinitionEvent>();
  private definitionWaiters: Array<{ resolve: () => void; reject: (err: unknown) => void }> = [];
  private kvPutFailures = 0;
  // Latest-wins CVG write-behind: commits apply in memory synchronously and the
  // KV put is queued, so the flush loop (and resolver consume loops) never
  // serialize on NATS round-trips. Only the newest envelope per property matters.
  private readonly pendingPuts = new Map<string, ValueEnvelope>();
  private putDrainRunning = false;
  private putDrainDone: Promise<void> = Promise.resolve();

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
      this,
      options.logger,
    );
    this.scheduler = new Scheduler(
      (id) => this.kernel.getDependents(id),
      (id) => this.kernel.topoIndex(id),
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
      const depByNodeAndName = new Map(deps.map((dep) => [`${dep.nodeId}|${dep.name}`, dep]));
      const children = deps
        .filter((dep) => dep.name === resolver.childProperty)
        .map((dep) => ({
          current: dep.current,
          weight: resolver.weightBy
            ? depByNodeAndName.get(`${dep.nodeId}|${resolver.weightBy}`)?.current
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
    // Baseline the reconcile window and ensure streams/durables BEFORE the
    // initial DB load: a DeliverPolicy.New durable created after the load
    // would permanently miss definition/entity changes made while loading,
    // and a post-load baseline would hide them from the reconcile too.
    this.lastDefinitionReconcileAt = new Date();
    await this.definitionConsumer.ensure();
    await this.entityEventConsumer.ensure();

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
    this.definitionReconcileTimer = setInterval(() => {
      // One reconcile at a time: a slow cycle must not overlap the next tick.
      if (this.reconcileInFlight) return;
      this.reconcileInFlight = true;
      void this.reconcileDefinitionChanges()
        .catch((err) => {
          this.options.logger.error({ err }, "livestore graph definition reconcile failed");
        })
        .finally(() => {
          this.reconcileInFlight = false;
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
    if (this.rollupRebuildTimer) clearTimeout(this.rollupRebuildTimer);
    this.definitionFlushTimer = null;
    this.definitionReconcileTimer = null;
    this.rollupRebuildTimer = null;
    // Settle enqueueDefinitionChange promises the cleared flush timer would
    // have flushed — a hung waiter leaves its JetStream message un-nak'd.
    const waiters = this.definitionWaiters;
    this.definitionWaiters = [];
    this.pendingDefinitionEvents.clear();
    if (waiters.length > 0) {
      const err = new Error("livestore runtime stopping");
      for (const waiter of waiters) waiter.reject(err);
    }
    // Let any in-flight definition apply (event-driven or reconcile — both run
    // on this chain) finish before tearing down resolvers.
    await this.definitionApplyChain.catch(() => {});
    // Join the in-flight flush and block re-arming before draining producers:
    // a flush surviving past this point would commit into a torn-down runtime.
    await this.scheduler.stop();
    await this.windowResolver.stop(); // drains emit chains + flushes agg state to KV
    // Publish hook events queued by the final commits; the settle-flush that
    // would have flushed them can no longer run.
    await this.hookManager.flushPending((id) => this.kernel.getCurrent(id));
    this.sampleGate.stop();
    // Flush queued CVG writes before disconnecting NATS. Late commits (flush
    // join, window drain) can restart the drain, so loop until it stays empty.
    while (this.putDrainRunning || this.pendingPuts.size > 0) {
      await this.putDrainDone;
    }
  }

  // EntityChangeSink: resolve entity-bound properties, then rewire rollup
  // membership when the changed entity kind participates in any rollup — a
  // relation move (e.g. station → other workcenter) publishes only entity
  // events, and without a rebuild the parent rollup keeps aggregating its
  // old children until an unrelated definition change or restart.
  async handleEntityEvent(event: EntityEvent): Promise<void> {
    await this.entityResolver.handleEntityEvent(event);
    if (this.entityKindAffectsRollups(event.entityKey)) this.scheduleRollupRebuild();
  }

  private entityKindAffectsRollups(entityKey: string): boolean {
    if (!this.rollupEntityKinds) {
      const kinds = new Set<string>();
      for (const property of this.kernel.listProperties()) {
        const resolver = property.resolver;
        if (!isRollupResolverConfig(resolver)) continue;
        kinds.add(resolver.childKind);
        if (resolver.parent) kinds.add(resolver.parent.model);
      }
      this.rollupEntityKinds = kinds;
    }
    return this.rollupEntityKinds.has(entityKey);
  }

  private scheduleRollupRebuild(): void {
    if (this.rollupRebuildTimer) return;
    this.rollupRebuildTimer = setTimeout(() => {
      this.rollupRebuildTimer = null;
      // Serialize with definition applies: both diff-and-replace rollup edges.
      const run = async () => {
        const rollupEdges = await buildRollupEdges(this.options.prisma, this.kernel, this.options.logger);
        const changedTargets = this.kernel.applyRollupEdges(rollupEdges);
        if (changedTargets.length > 0) this.scheduler.markDirtyMany(changedTargets);
      };
      this.definitionApplyChain = this.definitionApplyChain.then(run, run);
      this.definitionApplyChain.catch((err) => {
        this.options.logger.error({ err }, "livestore rollup rebuild failed");
      });
    }, ROLLUP_REBUILD_DEBOUNCE_MS);
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
    // Overlap the scan window: updatedAt comes from the writer's clock, and a
    // transaction can commit after our query ran with an earlier updatedAt.
    // Applies are idempotent, so re-scanning the lap is safe; skipping a row
    // once loses it forever.
    const since = new Date(this.lastDefinitionReconcileAt.getTime() - RECONCILE_OVERLAP_MS);
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

    if (events.length > 0) {
      // Serialize through the same chain as event-driven applies: a direct
      // call here would interleave with a chained apply across its awaits and
      // corrupt kernel/dependency-graph state.
      const run = () => this.applyDefinitionChanges(events);
      this.definitionApplyChain = this.definitionApplyChain.then(run, run);
      await this.definitionApplyChain;
    }
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

    this.rollupEntityKinds = null; // rollup participants may have changed
    for (const property of removed) await this.unconfigureProperty(property);
    for (const change of touched) {
      await this.configureProperty(change.current);
      if (isExprResolverConfig(change.current.resolver) || isRollupResolverConfig(change.current.resolver)) {
        dirty.add(change.current.id);
      }
    }

    const rollupEdges = await buildRollupEdges(this.options.prisma, this.kernel, this.options.logger);
    // Only rollups whose incoming edge set changed need a recompute — marking
    // every rollup here thundering-herds the flush on each definition burst.
    for (const targetId of this.kernel.applyRollupEdges(rollupEdges)) dirty.add(targetId);
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
      this.enqueuePut(propertyId, envelope);
      const hookQueued = this.hookManager.onPropertyCommitted({ propertyId, previous, current: envelope });
      if (hookQueued) this.scheduler.scheduleTerminal();
    }

    // Per-commit logging runs at tag input rates — debug only. The flush-complete
    // info log and healthStats counters remain the operational signal.
    this.options.logger.debug?.(
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

  private enqueuePut(propertyId: string, envelope: ValueEnvelope): void {
    this.pendingPuts.set(propertyId, envelope);
    if (this.putDrainRunning) return;
    this.putDrainRunning = true;
    this.putDrainDone = this.drainPuts();
  }

  private async drainPuts(): Promise<void> {
    try {
      while (this.pendingPuts.size > 0) {
        // Take a batch off the iterator without materializing the whole map —
        // a copy per batch goes quadratic under backlog.
        const batch: Array<[string, ValueEnvelope]> = [];
        for (const entry of this.pendingPuts) {
          batch.push(entry);
          if (batch.length === 16) break;
        }
        await Promise.all(
          batch.map(async ([propertyId, envelope]) => {
            try {
              await this.cvg.put(propertyId, envelope);
            } catch (err) {
              // A KV blip must not throw through resolver consume loops or the
              // flush. The in-memory value is already applied; the next changed
              // commit repairs KV drift.
              this.kvPutFailures += 1;
              this.options.logger.error(
                { err, propertyId },
                "livestore CVG put failed — in-memory value retained",
              );
            } finally {
              // Remove only after the put settles, and only if no newer
              // envelope replaced it mid-flight: getCvgValue must keep seeing
              // the queued value until KV actually holds it.
              if (this.pendingPuts.get(propertyId) === envelope) this.pendingPuts.delete(propertyId);
            }
          }),
        );
      }
    } finally {
      this.putDrainRunning = false;
    }
  }

  async getCvgValue(propertyId: string): Promise<ValueEnvelope | null> {
    // A queued write-behind put is newer than whatever KV holds.
    const pending = this.pendingPuts.get(propertyId);
    if (pending) return pending;
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
      consumers: {
        definitionRestarts: this.definitionConsumer.stats().restartsTotal,
        entityEventRestarts: this.entityEventConsumer.stats().restartsTotal,
      },
    };
  }
}
