// Processor worker — MQTT ingest pipeline.
//
// The full rw-processor source is copied into ./_ported/ as a starting point.
// Integration TODOs before the processor mode is production-ready:
//
//   1. _ported/main.ts uses `.ts` extensions in imports and installs its own
//      SIGTERM/SIGINT handlers. Refactor to:
//        - export `startListener()` that resolves after setup is complete
//        - export `stopListener()` that cleanly shuts down the dispatcher,
//          MQTT client, metrics server, and pg pool
//      so the host runtime's lifecycle in apps/workers/src/main.ts owns
//      signal handling.
//
//   2. _ported/processors/db-events-processor.ts and station-events-processor.ts
//      use raw `pg` queries. Migrate to `@rw/db`'s typed Prisma client (the
//      "incidental cleanup" item in the plan).
//
//   3. _ported/station-events/rpc-client.ts calls back into rw-server's RPC
//      over the network. Confirm that still works once apps/api is the new
//      target.
//
//   4. Re-enable build of _ported/ by removing the tsconfig "exclude" entry
//      once imports are fixed up to NodeNext-compatible `.js` extensions.
//
// Until the integration is done, this index.ts is a stub.

export async function startProcessor(): Promise<void> {
  console.log("[processor] start — not yet integrated, see ./_ported and index.ts TODOs");
}

export async function stopProcessor(): Promise<void> {
  console.log("[processor] stop");
}
