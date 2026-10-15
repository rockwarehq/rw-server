import { ORPCError, eventIterator } from "@orpc/server";
import prisma from "@rw/db";
import type { Prisma } from "@rw/db";
import { z } from "zod";

import { BUILT_IN_AGENTS, fromDefinition, isBuiltInKey, parseRules, resolveAgent } from "../agent/agents.js";
import { ApprovalError, listApprovals, reply as replyToApproval } from "../agent/approvals.js";
import { publish, subscribe as subscribeBus } from "../agent/bus.js";
import { rearmAgentTrigger } from "../agent/clock.js";
import { liveSubject, readEvents, type WireEvent, wakeSubject } from "../agent/events.js";
import { permissionRuleSchema } from "../agent/permission.js";
import { enqueueRun } from "../agent/queue.js";
import { interruptSubject } from "../agent/runner.js";
import { admitInput, createSession, sessionSelect } from "../agent/sessions.js";
import { parseSchedule } from "../agent/triggers.js";
import { agentConfig } from "../config.js";
import { agentsRequired, userRequired } from "./middleware.js";

// Agents. A prompt is stored and queued, not run inside the request; clients
// follow a session through subscribe(after = seq), which replays the durable
// log and then streams live, so a reload, a second window, or another
// device all see the same run. Definitions, triggers and approvals are site
// resources managed by plant admins.

type UserContext = Parameters<Parameters<typeof userRequired.handler>[0]>[0]["context"];

const siteInputSchema = z.object({ siteId: z.uuid() });
const sessionInputSchema = z.object({ siteId: z.uuid(), id: z.uuid() });
const agentKeySchema = z
  .string()
  .min(2)
  .max(48)
  .regex(/^[a-z][a-z0-9-]*$/, "lowercase letters, digits and dashes");

const contextItemSchema = z.object({
  kind: z.string().min(1).max(64),
  id: z.string().max(200).optional(),
  label: z.string().min(1).max(300),
  detail: z.string().max(20_000).optional(),
});

function userId(context: UserContext): string {
  return context.current.user.id;
}

async function isSiteAdmin(context: UserContext, siteId: string): Promise<boolean> {
  try {
    await context.access.require("ADMIN", { site: siteId });
    return true;
  } catch {
    return false;
  }
}

/** Chats are private to their user; trigger and subagent runs belong to the site. */
async function viewableSession(context: UserContext, siteId: string, id: string) {
  await context.access.require("VIEW", { site: siteId });
  const session = await prisma.agentSession.findFirst({ where: { id, siteId }, select: sessionSelect });
  if (!session) throw new ORPCError("NOT_FOUND", { message: "Session not found" });
  const own = session.actorUserId === userId(context);
  if (session.trigger === "CHAT" && !own) throw new ORPCError("NOT_FOUND", { message: "Session not found" });
  return session;
}

// Always answers, so clients can tell whether to show agents at all.
export const status = userRequired.handler(async () => ({
  available: agentConfig.available,
  enabled: agentConfig.enabled,
  model: agentConfig.enabled ? agentConfig.model : null,
}));

// ── Sessions ───────────────────────────────────────────────────────────────

const promptInputSchema = z.object({
  siteId: z.uuid(),
  sessionId: z.uuid().optional(),
  agentKey: z.string().min(1).optional(),
  /** Client-generated: a retried submission is a no-op. */
  inputId: z.uuid(),
  message: z.string().min(1).max(20_000),
  context: z.array(contextItemSchema).max(30).optional(),
});

