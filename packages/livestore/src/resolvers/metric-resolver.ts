import type { NatsConnection, Subscription } from "@nats-io/nats-core";

import { parseValueEnvelope, type LivestoreLogger, type ValueEnvelope } from "../types/index.js";

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
  private readonly bySubject = new Map<string, Set<string>>();
  private readonly propertySubjects = new Map<string, string>();

  constructor(
    private readonly nc: NatsConnection,
    private readonly sink: MetricCommitSink,
    private readonly logger: LivestoreLogger,
  ) {}

  start(subs: MetricSubscription[]): void {
    for (const sub of subs) {
      this.upsertSubscription(sub);
    }
    this.logger.info(
      { subjects: this.subscriptions.size, properties: subs.length },
      "livestore metric resolver started",
    );
  }

  upsertSubscription(sub: MetricSubscription): void {
    if (this.propertySubjects.get(sub.propertyId) === sub.subject) return;
    this.removeProperty(sub.propertyId);

    const propertyIds = this.bySubject.get(sub.subject) ?? new Set<string>();
    propertyIds.add(sub.propertyId);
    this.bySubject.set(sub.subject, propertyIds);
    this.propertySubjects.set(sub.propertyId, sub.subject);

    if (!this.subscriptions.has(sub.subject)) {
      const subscription = this.nc.subscribe(sub.subject);
      this.subscriptions.set(sub.subject, subscription);
      void this.consume(subscription, sub.subject, propertyIds);
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
    for (const subscription of this.subscriptions.values()) subscription.unsubscribe();
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
