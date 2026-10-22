import prisma, { type Prisma } from "@rw/db";
import { publishEntityEvent } from "./entity/events.js";

// Lets several service writes share one transaction (a setup changeset
// applies all its rows or none). Pass `tx` to run inside the caller's
// transaction, and `events` to collect entity events for the caller to
// publish once it commits, so a rolled-back write never announces itself.
// Without options a service runs its own transaction and publishes as usual.

export type EntityEventInput = Parameters<typeof publishEntityEvent>[0];

export interface WriteOptions {
  tx?: Prisma.TransactionClient;
  events?: EntityEventInput[];
}

/** The client to read through: the caller's transaction or the shared one. */
export function reader(options: WriteOptions | undefined): Prisma.TransactionClient {
  return options?.tx ?? prisma;
}

/** Run `fn` in the caller's transaction, or a new one. */
export function inTransaction<T>(
  options: WriteOptions | undefined,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return options?.tx ? fn(options.tx) : prisma.$transaction(fn);
}

/** Publish now, or hand to the caller to publish after commit. */
export function emitEntityEvent(options: WriteOptions | undefined, event: EntityEventInput): void {
  if (options?.events) options.events.push(event);
  else publishEntityEvent(event);
}
