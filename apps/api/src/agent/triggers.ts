import { createHash } from "node:crypto";
import type { DailySchedule } from "@rw/automations";
import prisma from "@rw/db";
import type { LivestoreHookEvent } from "@rw/livestore/catalog/events";

import { moduleLogger } from "../logger.js";
import { resolveAgent } from "./agents.js";
import { enqueueRun } from "./queue.js";
import { admitInput, createSession } from "./sessions.js";

// Agent triggers: start a run of an agent when a LiveStore hook fires or a
// daily schedule comes due. Each firing gets its own session, deduped by the
// event (or the scheduled time), and the run is queued like any other.

const log = moduleLogger("agent-triggers");

export type TriggerRow = NonNullable<Awaited<ReturnType<typeof prisma.agentTrigger.findFirst>>>;

/** A trigger's prompt: text with {{path}} placeholders filled from the event. */
export interface TriggerPrompt {
  text: string;
}

export function parsePrompt(value: unknown): TriggerPrompt {
  if (typeof value === "string") return { text: value };
  if (value && typeof value === "object" && typeof (value as { text?: unknown }).text === "string") {
    return { text: (value as { text: string }).text };
  }
  return { text: "" };
}

function lookup(source: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((value, key) => {
    if (value && typeof value === "object") return (value as Record<string, unknown>)[key];
    return undefined;
  }, source);
}

export function renderPrompt(template: string, source: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path: string) => {
    const value = lookup(source, path);
    if (value === undefined || value === null) return "";
    return typeof value === "string" ? value : JSON.stringify(value);
  });
}

/** A stable UUID from parts, so a redelivered event admits the same input. */
export function stableUuid(...parts: string[]): string {
  const hex = createHash("sha256").update(parts.join(":")).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

const HOUR_MS = 60 * 60 * 1000;

/** Cooldown and hourly cap: a chattering hook must not start a flood of runs. */
async function allowedToFire(trigger: TriggerRow, now: Date): Promise<boolean> {
  if (
    trigger.cooldownMs > 0 &&
    trigger.lastFiredAt &&
    now.getTime() - trigger.lastFiredAt.getTime() < trigger.cooldownMs
  ) {
    return false;
  }
  if (trigger.maxRunsPerHour > 0) {
    const recent = await prisma.agentSession.count({
      where: {
        siteId: trigger.siteId,
        triggerRef: { startsWith: `trigger:${trigger.id}:` },
        createdAt: { gt: new Date(now.getTime() - HOUR_MS) },
      },
    });
    if (recent >= trigger.maxRunsPerHour) return false;
  }
  return true;
}

export interface Firing {
  /** Unique per firing: the hook event id, or the scheduled time. */
  key: string;
  title: string;
  trigger: "HOOK_EVENT" | "SCHEDULE";
  /** What the agent is told about the event, as JSON. */
  event: Record<string, unknown>;
}

/** Start a run for one firing of a trigger. Returns the session id, or null when skipped. */
export async function fire(trigger: TriggerRow, firing: Firing, now = new Date()): Promise<string | null> {
  const agent = await resolveAgent(trigger.siteId, trigger.agentKey);
  if (!agent?.enabled) {
    log.warn({ triggerId: trigger.id, agentKey: trigger.agentKey }, "trigger's agent is missing or disabled");
    return null;
  }
  const actorUserId = agent.runAsUserId ?? trigger.createdById;
  if (!actorUserId) {
    log.warn({ triggerId: trigger.id }, "trigger has nobody to run as");
    return null;
  }
  const triggerRef = `trigger:${trigger.id}:${firing.key}`;
  const existing = await prisma.agentSession.findUnique({
    where: { siteId_triggerRef: { siteId: trigger.siteId, triggerRef } },
    select: { id: true },
  });
  if (existing) return existing.id;
  if (!(await allowedToFire(trigger, now))) return null;

  const { session, created } = await createSession({
    siteId: trigger.siteId,
    agentKey: agent.key,
    agentVersion: agent.version,
    actorUserId,
    title: firing.title,
    trigger: firing.trigger,
    triggerRef,
  });
  if (created) {
    const prompt = renderPrompt(parsePrompt(trigger.prompt).text, firing.event);
    const text = `<trigger_event>\n${JSON.stringify(firing.event, null, 2)}\n</trigger_event>\n\n${prompt || "Investigate this event."}`;
    await admitInput(session.id, { id: stableUuid(triggerRef), text });
    await prisma.agentTrigger.update({ where: { id: trigger.id }, data: { lastFiredAt: now } });
  }
  await enqueueRun(session.id, `trigger:${firing.trigger.toLowerCase()}`);
  return session.id;
}

/** Hook-event triggers in the event's site that match its event and hook. */
export async function matchingHookTriggers(event: LivestoreHookEvent): Promise<TriggerRow[]> {
  return prisma.agentTrigger.findMany({
    where: {
      siteId: event.siteId,
      kind: "HOOK_EVENT",
      enabled: true,
      isDeleted: false,
      eventNamespace: event.namespace,
      eventName: event.name,
      eventVersion: event.version,
      OR: [{ hookId: null }, { hookId: event.hookId }],
    },
  });
}

export async function fireHookEvent(event: LivestoreHookEvent): Promise<string[]> {
  const sessions: string[] = [];
  for (const trigger of await matchingHookTriggers(event)) {
    const sessionId = await fire(trigger, {
      key: event.id,
      title: `${trigger.name}: ${event.hookName}`,
      trigger: "HOOK_EVENT",
      event: {
        hook: event.hookName,
        event: `${event.namespace}.${event.name} v${event.version}`,
        propertyId: event.propertyId,
        previous: event.previous,
        current: event.current,
        emittedAt: event.emittedAt,
        payload: event.payload,
        context: event.context,
      },
    }).catch((err: unknown) => {
      log.error({ err, triggerId: trigger.id, eventId: event.id }, "trigger failed to fire");
      return null;
    });
    if (sessionId) sessions.push(sessionId);
  }
  return sessions;
}

export function parseSchedule(value: unknown): DailySchedule | null {
  if (!value || typeof value !== "object") return null;
  const { time, days } = value as { time?: unknown; days?: unknown };
  if (typeof time !== "string" || !/^\d{2}:\d{2}$/.test(time)) return null;
  if (!Array.isArray(days) || days.some((day) => typeof day !== "number")) return null;
  return { time, days: days as number[] } as DailySchedule;
}