export const prompt = agentsRequired.input(promptInputSchema).handler(async ({ input, context }) => {
  if (!agentConfig.enabled) throw new ORPCError("PRECONDITION_FAILED", { message: "Agents are not configured" });
  await context.access.require("VIEW", { site: input.siteId });

  let sessionId = input.sessionId;
  if (sessionId) {
    const session = await viewableSession(context, input.siteId, sessionId);
    if (session.trigger !== "CHAT" && !(await isSiteAdmin(context, input.siteId))) {
      throw new ORPCError("FORBIDDEN", { message: "Only plant admins can follow up on agent runs" });
    }
  } else {
    const agent = await resolveAgent(input.siteId, input.agentKey ?? "build");
    if (!agent?.enabled) throw new ORPCError("NOT_FOUND", { message: "Agent not found" });
    const { session } = await createSession({
      siteId: input.siteId,
      agentKey: agent.key,
      agentVersion: agent.version,
      actorUserId: userId(context),
      title: input.message.split("\n")[0] ?? "New chat",
      trigger: "CHAT",
    });
    sessionId = session.id;
  }

  await admitInput(sessionId, { id: input.inputId, text: input.message, context: input.context });
  await prisma.agentSession.updateMany({
    where: { id: sessionId, status: { in: ["IDLE", "FAILED"] } },
    data: { status: "QUEUED" },
  });
  await enqueueRun(sessionId, "prompt");
  return { sessionId, inputId: input.inputId };
});

type ConnectedEvent = {
  type: "connected";
  seq: null;
  at: string;
  lastSeq: number;
  status: string;
};
export type AgentStreamEvent = WireEvent | ConnectedEvent;

const subscribeInputSchema = z.object({
  siteId: z.uuid(),
  sessionId: z.uuid(),
  after: z.number().int().min(0).default(0),
});
const STREAM_QUEUE_LIMIT = 2000;

