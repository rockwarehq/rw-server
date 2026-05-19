// Lifted from rw-server/src/config.ts in Phase 0 task #9.
// Stub for now.

export interface BullMQTuning {
  stalledInterval: number;
  drainDelay: number;
  connectTimeout: number;
}

export const bullmqConfig: BullMQTuning = {
  stalledInterval: 30_000,
  drainDelay: 5_000,
  connectTimeout: 10_000,
};
