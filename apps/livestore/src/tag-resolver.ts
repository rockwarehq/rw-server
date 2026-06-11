import type { NatsConnection, Subscription } from "@nats-io/nats-core";

import { deriveTagSubject } from "@rw/runtime/graph-subjects";
import {
  isTagResolverConfig,
  parseValueEnvelope,
  type LivestoreLogger,
  type PropertyRuntime,
  type ValueEnvelope,
} from "./types.js";

export interface CommitSink {
  commitValue(propertyId: string, envelope: ValueEnvelope, source: "tag"): Promise<void>;
}

const decoder = new TextDecoder();

export class TagResolver {
  private readonly subscriptions = new Map<string, Subscription>();

  constructor(
    private readonly nc: NatsConnection,
    private readonly sink: CommitSink,
    private readonly logger: LivestoreLogger,
  ) {}

  start(properties: Iterable<PropertyRuntime>): void {
    const bySubject = new Map<string, Set<string>>();

    for (const property of properties) {
      if (!isTagResolverConfig(property.resolver)) continue;
      const subject = deriveTagSubject(property.resolver.deviceId, property.resolver.tagPath);
      const propertyIds = bySubject.get(subject) ?? new Set<string>();
      propertyIds.add(property.id);
      bySubject.set(subject, propertyIds);
    }

    for (const [subject, propertyIds] of bySubject) {
      const subscription = this.nc.subscribe(subject);
      this.subscriptions.set(subject, subscription);
      void this.consume(subscription, subject, propertyIds);
      this.logger.info({ subject, propertyCount: propertyIds.size }, "livestore tag subscription started");
    }
  }

  stop(): void {
    for (const subscription of this.subscriptions.values()) {
      subscription.unsubscribe();
    }
    this.subscriptions.clear();
  }

  subscriptionCount(): number {
    return this.subscriptions.size;
  }

  private async consume(subscription: Subscription, subject: string, propertyIds: Set<string>): Promise<void> {
    try {
      for await (const message of subscription) {
        const envelope = this.parseMessage(message.data);
        if (!envelope) {
          this.logger.warn({ subject }, "livestore tag message ignored because payload is not a ValueEnvelope");
          continue;
        }

        for (const propertyId of propertyIds) {
          try {
            await this.sink.commitValue(propertyId, envelope, "tag");
          } catch (err) {
            this.logger.error({ err, subject, propertyId }, "livestore tag commit failed");
          }
        }
      }
    } catch (err) {
      this.logger.error({ err, subject }, "livestore tag subscription failed");
    }
  }

  private parseMessage(data: Uint8Array): ValueEnvelope | null {
    try {
      return parseValueEnvelope(JSON.parse(decoder.decode(data)));
    } catch {
      return null;
    }
  }
}
