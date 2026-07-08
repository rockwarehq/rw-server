import { randomUUID } from "node:crypto";
import {
  DiscardPolicy,
  RetentionPolicy,
  StorageType,
  type JetStreamClient,
  type JetStreamManager,
} from "@nats-io/jetstream";
import type { PrismaClient } from "@rw/db";
import {
  LIVESTORE_EVENT_STREAM,
  LIVESTORE_EVENT_SUBJECT_FILTER,
  deriveLivestoreEventSubject,
  getLivestoreHookEventSchema,
  livestoreEventType,
  type LivestoreHookContextFieldType,
  type LivestoreHookEventContextMetadata,
  type LivestoreHookEvent,
} from "@rw/runtime/livestore-events";
import {
  graphHookConditionPropertyIds,
  parseGraphHookCondition,
  parseGraphHookEventContext,
  type GraphHookCondition,
  type GraphHookEventContext,
} from "@rw/runtime/livestore-hooks";

import { evaluateHookCondition } from "./hook-condition.js";
import { isRecord, type LivestoreLogger, type ValueEnvelope } from "./types.js";

const encoder = new TextEncoder();
const WEEK_NANOS = 7 * 24 * 60 * 60 * 1_000_000_000;
const TWO_MINUTES_NANOS = 2 * 60 * 1_000_000_000;

interface GraphHookRuntime {
  id: string;
  siteId: string;
  name: string;
  condition: GraphHookCondition;
  eventNamespace: string;
  eventName: string;
  eventVersion: string;
  eventPayload: Record<string, unknown>;
  eventContext: GraphHookEventContext;
}

interface HookRow {
  id: string;
  siteId: string;
  name: string;
  enabled: boolean;
  condition: unknown;
  eventNamespace: string;
  eventName: string;
  eventVersion: string;
  eventPayload: unknown;
  eventContext: unknown;
  isDeleted: boolean;
}

interface PendingHookEvent {
  hook: GraphHookRuntime;
  propertyId: string;
  previous: ValueEnvelope;
  current: ValueEnvelope;
}

