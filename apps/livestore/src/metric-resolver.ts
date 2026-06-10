import type { NatsConnection, Subscription } from "@nats-io/nats-core";

import { parseValueEnvelope, type LivestoreLogger, type ValueEnvelope } from "./types.js";

// The MetricResolver listens for metric updates on NATS subjects, and commits them to the store via the provided sink.

export interface MetricCommitSink {
  commitValue(propertyId: string, envelope: ValueEnvelope, source: "metric"): Promise<void>;
}
export interface MetricSubscription {
  subject: string;
  propertyId: string;
}

const decoder = new TextDecoder();

export class MetricResolver {
  private readonly subscriptions = new Map<string, Subscription>();

  constructor(
    private readonly nc: NatsConnection,
    private readonly sink: MetricCommitSink,
    private readonly logger: LivestoreLogger,
  ) {}

  start(subs: MetricSubscription[]): void {
    const bySubject = new Map<string, Set<string>>();
    for (const sub of subs) {
      const set = bySubject.get(sub.subject) ?? new Set<string>();
      set.add(sub.propertyId);
      bySubject.set(sub.subject, set);
    }

    for (const [subject, propertyIds] of bySubject) {
      const subscription = this.nc.subscribe(subject);
      this.subscriptions.set(subject, subscription);
      void this.consume(subscription, subject, propertyIds);
    }
    this.logger.info({ subjects: this.subscriptions.size, properties: subs.length }, "livestore metric resolver started");
  }

  stop(): void {
    for (const subscription of this.subscriptions.values()) subscription.unsubscribe();
    this.subscriptions.clear();
  }

  subscriptionCount(): number {
    return this.subscriptions.size;
  }

  private async consume(subscription: Subscription, subject: string, propertyIds: Set<string>): Promise<void> {
    try {
      for await (const message of subscription) {
        const envelope = this.parse(message.data);
        if (!envelope) {
          this.logger.warn({ subject }, "livestore metric resolver ignored a non-envelope payload");
          continue;
        }
        for (const propertyId of propertyIds) {
          try {
            await this.sink.commitValue(propertyId, envelope, "metric");
          } catch (err) {
            this.logger.error({ err, subject, propertyId }, "livestore metric resolver commit failed");
          }
        }
      }
    } catch (err) {
      this.logger.error({ err, subject }, "livestore metric resolver subscription failed");
    }
  }

  // Accept a ValueEnvelope JSON, or a bare number for convenience.
  private parse(data: Uint8Array): ValueEnvelope | null {
    try {
      const raw = JSON.parse(decoder.decode(data));
      const envelope = parseValueEnvelope(raw);
      if (envelope) return envelope;
      if (typeof raw === "number") return { value: raw, quality: "good", timestamp: Date.now() };
      return null;
    } catch {
      return null;
    }
  }
}
