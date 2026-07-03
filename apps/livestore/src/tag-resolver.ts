import {
  AckPolicy,
  DeliverPolicy,
  DiscardPolicy,
  ReplayPolicy,
  RetentionPolicy,
  StorageType,
  type ConsumerMessages,
  type JetStreamClient,
  type JetStreamManager,
  type StreamSource,
} from "@nats-io/jetstream";

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

// Tags flow gateway -> edge JetStream -> (sourced) cloud RW_TAGS -> this durable
// consumer -> cvg. A single durable consumer over tags.> keeps livestore's
// position across restarts, so values published while livestore is down are
// drained on reconnect rather than dropped (which a core subscribe would do).
const TAGS_STREAM = "RW_TAGS";
const TAGS_DURABLE = "rw-livestore-tags";
const TAGS_SUBJECT_FILTER = "tags.>";

const HOUR_NANOS = 60 * 60 * 1_000_000_000;
const ACK_WAIT_NANOS = 30 * 1_000_000_000;
// RW_TAGS is high-throughput live telemetry, not a system of record: a durable
// consumer tracks livestore's position, so retention only bounds the replay/
// backfill window — not correctness. Keep it tight so the in-memory JetStream
// index (and the boot-time restore) stay small on a memory-constrained NATS node:
// ~1h of history plus a hard byte ceiling as a runaway backstop. Both overridable
// per-env (prod may want a longer window / higher cap).
const TAGS_MAX_AGE_NANOS = Number(process.env.NATS_TAGS_MAX_AGE_NANOS) || HOUR_NANOS;
const TAGS_MAX_BYTES = Number(process.env.NATS_TAGS_MAX_BYTES) || 128 * 1024 * 1024;

const decoder = new TextDecoder();

export class TagResolver {
  private readonly bySubject = new Map<string, Set<string>>();
  private readonly propertySubjects = new Map<string, string>();
  private messages: ConsumerMessages | null = null;

  constructor(
    private readonly js: JetStreamClient,
    private readonly jsm: JetStreamManager,
    private readonly sink: CommitSink,
    private readonly logger: LivestoreLogger,
  ) {}

  async start(properties: Iterable<PropertyRuntime>): Promise<void> {
    for (const property of properties) {
      this.upsertProperty(property);
    }

    await this.ensureStream();
    await this.ensureConsumer();

    const consumer = await this.js.consumers.get(TAGS_STREAM, TAGS_DURABLE);
    this.messages = await consumer.consume({ max_messages: 100 });
    void this.consume(this.messages);
    this.logger.info({ stream: TAGS_STREAM, durable: TAGS_DURABLE }, "livestore tag consumer started");
  }

  // Subject routing is now pure bookkeeping — the single consumer already
  // receives every tags.> message, so adding/removing a property only changes
  // which committed properties a subject fans out to. No NATS churn.
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
  }

  removeProperty(propertyId: string): void {
    const subject = this.propertySubjects.get(propertyId);
    if (!subject) return;
    this.propertySubjects.delete(propertyId);

    const propertyIds = this.bySubject.get(subject);
    if (!propertyIds) return;
    propertyIds.delete(propertyId);
    if (propertyIds.size === 0) this.bySubject.delete(subject);
  }

  stop(): void {
    this.messages?.stop();
    this.messages = null;
    this.bySubject.clear();
    this.propertySubjects.clear();
  }

  subscriptionCount(): number {
    return this.bySubject.size;
  }

  private async consume(messages: ConsumerMessages): Promise<void> {
    try {
      for await (const message of messages) {
        const envelope = this.parseMessage(message.data);
        if (!envelope) {
          this.logger.warn({ subject: message.subject }, "livestore tag message ignored: not a ValueEnvelope");
          message.ack();
          continue;
        }

        const propertyIds = this.bySubject.get(message.subject);
        if (!propertyIds || propertyIds.size === 0) {
          // No property is bound to this tag (yet). Live values are last-write-
          // wins, so there's nothing to replay later — ack and move on.
          message.ack();
          continue;
        }

        let failed = false;
        for (const propertyId of propertyIds) {
          try {
            await this.sink.commitValue(propertyId, envelope, "tag");
          } catch (err) {
            failed = true;
            this.logger.error({ err, subject: message.subject, propertyId }, "livestore tag commit failed");
          }
        }

        if (failed) message.nak(1_000);
        else message.ack();
      }
    } catch (err) {
      this.logger.error({ err }, "livestore tag consumer stopped");
    }
  }

  private parseMessage(data: Uint8Array): ValueEnvelope | null {
    try {
      return parseValueEnvelope(JSON.parse(decoder.decode(data)));
    } catch {
      return null;
    }
  }

  private async ensureStream(): Promise<void> {
    const existing = await this.streamInfoOrNull(TAGS_STREAM);
    if (existing) {
      // Reconcile retention on a pre-existing stream so a redeploy actually
      // applies tightened limits (and purges the backlog). A plain create()
      // no-ops when the stream exists, which would leave an old uncapped
      // RW_TAGS running unbounded.
      if (
        existing.config.max_age !== TAGS_MAX_AGE_NANOS ||
        existing.config.max_bytes !== TAGS_MAX_BYTES
      ) {
        await this.jsm.streams.update(TAGS_STREAM, {
          max_age: TAGS_MAX_AGE_NANOS,
          max_bytes: TAGS_MAX_BYTES,
        });
      }
      return;
    }

    // In production the gateway publishes into its local edge-domain stream
    // and the cloud RW_TAGS *sources* it across the leaf (durable store-and-
    // forward).
    const sourceDomain = process.env.NATS_TAGS_SOURCE_DOMAIN?.trim();
    const sourceStream = process.env.NATS_TAGS_SOURCE_STREAM?.trim() || "TAGS";

    const base = {
      name: TAGS_STREAM,
      retention: RetentionPolicy.Limits,
      storage: StorageType.File,
      discard: DiscardPolicy.Old,
      max_age: TAGS_MAX_AGE_NANOS,
      max_bytes: TAGS_MAX_BYTES,
    };

    if (sourceDomain) {
      const sources: StreamSource[] = [{ name: sourceStream, domain: sourceDomain }];
      await this.jsm.streams.add({ ...base, sources });
    } else {
      await this.jsm.streams.add({ ...base, subjects: [TAGS_SUBJECT_FILTER] });
    }
  }

  private async streamInfoOrNull(name: string) {
    try {
      return await this.jsm.streams.info(name);
    } catch {
      return null;
    }
  }

  private async ensureConsumer(): Promise<void> {
    try {
      await this.jsm.consumers.info(TAGS_STREAM, TAGS_DURABLE);
    } catch {
      await this.jsm.consumers.add(TAGS_STREAM, {
        durable_name: TAGS_DURABLE,
        ack_policy: AckPolicy.Explicit,
        // New on first creation only: don't replay the whole retained backlog
        // into cvg on first boot. Across restarts the durable resumes from its
        // last ack, so in-flight values during downtime are still delivered.
        deliver_policy: DeliverPolicy.New,
        replay_policy: ReplayPolicy.Instant,
        filter_subject: TAGS_SUBJECT_FILTER,
        ack_wait: ACK_WAIT_NANOS,
        max_ack_pending: 1_000,
      });
    }
  }
}
