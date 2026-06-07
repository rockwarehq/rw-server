import type { PrismaClient } from "@rw/db";
import type { KV, NatsConnection } from "nats";

import { CvgStore } from "./cvg-store.js";
import { GraphKernel } from "./kernel.js";
import { TagResolver } from "./tag-resolver.js";
import { envelopesEqual, staleEnvelope, type CommitSource, type LivestoreLogger, type ValueEnvelope } from "./types.js";

export interface GraphRuntimeOptions {
  prisma: PrismaClient;
  nc: NatsConnection;
  kv: KV;
  logger: LivestoreLogger;
}

export class GraphRuntime {
  private readonly cvg: CvgStore;
  private readonly kernel: GraphKernel;
  private readonly tagResolver: TagResolver;
  private ready = false;

  constructor(private readonly options: GraphRuntimeOptions) {
    this.cvg = new CvgStore(options.kv);
    this.kernel = new GraphKernel(options.prisma, this.cvg, options.logger);
    this.tagResolver = new TagResolver(options.nc, this, options.logger);
  }

  async start(): Promise<void> {
    await this.kernel.load();
    this.tagResolver.start(this.kernel.listProperties());
    this.ready = true;
  }

  stop(): void {
    this.ready = false;
    this.tagResolver.stop();
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
      await this.cvg.put(propertyId, envelope);
    }

    this.markDependentsDirtyPlaceholder(propertyId);
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

  getNode(nodeId: string) {
    return this.kernel.getNode(nodeId);
  }

  counts() {
    return {
      ...this.kernel.counts(),
      tagSubscriptionCount: this.tagResolver.subscriptionCount(),
    };
  }

  isReady(): boolean {
    return this.ready;
  }

  private markDependentsDirtyPlaceholder(propertyId: string): void {
    const dependentCount = this.kernel.getDependents(propertyId).length;
    if (dependentCount === 0) return;
    this.options.logger.info({ propertyId, dependentCount }, "livestore dirty propagation placeholder skipped");
  }
}
