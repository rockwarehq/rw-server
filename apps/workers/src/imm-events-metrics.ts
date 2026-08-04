// Prom metrics for the imm-events worker, served by main.ts at /metrics.

import client from "prom-client";

export const immEventsProcessed = new client.Counter({
  name: "imm_events_processed_total",
  help: "Events handled by the imm-events consumer, by outcome",
  labelNames: ["result"], // ok | deduped | invalid | failed
});

export const immEventsCompleteMs = new client.Histogram({
  name: "imm_events_complete_ms",
  help: "Handler duration per event (ms)",
  buckets: [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
});

export const immEventsInflight = new client.Gauge({
  name: "imm_events_inflight",
  help: "Events delivered to this process but not yet acked",
});

export const immEventsLanes = new client.Gauge({
  name: "imm_events_lanes",
  help: "Station lanes with queued or running work",
});

export const immEventsConsumerRestarts = new client.Counter({
  name: "imm_events_consumer_restarts_total",
  help: "Times the JetStream consume loop was reopened after dying",
});

// Sustained num_pending growth means the consumer is falling behind and the
// stream cap will eventually discard events — this is the loss early-warning.
export const immEventsNumPending = new client.Gauge({
  name: "imm_events_num_pending",
  help: "JetStream messages not yet delivered to the durable (consumer lag)",
});

export const immEventsNumAckPending = new client.Gauge({
  name: "imm_events_num_ack_pending",
  help: "JetStream messages delivered but unacked",
});

export const immEventsNumRedelivered = new client.Gauge({
  name: "imm_events_num_redelivered",
  help: "JetStream messages redelivered at least once",
});
