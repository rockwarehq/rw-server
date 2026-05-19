// Processor-consumer worker — Phase 0 stub.
// Phase 2 (task #11) lifts station-event-execution BullMQ consumer
// (currently rw-server/src/cycle-worker.ts).

export async function startProcessorConsumer(): Promise<void> {
  console.log("[processor-consumer] start (Phase 0 stub)");
}

export async function stopProcessorConsumer(): Promise<void> {
  console.log("[processor-consumer] stop");
}