export const subscribe = agentsRequired
  .input(subscribeInputSchema)
  .output(eventIterator(z.custom<AgentStreamEvent>(() => true)))
  .handler(async function* ({ input, context, signal }) {
    await context.access.require("VIEW", { site: input.siteId });
    const session = await viewableSession(context, input.siteId, input.sessionId);

    // Listen before reading, so nothing committed in between is missed; the
    // seq cursor drops anything read twice.
    const queue: Array<{ kind: "wake" } | { kind: "live"; event: WireEvent }> = [];
    let notify: (() => void) | null = null;
    let overflow = false;
    const push = (item: (typeof queue)[number]) => {
      if (queue.length >= STREAM_QUEUE_LIMIT) overflow = true;
      else queue.push(item);
      notify?.();
    };
    const unsubscribeWake = await subscribeBus(wakeSubject(session.id), () => push({ kind: "wake" }));
    const unsubscribeLive = await subscribeBus(liveSubject(session.id), (data) => {
      try {
        push({ kind: "live", event: JSON.parse(data) as WireEvent });
      } catch {
        // ignore malformed
      }
    });
    const onAbort = () => notify?.();
    signal?.addEventListener("abort", onAbort);

    try {
      const fresh = await prisma.agentSession.findUniqueOrThrow({
        where: { id: session.id },
        select: { lastSeq: true, status: true },
      });
      yield {
        type: "connected",
        seq: null,
        at: new Date().toISOString(),
        lastSeq: fresh.lastSeq,
        status: fresh.status,
      };

      let cursor = input.after;
      const catchUp = async function* () {
        while (true) {
          const events = await readEvents(session.id, cursor);
          for (const event of events) {
            cursor = event.seq as number;
            yield event;
          }
          if (events.length < 500) return;
        }
      };
      yield* catchUp();

      while (!signal?.aborted) {
        if (overflow) return; // the client resubscribes from its cursor
        const item = queue.shift();
        if (!item) {
          await new Promise<void>((resolve) => {
            notify = resolve;
          });
          notify = null;
          continue;
        }
        if (item.kind === "wake") yield* catchUp();
        else yield item.event;
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
      unsubscribeWake();
      unsubscribeLive();
    }
  });

export const interrupt = agentsRequired
  .input(z.object({ siteId: z.uuid(), sessionId: z.uuid() }))
  .handler(async ({ input, context }) => {
    await context.access.require("VIEW", { site: input.siteId });
    const session = await viewableSession(context, input.siteId, input.sessionId);
    if (session.actorUserId !== userId(context) && !(await isSiteAdmin(context, input.siteId))) {
      throw new ORPCError("FORBIDDEN", { message: "Only the session's owner or a plant admin can stop it" });
    }
    await publish(interruptSubject(session.id), "");
    return { success: true };
  });

const sessionListInputSchema = z.object({
  siteId: z.uuid(),
  /** mine: your chats; runs: the site's trigger and subagent runs. */
  scope: z.enum(["mine", "runs"]).default("mine"),
  limit: z.number().int().min(1).max(200).default(50),
});

export const sessionList = agentsRequired.input(sessionListInputSchema).handler(async ({ input, context }) => {
  await context.access.require("VIEW", { site: input.siteId });
  return prisma.agentSession.findMany({
    where:
      input.scope === "mine"
        ? { siteId: input.siteId, trigger: "CHAT", actorUserId: userId(context) }
        : { siteId: input.siteId, trigger: { not: "CHAT" } },
    orderBy: { updatedAt: "desc" },
    take: input.limit,
    select: sessionSelect,
  });
});

export const sessionGet = agentsRequired.input(sessionInputSchema).handler(async ({ input, context }) => {
  await context.access.require("VIEW", { site: input.siteId });
  const session = await viewableSession(context, input.siteId, input.id);
  return { ...session, events: await readEvents(session.id, 0, 5000) };
});

export const sessionDelete = agentsRequired.input(sessionInputSchema).handler(async ({ input, context }) => {
  await context.access.require("VIEW", { site: input.siteId });
  const session = await viewableSession(context, input.siteId, input.id);
  if (session.actorUserId !== userId(context) && !(await isSiteAdmin(context, input.siteId))) {
    throw new ORPCError("FORBIDDEN", { message: "Only the session's owner or a plant admin can delete it" });
  }
  await prisma.agentSession.delete({ where: { id: session.id } });
  return { success: true };
});

/** A chat's owner renames it (chat history in Console). */
export const sessionRename = agentsRequired
  .input(sessionInputSchema.extend({ title: z.string().trim().min(1).max(120) }))
  .handler(async ({ input, context }) => {
    await context.access.require("VIEW", { site: input.siteId });
    const session = await viewableSession(context, input.siteId, input.id);
    if (session.trigger !== "CHAT" || session.actorUserId !== userId(context)) {
      throw new ORPCError("FORBIDDEN", { message: "Only a chat's owner can rename it" });
    }
    return prisma.agentSession.update({
      where: { id: session.id },
      data: { title: input.title },
      select: sessionSelect,
    });
  });

// ── Definitions ────────────────────────────────────────────────────────────

const definitionFields = {
  name: z.string().min(1).max(80),
  description: z.string().max(500).nullable().optional(),
  baseKey: z.enum(["build", "explore", "investigator"]),
  instructions: z.string().max(20_000).nullable().optional(),
  model: z.string().min(1).max(80).nullable().optional(),
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]).nullable().optional(),
  maxSteps: z.number().int().min(1).max(100).nullable().optional(),
  permissions: z.array(permissionRuleSchema).max(100).optional(),
  notificationGroupId: z.uuid().nullable().optional(),
  runAsUserId: z.uuid().nullable().optional(),
  enabled: z.boolean().optional(),
};

const definitionCreateSchema = z.object({ siteId: z.uuid(), key: agentKeySchema, ...definitionFields });
const definitionUpdateSchema = z.object({
  siteId: z.uuid(),
  key: agentKeySchema,
  ...Object.fromEntries(Object.entries(definitionFields).map(([k, v]) => [k, v.optional()])),
}) as unknown as z.ZodType<{ siteId: string; key: string } & Partial<z.infer<z.ZodObject<typeof definitionFields>>>>;

