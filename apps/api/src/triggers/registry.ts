import { ActionRegistry, sendAlertHandler } from "./actions.js";
import { type ContextBuilder, statelessContextBuilder } from "./context.js";
import type { EventType } from "./types.js";

/**
 * Composition root — the ONE place to extend the framework.
 *
 * Map each event type to the ContextBuilder that turns it into facts, and register action
 * handlers. To add a real business action (sendEmail, createForm) or a new event type, edit here
 * + the catalog schemas; the engine, ingestion, and validation stay untouched.
 */

export function buildContextBuilders(): {
  contextBuilders: Map<EventType, ContextBuilder>;
  defaultContextBuilder: ContextBuilder;
} {
  const contextBuilders = new Map<EventType, ContextBuilder>();
  contextBuilders.set("job.changed", statelessContextBuilder);
  // Later: contextBuilders.set("point.reading", snapshotContextBuilder);
  return { contextBuilders, defaultContextBuilder: statelessContextBuilder };
}

export function buildActionRegistry(): ActionRegistry {
  return new ActionRegistry().register(sendAlertHandler);
  // Later: .register(createFormHandler).register(sendEmailHandler);
}