export class HookManager {
  private readonly hooks = new Map<string, GraphHookRuntime>();
  private readonly byProperty = new Map<string, Set<string>>();
  private pending: PendingHookEvent[] = [];
  private matchedTotal = 0;
  private publishedTotal = 0;
  private publishFailuresTotal = 0;
  private lastPublishedAt: number | null = null;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly js: JetStreamClient,
    private readonly jsm: JetStreamManager,
    private readonly logger: LivestoreLogger,
  ) {}

  async start(): Promise<void> {
    await this.ensureStream();
    await this.load();
  }

  async load(): Promise<void> {
    this.hooks.clear();
    this.byProperty.clear();

    const hooks = await this.prisma.graphHook.findMany({
      where: { isDeleted: false, enabled: true },
      orderBy: { name: "asc" },
    });
    for (const hook of hooks) this.upsertRow(hook);

    this.logger.info({ hookCount: this.hooks.size }, "livestore hooks loaded");
  }

  async loadHookDefinition(hookId: string): Promise<void> {
    const hook = await this.prisma.graphHook.findUnique({ where: { id: hookId } });
    if (!hook || hook.isDeleted || !hook.enabled) {
      this.removeHook(hookId);
      return;
    }
    this.upsertRow(hook);
  }

  removeHook(hookId: string): void {
    const existing = this.hooks.get(hookId);
    if (!existing) return;
    this.hooks.delete(hookId);
    this.pending = this.pending.filter((event) => event.hook.id !== hookId);
    for (const propertyId of graphHookConditionPropertyIds(existing.condition)) {
      const hooks = this.byProperty.get(propertyId);
      if (!hooks) continue;
      hooks.delete(hookId);
      if (hooks.size === 0) this.byProperty.delete(propertyId);
    }
  }

  onPropertyCommitted(args: { propertyId: string; previous: ValueEnvelope; current: ValueEnvelope }): boolean {
    const hookIds = this.byProperty.get(args.propertyId);
    if (!hookIds || hookIds.size === 0) return false;

    let queued = false;
    for (const hookId of hookIds) {
      const hook = this.hooks.get(hookId);
      if (!hook) continue;
      if (!evaluateHookCondition(hook.condition, args.previous, args.current)) continue;
      this.pending.push({ hook, propertyId: args.propertyId, previous: args.previous, current: args.current });
      this.matchedTotal += 1;
      queued = true;
    }
    return queued;
  }

  async flushPending(getCurrent: (propertyId: string) => ValueEnvelope | null): Promise<void> {
    const pending = this.pending;
    this.pending = [];
    if (pending.length === 0) return;

    for (const event of pending) {
      try {
        await this.publishHookEvent(event, getCurrent);
        this.publishedTotal += 1;
        this.lastPublishedAt = Date.now();
      } catch (err) {
        this.publishFailuresTotal += 1;
        this.logger.error(
          { err, hookId: event.hook.id, propertyId: event.propertyId },
          "livestore hook event publish failed",
        );
      }
    }
  }

  counts(): { hookCount: number } {
    return { hookCount: this.hooks.size };
  }

  hookStats(): {
    matchedTotal: number;
    publishedTotal: number;
    publishFailuresTotal: number;
    lastPublishedAt: number | null;
    hookCount: number;
  } {
    return {
      matchedTotal: this.matchedTotal,
      publishedTotal: this.publishedTotal,
      publishFailuresTotal: this.publishFailuresTotal,
      lastPublishedAt: this.lastPublishedAt,
      hookCount: this.hooks.size,
    };
  }

  private upsertRow(row: HookRow): void {
    this.removeHook(row.id);
    if (row.isDeleted || !row.enabled) return;

    const condition = parseGraphHookCondition(row.condition);
    if (!condition) {
      this.logger.warn({ hookId: row.id }, "livestore hook ignored because condition is invalid");
      return;
    }
    const eventContext = parseGraphHookEventContext(row.eventContext);
    if (!eventContext) {
      this.logger.warn({ hookId: row.id }, "livestore hook ignored because eventContext is invalid");
      return;
    }

    const hook: GraphHookRuntime = {
      id: row.id,
      siteId: row.siteId,
      name: row.name,
      condition,
      eventNamespace: row.eventNamespace,
      eventName: row.eventName,
      eventVersion: row.eventVersion,
      eventPayload: isRecord(row.eventPayload) ? row.eventPayload : {},
      eventContext,
    };
    this.hooks.set(hook.id, hook);

    for (const propertyId of graphHookConditionPropertyIds(condition)) {
      const hooks = this.byProperty.get(propertyId) ?? new Set<string>();
      hooks.add(hook.id);
      this.byProperty.set(propertyId, hooks);
    }
  }

  private async publishHookEvent(
    pendingEvent: PendingHookEvent,
    getCurrent: (propertyId: string) => ValueEnvelope | null,
  ): Promise<void> {
    const hook = pendingEvent.hook;
    const resolvedContext = this.resolveEventContext(hook, getCurrent);
    if (!resolvedContext) return;

    const event: LivestoreHookEvent = {
      id: randomUUID(),
      namespace: hook.eventNamespace,
      name: hook.eventName,
      type: livestoreEventType(hook.eventNamespace, hook.eventName),
      version: hook.eventVersion,
      siteId: hook.siteId,
      hookId: hook.id,
      hookName: hook.name,
      propertyId: pendingEvent.propertyId,
      emittedAt: new Date().toISOString(),
      previous: pendingEvent.previous,
      current: pendingEvent.current,
      payload: { ...hook.eventPayload, ...resolvedContext.payload },
      context: resolvedContext.context,
    };
    const subject = deriveLivestoreEventSubject(hook.siteId, hook.eventNamespace, hook.eventName, hook.eventVersion);
    await this.js.publish(subject, encoder.encode(JSON.stringify(event)), { msgID: event.id });
    this.logger.info(
      { hookId: hook.id, propertyId: event.propertyId, eventNamespace: hook.eventNamespace, eventName: hook.eventName },
      "livestore hook event published",
    );
  }

  private resolveEventContext(
    hook: GraphHookRuntime,
    getCurrent: (propertyId: string) => ValueEnvelope | null,
  ): { payload: Record<string, unknown>; context: Record<string, LivestoreHookEventContextMetadata> } | null {
    const schema = getLivestoreHookEventSchema(hook.eventNamespace, hook.eventName, hook.eventVersion);
    if (!schema) {
      this.logger.warn(
        {
          hookId: hook.id,
          eventNamespace: hook.eventNamespace,
          eventName: hook.eventName,
          eventVersion: hook.eventVersion,
        },
        "livestore hook event skipped because event schema is unknown",
      );
      return null;
    }

    const payload: Record<string, unknown> = {};
    const context: Record<string, LivestoreHookEventContextMetadata> = {};

    for (const [field, fieldSchema] of Object.entries(schema.contextFields)) {
      const binding = hook.eventContext[field];
      if (!binding) {
        if (fieldSchema.required) {
          this.logger.warn(
            { hookId: hook.id, field },
            "livestore hook event skipped because required context is unbound",
          );
          return null;
        }
        continue;
      }

      const propertyId = binding.source.propertyId;
      const envelope = getCurrent(propertyId);
      if (!envelope || envelope.value == null || envelope.quality !== "good") {
        if (fieldSchema.required) {
          this.logger.warn(
            { hookId: hook.id, field, propertyId },
            "livestore hook event skipped because required context is not good",
          );
          return null;
        }
        continue;
      }

      if (!valueMatchesFieldType(envelope.value, fieldSchema.type)) {
        if (fieldSchema.required) {
          this.logger.warn(
            { hookId: hook.id, field, propertyId },
            "livestore hook event skipped because required context has wrong type",
          );
          return null;
        }
        continue;
      }

      payload[field] = envelope.value;
      context[field] = {
        propertyId,
        quality: envelope.quality,
        timestamp: envelope.timestamp,
      };
    }

    return { payload, context };
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
      return;
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
}

function valueMatchesFieldType(value: unknown, type: LivestoreHookContextFieldType): boolean {
  if (type === "string") return typeof value === "string";
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "boolean") return typeof value === "boolean";
  return typeof value === "object" && value !== null;
}
