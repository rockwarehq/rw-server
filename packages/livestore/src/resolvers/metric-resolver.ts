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
  private readonly restartTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly restartAttempts = new Map<string, number>();
  private stopped = false;
  private restartsTotal = 0;

  constructor(
    private readonly nc: NatsConnection,
    private readonly sink: MetricCommitSink,
    private readonly logger: LivestoreLogger,
  ) {}

  start(subs: MetricSubscription[]): void {
    this.stopped = false;
    for (const sub of subs) {
      this.upsertSubscription(sub);
    }
    this.logger.info(
      { subjects: this.subscriptions.size, properties: subs.length },
      "livestore metric resolver started",
    );
  }

  stats(): { restartsTotal: number } {
    return { restartsTotal: this.restartsTotal };
  }

  upsertSubscription(sub: MetricSubscription): void {
    if (this.propertySubjects.get(sub.propertyId) === sub.subject) return;
    this.removeProperty(sub.propertyId);

    const propertyIds = this.bySubject.get(sub.subject) ?? new Set<string>();
    propertyIds.add(sub.propertyId);
    this.bySubject.set(sub.subject, propertyIds);
    this.propertySubjects.set(sub.propertyId, sub.subject);

    if (!this.subscriptions.has(sub.subject)) {
      this.openSubject(sub.subject);
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
    this.closeSubjectTimers(subject);
    this.subscriptions.get(subject)?.unsubscribe();
    this.subscriptions.delete(subject);
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.restartTimers.values()) clearTimeout(timer);
    this.restartTimers.clear();
    this.restartAttempts.clear();
    for (const subscription of this.subscriptions.values()) subscription.unsubscribe();
    this.subscriptions.clear();
    this.bySubject.clear();
    this.propertySubjects.clear();
  }

  subscriptionCount(): number {
    return this.subscriptions.size;
  }

  private openSubject(subject: string): void {
    const subscription = this.nc.subscribe(subject);
    this.subscriptions.set(subject, subscription);
    void this.consume(subscription, subject);
  }

  private closeSubjectTimers(subject: string): void {
    const timer = this.restartTimers.get(subject);
    if (timer) clearTimeout(timer);
    this.restartTimers.delete(subject);
    this.restartAttempts.delete(subject);
  }

  private async consume(subscription: Subscription, subject: string): Promise<void> {
    try {
      for await (const message of subscription) {
        this.restartAttempts.delete(subject); // healthy delivery resets the backoff
        const envelope = this.parse(message.data);
        if (!envelope) {
          this.logger.warn({ subject }, "livestore metric resolver ignored a non-envelope payload");
          continue;
        }
        // Read the live binding each message: a property may have been added to
        // or removed from this subject since the subscription opened.
        const propertyIds = this.bySubject.get(subject);
        if (!propertyIds) continue;
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
    // Iterator ended without an unsubscribe: re-subscribe with backoff as long
    // as the subject still has bound properties (core subs are not durable, so
    // a dropped subscription otherwise freezes those metric properties).
    if (!this.stopped && this.subscriptions.get(subject) === subscription && (this.bySubject.get(subject)?.size ?? 0) > 0) {
      this.subscriptions.delete(subject);
      this.scheduleRestart(subject);
    }
  }

  private scheduleRestart(subject: string): void {
    if (this.stopped || this.restartTimers.has(subject)) return;
    const attempt = (this.restartAttempts.get(subject) ?? 0) + 1;
    this.restartAttempts.set(subject, attempt);
    this.restartsTotal += 1;
    const delayMs = Math.min(30_000, 1_000 * 2 ** Math.min(attempt - 1, 5));
    this.logger.warn({ subject, delayMs, attempt }, "livestore metric resolver re-subscribing");
    const timer = setTimeout(() => {
      this.restartTimers.delete(subject);
      // The subject may have been fully unsubscribed while we waited.
      if (this.stopped || (this.bySubject.get(subject)?.size ?? 0) === 0) return;
      try {
        this.openSubject(subject);
      } catch (err) {
        this.logger.error({ err, subject }, "livestore metric resolver re-subscribe failed");
        this.scheduleRestart(subject);
      }
    }, delayMs);
    this.restartTimers.set(subject, timer);
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