/** A run-as user must hold the access the agent will act with. */
async function checkRunAs(context: UserContext, siteId: string, runAsUserId: string | null | undefined) {
  if (!runAsUserId) return;
  if (runAsUserId !== userId(context)) {
    throw new ORPCError("FORBIDDEN", { message: "An agent can only run as the admin who sets it up" });
  }
  await context.access.require("ADMIN", { site: siteId });
}

// A custom agent as its editor sees it: the row's own overrides (instructions
// added to the base's, model/effort/steps blank when inherited), not the
// resolved agent the runner uses.
function describeAgent(row: Parameters<typeof fromDefinition>[0]) {
  const agent = fromDefinition(row);
  if (!agent) return null;
  const { rulesets: _rulesets, ...rest } = agent;
  return {
    ...rest,
    description: row.description,
    instructions: row.instructions,
    model: row.model,
    effort: row.effort as typeof agent.effort | null,
    maxSteps: row.maxSteps,
    permissions: parseRules(row.permissions),
  };
}

export const definitionList = agentsRequired.input(siteInputSchema).handler(async ({ input, context }) => {
  await context.access.require("VIEW", { site: input.siteId });
  const rows = await prisma.agentDefinition.findMany({
    where: { siteId: input.siteId, isDeleted: false },
    orderBy: { name: "asc" },
  });
  const builtIns = BUILT_IN_AGENTS.map((agent) => ({
    key: agent.key,
    baseKey: agent.key,
    name: agent.name,
    description: agent.description,
    builtIn: true,
    enabled: true,
    version: 0,
    instructions: agent.instructions,
    model: agentConfig.model,
    effort: agent.effort,
    maxSteps: agent.maxSteps,
    subagent: agent.subagent,
    notificationGroupId: null,
    runAsUserId: null,
    permissions: agent.rules,
  }));
  return [...builtIns, ...rows.map(describeAgent).filter((a) => a !== null)];
});

export const definitionCreate = agentsRequired.input(definitionCreateSchema).handler(async ({ input, context }) => {
  await context.access.require("ADMIN", { site: input.siteId });
  if (isBuiltInKey(input.key)) throw new ORPCError("CONFLICT", { message: "That key belongs to a built-in agent" });
  await checkRunAs(context, input.siteId, input.runAsUserId);
  const { siteId, permissions, ...fields } = input;
  const existing = await prisma.agentDefinition.findUnique({ where: { siteId_key: { siteId, key: input.key } } });
  if (existing && !existing.isDeleted) throw new ORPCError("CONFLICT", { message: "An agent with that key exists" });
  const data = {
    ...fields,
    permissions: (permissions ?? []) as Prisma.InputJsonValue,
    createdById: userId(context),
    isDeleted: false,
  };
  const row = existing
    ? await prisma.agentDefinition.update({ where: { id: existing.id }, data: { ...data, version: { increment: 1 } } })
    : await prisma.agentDefinition.create({ data: { siteId, ...data } });
  return describeAgent(row);
});

export const definitionUpdate = agentsRequired.input(definitionUpdateSchema).handler(async ({ input, context }) => {
  await context.access.require("ADMIN", { site: input.siteId });
  const row = await prisma.agentDefinition.findFirst({
    where: { siteId: input.siteId, key: input.key, isDeleted: false },
  });
  if (!row) throw new ORPCError("NOT_FOUND", { message: "Agent not found" });
  if (input.runAsUserId !== undefined) await checkRunAs(context, input.siteId, input.runAsUserId);
  const { siteId: _siteId, key: _key, permissions, ...fields } = input;
  const updated = await prisma.agentDefinition.update({
    where: { id: row.id },
    data: {
      ...fields,
      ...(permissions ? { permissions: permissions as Prisma.InputJsonValue } : {}),
      version: { increment: 1 },
    },
  });
  return describeAgent(updated);
});

