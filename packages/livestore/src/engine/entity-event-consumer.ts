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
} from "@nats-io/jetstream";
import {
  ENTITY_EVENT_DURABLE,
  ENTITY_EVENT_STREAM,
  ENTITY_EVENT_SUBJECT_FILTER,
  parseEntityEvent,
  type EntityEvent,
} from "@rw/runtime/entity-events";

import type { LivestoreLogger } from "../types/index.js";

const decoder = new TextDecoder();
const WEEK_NANOS = 7 * 24 * 60 * 60 * 1_000_000_000;
const TWO_MINUTES_NANOS = 2 * 60 * 1_000_000_000;
const ACK_WAIT_NANOS = 30 * 1_000_000_000;

export interface EntityChangeSink {
  handleEntityEvent(event: EntityEvent): Promise<void>;
}

// Durable JetStream consumer of entity-change events (RW_ENTITY_EVENTS) -> sink.handleEntityEvent.
// Ensures the stream/consumer defensively (matching the publisher) in case livestore boots first.
export class EntityEventConsumer {
  private messages: ConsumerMessages | null = null;
  private stopped = false;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private restartAttempts = 0;
  private restartsTotal = 0;

  constructor(
    private readonly js: JetStreamClient,
    private readonly jsm: JetStreamManager,
    private readonly sink: EntityChangeSink,
    private readonly logger: LivestoreLogger,
  ) {}

  // Stream/durable creation is split out so the runtime can ensure them before
  // its initial DB load: a DeliverPolicy.New durable created after the load
  // would permanently miss events published while the load ran (first boot).
  async ensure(): Promise<void> {
    await this.ensureStream();
    await this.ensureConsumer();
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.ensure();
    await this.open();
    this.logger.info(
      { stream: ENTITY_EVENT_STREAM, durable: ENTITY_EVENT_DURABLE },
      "livestore entity event consumer started",
    );
  }

  stop(): void {
    this.stopped = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.messages?.stop();
    this.messages = null;
  }

  stats(): { restartsTotal: number } {
    return { restartsTotal: this.restartsTotal };
  }

  private async open(): Promise<void> {
    const consumer = await this.js.consumers.get(ENTITY_EVENT_STREAM, ENTITY_EVENT_DURABLE);
    this.messages = await consumer.consume({ max_messages: 50 });
    void this.consume(this.messages);
  }

  private async consume(messages: ConsumerMessages): Promise<void> {
    try {
      for await (const message of messages) {
        this.restartAttempts = 0; // healthy delivery resets the backoff
        const event = this.parse(message.data);
        if (!event) {
          this.logger.warn({ subject: message.subject }, "livestore entity event ignored: invalid payload");
          message.ack();
          continue;
        }

        try {
          await this.sink.handleEntityEvent(event);
          message.ack();
        } catch (err) {
          this.logger.error({ err, event }, "livestore entity event failed");
          message.nak(1_000);
        }
      }
    } catch (err) {
      this.logger.error({ err }, "livestore entity event consumer failed");
    }
    // The iterator only ends via stop() or an error; anything else means events
    // silently stop flowing — and entity events have no reconcile backstop —
    // so reopen with backoff instead of giving up.
    if (!this.stopped) this.scheduleRestart();
  }

  private scheduleRestart(): void {
    if (this.stopped || this.restartTimer) return;
    this.restartAttempts += 1;
    this.restartsTotal += 1;
    const delayMs = Math.min(30_000, 1_000 * 2 ** Math.min(this.restartAttempts - 1, 5));
    this.logger.warn({ delayMs, attempt: this.restartAttempts }, "livestore entity event consumer restarting");
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.open().catch((err) => {
        this.logger.error({ err }, "livestore entity event consumer reopen failed");
        this.scheduleRestart();
      });
    }, delayMs);
  }

  private parse(data: Uint8Array): EntityEvent | null {
    try {
      return parseEntityEvent(JSON.parse(decoder.decode(data)));
    } catch {
      return null;
    }
  }

  private async ensureStream(): Promise<void> {
    try {
      const info = await this.jsm.streams.info(ENTITY_EVENT_STREAM);
      const subjects = new Set(info.config.subjects ?? []);
      if (!subjects.has(ENTITY_EVENT_SUBJECT_FILTER)) {
        await this.jsm.streams.update(ENTITY_EVENT_STREAM, { subjects: [...subjects, ENTITY_EVENT_SUBJECT_FILTER] });
      }
      return;
    } catch {
      await this.jsm.streams.add({
        name: ENTITY_EVENT_STREAM,
        subjects: [ENTITY_EVENT_SUBJECT_FILTER],
        retention: RetentionPolicy.Limits,
        storage: StorageType.File,
        discard: DiscardPolicy.Old,
        max_msgs: 100_000,
        max_age: WEEK_NANOS,
        duplicate_window: TWO_MINUTES_NANOS,
      });
    }
  }

  private async ensureConsumer(): Promise<void> {
    try {
      await this.jsm.consumers.info(ENTITY_EVENT_STREAM, ENTITY_EVENT_DURABLE);
    } catch {
      await this.jsm.consumers.add(ENTITY_EVENT_STREAM, {
        durable_name: ENTITY_EVENT_DURABLE,
        ack_policy: AckPolicy.Explicit,
        deliver_policy: DeliverPolicy.New,
        replay_policy: ReplayPolicy.Instant,
        filter_subject: ENTITY_EVENT_SUBJECT_FILTER,
        ack_wait: ACK_WAIT_NANOS,
        max_ack_pending: 1_000,
      });
    }
  }
}
