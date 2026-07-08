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
  GRAPH_DEFINITION_DURABLE,
  GRAPH_DEFINITION_STREAM,
  GRAPH_DEFINITION_SUBJECT_FILTER,
  parseGraphDefinitionEvent,
  type GraphDefinitionEvent,
} from "../catalog/definitions.js";

import type { LivestoreLogger } from "../value/types.js";

const decoder = new TextDecoder();
const WEEK_NANOS = 7 * 24 * 60 * 60 * 1_000_000_000;
const TWO_MINUTES_NANOS = 2 * 60 * 1_000_000_000;
const ACK_WAIT_NANOS = 30 * 1_000_000_000;

export interface DefinitionChangeSink {
  enqueueDefinitionChange(event: GraphDefinitionEvent): Promise<void>;
}

export class GraphDefinitionConsumer {
  private messages: ConsumerMessages | null = null;

  constructor(
    private readonly js: JetStreamClient,
    private readonly jsm: JetStreamManager,
    private readonly sink: DefinitionChangeSink,
    private readonly logger: LivestoreLogger,
  ) {}

  async start(): Promise<void> {
    await this.ensureStream();
    await this.ensureConsumer();

    const consumer = await this.js.consumers.get(GRAPH_DEFINITION_STREAM, GRAPH_DEFINITION_DURABLE);
    this.messages = await consumer.consume({ max_messages: 50 });
    void this.consume(this.messages);
    this.logger.info(
      { stream: GRAPH_DEFINITION_STREAM, durable: GRAPH_DEFINITION_DURABLE },
      "livestore graph definition consumer started",
    );
  }

  stop(): void {
    this.messages?.stop();
    this.messages = null;
  }

  private async consume(messages: ConsumerMessages): Promise<void> {
    try {
      for await (const message of messages) {
        const event = this.parse(message.data);
        if (!event) {
          this.logger.warn({ subject: message.subject }, "livestore graph definition event ignored: invalid payload");
          message.ack();
          continue;
        }

        try {
          await this.sink.enqueueDefinitionChange(event);
          message.ack();
        } catch (err) {
          this.logger.error({ err, event }, "livestore graph definition event failed");
          message.nak(1_000);
        }
      }
    } catch (err) {
      this.logger.error({ err }, "livestore graph definition consumer stopped");
    }
  }

  private parse(data: Uint8Array): GraphDefinitionEvent | null {
    try {
      return parseGraphDefinitionEvent(JSON.parse(decoder.decode(data)));
    } catch {
      return null;
    }
  }

  private async ensureStream(): Promise<void> {
    try {
      const info = await this.jsm.streams.info(GRAPH_DEFINITION_STREAM);
      const subjects = new Set(info.config.subjects ?? []);
      if (!subjects.has(GRAPH_DEFINITION_SUBJECT_FILTER)) {
        await this.jsm.streams.update(GRAPH_DEFINITION_STREAM, {
          subjects: [...subjects, GRAPH_DEFINITION_SUBJECT_FILTER],
        });
      }
      return;
    } catch {
      await this.jsm.streams.add({
        name: GRAPH_DEFINITION_STREAM,
        subjects: [GRAPH_DEFINITION_SUBJECT_FILTER],
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
      await this.jsm.consumers.info(GRAPH_DEFINITION_STREAM, GRAPH_DEFINITION_DURABLE);
    } catch {
      await this.jsm.consumers.add(GRAPH_DEFINITION_STREAM, {
        durable_name: GRAPH_DEFINITION_DURABLE,
        ack_policy: AckPolicy.Explicit,
        deliver_policy: DeliverPolicy.New,
        replay_policy: ReplayPolicy.Instant,
        filter_subject: GRAPH_DEFINITION_SUBJECT_FILTER,
        ack_wait: ACK_WAIT_NANOS,
        max_ack_pending: 1_000,
      });
    }
  }
}