export const definitionArchive = agentsRequired
  .input(z.object({ siteId: z.uuid(), key: agentKeySchema }))
  .handler(async ({ input, context }) => {
    await context.access.require("ADMIN", { site: input.siteId });
    const { count } = await prisma.agentDefinition.updateMany({
      where: { siteId: input.siteId, key: input.key, isDeleted: false },
      data: { isDeleted: true, enabled: false },
    });
    if (count === 0) throw new ORPCError("NOT_FOUND", { message: "Agent not found" });
    await prisma.agentTrigger.updateMany({
      where: { siteId: input.siteId, agentKey: input.key },
      data: { enabled: false },
    });
    return { success: true };
  });

// ── Triggers ───────────────────────────────────────────────────────────────

const triggerFields = {
  agentKey: z.string().min(1),
  name: z.string().min(1).max(120),
  enabled: z.boolean().optional(),
  kind: z.enum(["HOOK_EVENT", "SCHEDULE"]),
  prompt: z.string().max(8000),
  eventNamespace: z.string().min(1).nullable().optional(),
  eventName: z.string().min(1).nullable().optional(),
  eventVersion: z.string().min(1).nullable().optional(),
  hookId: z.uuid().nullable().optional(),
  schedule: z
    .object({ time: z.string().regex(/^\d{2}:\d{2}$/), days: z.array(z.number().int().min(0).max(6)).min(1) })
    .nullable()
    .optional(),
  cooldownMs: z
    .number()
    .int()
    .min(0)
    .max(7 * 24 * 3_600_000)
    .optional(),
  maxRunsPerHour: z.number().int().min(1).max(120).optional(),
};
const triggerCreateSchema = z.object({ siteId: z.uuid(), ...triggerFields });
const triggerUpdateSchema = z.object({ siteId: z.uuid(), id: z.uuid(), ...triggerFields });

function validateTrigger(input: z.infer<typeof triggerCreateSchema>) {
  if (input.kind === "HOOK_EVENT" && (!input.eventNamespace || !input.eventName || !input.eventVersion)) {
    throw new ORPCError("BAD_REQUEST", { message: "A hook trigger needs the event it listens for" });
  }
  if (input.kind === "SCHEDULE" && !parseSchedule(input.schedule)) {
    throw new ORPCError("BAD_REQUEST", { message: "A scheduled trigger needs a time and days" });
  }
}

function triggerData(input: z.infer<typeof triggerCreateSchema>) {
  const { siteId: _siteId, prompt: text, schedule, ...rest } = input;
  return {
    ...rest,
    prompt: { text } as Prisma.InputJsonValue,
    schedule: input.kind === "SCHEDULE" && schedule ? (schedule as Prisma.InputJsonValue) : undefined,
  };
}

export const triggerList = agentsRequired.input(siteInputSchema).handler(async ({ input, context }) => {
  await context.access.require("VIEW", { site: input.siteId });
  return prisma.agentTrigger.findMany({ where: { siteId: input.siteId, isDeleted: false }, orderBy: { name: "asc" } });
});

export const triggerCreate = agentsRequired.input(triggerCreateSchema).handler(async ({ input, context }) => {
  await context.access.require("ADMIN", { site: input.siteId });
  validateTrigger(input);
  const agent = await resolveAgent(input.siteId, input.agentKey);
  if (!agent || agent.subagent)
    throw new ORPCError("BAD_REQUEST", { message: "Pick an agent that can run on its own" });
  const row = await prisma.agentTrigger.create({
    data: { siteId: input.siteId, ...triggerData(input), createdById: userId(context) },
  });
  await rearmAgentTrigger(row.id);
  return row;
});

