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
  private readonly bySubject = new Map<string, Set<string>>();
  private readonly propertySubjects = new Map<string, string>();

  constructor(
    private readonly nc: NatsConnection,
    private readonly sink: CommitSink,
    private readonly logger: LivestoreLogger,
  ) {}

  start(properties: Iterable<PropertyRuntime>): void {
    for (const property of properties) {
      this.upsertProperty(property);
    }
  }

  upsertProperty(property: PropertyRuntime): void {
    if (!isTagResolverConfig(property.resolver)) {
      this.removeProperty(property.id);
      return;
    }

    const subject = deriveTagSubject(property.resolver.deviceId, property.resolver.tagPath);
    if (this.propertySubjects.get(property.id) === subject) return;

    this.removeProperty(property.id);
    const propertyIds = this.bySubject.get(subject) ?? new Set<string>();
    propertyIds.add(property.id);
    this.bySubject.set(subject, propertyIds);
    this.propertySubjects.set(property.id, subject);

    if (!this.subscriptions.has(subject)) {
      const subscription = this.nc.subscribe(subject);
      this.subscriptions.set(subject, subscription);
      void this.consume(subscription, subject, propertyIds);
      this.logger.info({ subject, propertyCount: propertyIds.size }, "livestore tag subscription started");
    }
  }

  removeProperty(propertyId: string): void {
    const subject = this.propertySubjects.get(propertyId);
    if (!subject) return;
    this.propertySubjects.delete(propertyId);

    const propertyIds = this.bySubject.get(subject);
    if (!propertyIds) return;
    propertyIds.delete(propertyId);
    if (propertyIds.size > 0) return;

    this.bySubject.delete(subject);
    this.subscriptions.get(subject)?.unsubscribe();
    this.subscriptions.delete(subject);
  }

  stop(): void {
    for (const subscription of this.subscriptions.values()) {
      subscription.unsubscribe();
    }
    this.subscriptions.clear();
    this.bySubject.clear();
    this.propertySubjects.clear();
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
