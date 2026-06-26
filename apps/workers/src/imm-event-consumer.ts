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
  LIVESTORE_EVENT_STREAM,
  LIVESTORE_EVENT_SUBJECT_FILTER,
  livestoreEventType,
  type LivestoreHookEvent,
} from "@rw/runtime/livestore-events";

const decoder = new TextDecoder();
const WEEK_NANOS = 7 * 24 * 60 * 60 * 1_000_000_000;
const TWO_MINUTES_NANOS = 2 * 60 * 1_000_000_000;
const ACK_WAIT_NANOS = 30 * 1_000_000_000;

// IMM-namespaced subset of the livestore event stream.
export const IMM_EVENT_SUBJECT_FILTER = "livestore.events.*.imm.>";
export const IMM_EVENT_DURABLE = "rw-workers-imm-events";

export type ImmEventHandler = (event: LivestoreHookEvent) => Promise<void>;
// keyed by livestoreEventType, e.g. "imm.cycle_completed"
export type ImmEventHandlers = Record<string, ImmEventHandler>;

// Durable JetStream consumer of IMM livestore events -> handler dispatch.
export class ImmEventConsumer {
  private messages: ConsumerMessages | null = null;

  constructor(
    private readonly js: JetStreamClient,
    private readonly jsm: JetStreamManager,
    private readonly handlers: ImmEventHandlers,
  ) {}

  async start(): Promise<void> {
    await this.ensureStream();
    await this.ensureConsumer();
    const consumer = await this.js.consumers.get(LIVESTORE_EVENT_STREAM, IMM_EVENT_DURABLE);
    this.messages = await consumer.consume({ max_messages: 50 });
    void this.consume(this.messages);
    console.log(`[imm-events] consumer started (stream=${LIVESTORE_EVENT_STREAM} durable=${IMM_EVENT_DURABLE})`);
  }

  stop(): void {
    this.messages?.stop();
    this.messages = null;
  }

  private async consume(messages: ConsumerMessages): Promise<void> {
    try {
      for await (const message of messages) {
        const event = parseLivestoreHookEvent(message.data);
        if (!event) {
          console.warn(`[imm-events] ignored invalid payload on ${message.subject}`);
          message.ack();
          continue;
        }

        const handler = this.handlers[livestoreEventType(event.namespace, event.name)];
        if (!handler) {
          message.ack(); // no handler — drop
          continue;
        }

        try {
          await handler(event);
          message.ack();
        } catch (err) {
          console.error(`[imm-events] handler failed for ${event.type} (${event.id}):`, err);
          message.nak(1_000);
        }
      }
    } catch (err) {
      console.error("[imm-events] consumer loop stopped:", err);
    }
  }

  private async ensureStream(): Promise<void> {
    try {
      const info = await this.jsm.streams.info(LIVESTORE_EVENT_STREAM);
      const subjects = new Set(info.config.subjects ?? []);
      if (!subjects.has(LIVESTORE_EVENT_SUBJECT_FILTER)) {
        await this.jsm.streams.update(LIVESTORE_EVENT_STREAM, {
          subjects: [...subjects, LIVESTORE_EVENT_SUBJECT_FILTER],
        });
      }
    } catch {
      await this.jsm.streams.add({
        name: LIVESTORE_EVENT_STREAM,
        subjects: [LIVESTORE_EVENT_SUBJECT_FILTER],
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
      await this.jsm.consumers.info(LIVESTORE_EVENT_STREAM, IMM_EVENT_DURABLE);
    } catch {
      await this.jsm.consumers.add(LIVESTORE_EVENT_STREAM, {
        durable_name: IMM_EVENT_DURABLE,
        ack_policy: AckPolicy.Explicit,
        deliver_policy: DeliverPolicy.New,
        replay_policy: ReplayPolicy.Instant,
        filter_subject: IMM_EVENT_SUBJECT_FILTER,
        ack_wait: ACK_WAIT_NANOS,
        max_ack_pending: 1_000,
      });
    }
  }
}

function parseLivestoreHookEvent(data: Uint8Array): LivestoreHookEvent | null {
  try {
    const raw: unknown = JSON.parse(decoder.decode(data));
    if (!raw || typeof raw !== "object") return null;
    const e = raw as Partial<LivestoreHookEvent>;
    if (typeof e.id !== "string" || typeof e.siteId !== "string") return null;
    if (typeof e.namespace !== "string" || typeof e.name !== "string" || typeof e.version !== "string") return null;
    if (typeof e.payload !== "object" || e.payload === null) return null;
    return raw as LivestoreHookEvent;
  } catch {
    return null;
  }
}