export const triggerUpdate = agentsRequired.input(triggerUpdateSchema).handler(async ({ input, context }) => {
  await context.access.require("ADMIN", { site: input.siteId });
  validateTrigger(input);
  const existing = await prisma.agentTrigger.findFirst({
    where: { id: input.id, siteId: input.siteId, isDeleted: false },
  });
  if (!existing) throw new ORPCError("NOT_FOUND", { message: "Trigger not found" });
  const { id, ...rest } = input;
  // Whoever edits a trigger becomes the person it runs as (for agents
  // without a run-as user of their own).
  const row = await prisma.agentTrigger.update({
    where: { id },
    data: { ...triggerData(rest), createdById: userId(context) },
  });
  await rearmAgentTrigger(row.id);
  return row;
});

export const triggerDelete = agentsRequired.input(sessionInputSchema).handler(async ({ input, context }) => {
  await context.access.require("ADMIN", { site: input.siteId });
  const { count } = await prisma.agentTrigger.updateMany({
    where: { id: input.id, siteId: input.siteId, isDeleted: false },
    data: { isDeleted: true, enabled: false },
  });
  if (count === 0) throw new ORPCError("NOT_FOUND", { message: "Trigger not found" });
  await rearmAgentTrigger(input.id);
  return { success: true };
});

// ── Approvals ──────────────────────────────────────────────────────────────

const approvalListSchema = z.object({
  siteId: z.uuid(),
  status: z.enum(["PENDING", "APPROVED", "REJECTED", "EXPIRED"]).default("PENDING"),
  sessionId: z.uuid().optional(),
});

export const approvalList = agentsRequired.input(approvalListSchema).handler(async ({ input, context }) => {
  await context.access.require("VIEW", { site: input.siteId });
  const me = userId(context);
  const rows = await listApprovals(input.siteId, input.status);
  // Someone else's chat stays private, approvals included.
  return rows.filter(
    (row) =>
      (!input.sessionId || row.sessionId === input.sessionId) &&
      (row.session.trigger !== "CHAT" || row.session.actorUserId === me),
  );
});

const approvalReplySchema = z.object({
  siteId: z.uuid(),
  requestId: z.uuid(),
  reply: z.enum(["once", "always", "reject"]),
  feedback: z.string().max(4000).nullable().optional(),
});

export const approvalReply = agentsRequired.input(approvalReplySchema).handler(async ({ input, context }) => {
  await context.access.require("VIEW", { site: input.siteId });
  const request = await prisma.agentPermissionRequest.findFirst({
    where: { id: input.requestId, siteId: input.siteId },
    include: { session: { select: { actorUserId: true, trigger: true } } },
  });
  if (!request) throw new ORPCError("NOT_FOUND", { message: "Approval request not found" });
  // Applying changes the graph: plant admins only. Other asks may also be
  // answered by the person the run acts for.
  const admin = await isSiteAdmin(context, input.siteId);
  const owner = request.session.actorUserId === userId(context);
  if (request.permission === "changeset.apply" ? !admin : !(admin || owner)) {
    throw new ORPCError("FORBIDDEN", { message: "You can't answer this request" });
  }
  try {
    return await replyToApproval({
      requestId: input.requestId,
      siteId: input.siteId,
      reply: input.reply,
      feedback: input.feedback,
      userId: userId(context),
    });
  } catch (err) {
    if (err instanceof ApprovalError) {
      const code = err.code === "CLOSED" ? "CONFLICT" : err.code;
      throw new ORPCError(code, { message: err.message });
    }
    throw err;
  }
});

// Its own object, so the app router's type refers to it by name instead of
// inlining it (the published client's declarations have a size limit).
export const agentRouter = {
  status,
  prompt,
  subscribe,
  interrupt,
  session: { list: sessionList, get: sessionGet, rename: sessionRename, delete: sessionDelete },
  definition: {
    list: definitionList,
    create: definitionCreate,
    update: definitionUpdate,
    archive: definitionArchive,
  },
  trigger: { list: triggerList, create: triggerCreate, update: triggerUpdate, delete: triggerDelete },
  approval: { list: approvalList, reply: approvalReply },
};
