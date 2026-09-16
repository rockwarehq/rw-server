// The consumer half of apps/api's startDomainEventPublisher: one durable
// JetStream subscription per domain. The stream is declared with the same
// config the publisher uses, so whichever process comes up first creates it
// identically. A handler that throws naks its message for redelivery.

import {
  AckPolicy,
  type ConsumerMessages,
  DeliverPolicy,
  DiscardPolicy,
  jetstream,
  jetstreamManager,
  RetentionPolicy,
  StorageType,
} from "@nats-io/jetstream";
import type { NatsConnection } from "@nats-io/nats-core";
import { connect } from "@nats-io/transport-node";

const ACK_WAIT_NANOS = 10 * 60 * 1_000_000_000;
const WEEK_NANOS = 7 * 24 * 60 * 60 * 1_000_000_000;
const TWO_MINUTES_NANOS = 2 * 60 * 1_000_000_000;
const NAK_DELAY_MS = 30_000;
const decoder = new TextDecoder();

export interface DomainEventConsumerConfig<T> {
  /** Log prefix and, as `rw-workers-<name>`, the durable and connection name. */
  name: string;
  stream: string;
  /** Subjects the stream owns. */
  subjects: string;
  /** What this consumer takes, when it is narrower than the stream. */
  filter?: string;
  parse: (value: unknown) => T | null;
  /** Throwing naks the message; returning acks it. */
  handle: (event: T) => Promise<void>;
}

export interface DomainEventConsumer {
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

export function createDomainEventConsumer<T>(config: DomainEventConsumerConfig<T>): DomainEventConsumer {
  const durable = `rw-workers-${config.name}`;
  const filter = config.filter ?? config.subjects;
  let nc: NatsConnection | null = null;
  let messages: ConsumerMessages | null = null;

  return {
    async start() {
      nc = await connect({
        servers: (process.env.NATS_URL ?? "nats://localhost:4222").split(",").map((s) => s.trim()),
        name: durable,
        maxReconnectAttempts: -1,
        waitOnFirstConnect: true,
      });
      const jsm = await jetstreamManager(nc);
      try {
        await jsm.streams.info(config.stream);
      } catch {
        await jsm.streams.add({
          name: config.stream,
          subjects: [config.subjects],
          retention: RetentionPolicy.Limits,
          storage: StorageType.File,
          discard: DiscardPolicy.Old,
          max_msgs: 100_000,
          max_age: WEEK_NANOS,
          duplicate_window: TWO_MINUTES_NANOS,
        });
      }
      try {
        await jsm.consumers.info(config.stream, durable);
      } catch {
        await jsm.consumers.add(config.stream, {
          durable_name: durable,
          ack_policy: AckPolicy.Explicit,
          deliver_policy: DeliverPolicy.New,
          filter_subject: filter,
          ack_wait: ACK_WAIT_NANOS,
          max_deliver: 3,
        });
      }

      const consumer = await jetstream(nc).consumers.get(config.stream, durable);
      messages = await consumer.consume({ max_messages: 1 });
      void (async () => {
        for await (const msg of messages ?? []) {
          const event = config.parse(JSON.parse(decoder.decode(msg.data)));
          if (!event) {
            console.warn(`[${config.name}] malformed event on ${msg.subject}; dropping`);
            msg.ack();
            continue;
          }
          try {
            await config.handle(event);
            msg.ack();
          } catch (err) {
            console.error(`[${config.name}] handling ${msg.subject} failed:`, err);
            msg.nak(NAK_DELAY_MS);
          }
        }
      })();
      console.log(`[${config.name}] consuming ${filter}`);
    },

    async stop() {
      messages?.stop();
      messages = null;
      if (nc && !nc.isClosed()) await nc.drain();
      nc = null;
    },
  };
}
