import { ANNOUNCE_CHIMES, ANNOUNCE_VOICES } from "@rw/runtime/announce-subjects";
import * as paging from "@rw/services/paging/index";
import { z } from "zod";
import { throwServiceError, unwrap } from "./errors.js";
import { userRequired } from "./middleware.js";

// Overhead paging (Settings → Overhead paging): saved pages, sending by hand,
// and the log of what was sent. Saved pages change at site ADMIN, sending is
// site MANAGE (like a manual notification), reading is site VIEW.

const idInputSchema = z.object({ id: z.uuid() });
const pageSchema = { limit: z.number().min(0).default(50), offset: z.number().min(0).default(0) };

// Chime and voice names are open-ended (a gateway can add its own), so they're
// checked for shape here; an unknown one falls back to the gateway's default.
const nameSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "Letters, numbers, - and _ only");

const settingsShape = {
  text: z.string().trim().min(1).max(1000),
  /** Empty or omitted = every speaker at the plant, resolved when sent. */
  gatewayIds: z.array(z.uuid()).max(100).optional(),
  priority: z.enum(["NORMAL", "HIGH", "EMERGENCY"]).optional(),
  /** "off", a chime name, or null for the gateway's setting. */
  chimeBefore: nameSchema.nullable().optional(),
  chimeAfter: nameSchema.nullable().optional(),
  repeat: z.number().int().min(1).max(10).optional(),
  voice: nameSchema.nullable().optional(),
  speed: z.number().min(0.5).max(2).nullable().optional(),
};

const createInputSchema = z.object({ siteId: z.uuid(), name: z.string().trim().min(1).max(100), ...settingsShape });

const updateInputSchema = z.object({
  id: z.uuid(),
  name: z.string().trim().min(1).max(100).optional(),
  ...z.object(settingsShape).partial().shape,
});

const listInputSchema = z.object({ siteId: z.uuid().optional(), ...pageSchema });
const sendInputSchema = z.object({ siteId: z.uuid(), ...settingsShape });
const logListInputSchema = z.object({ siteId: z.uuid().optional(), pageId: z.uuid().optional(), ...pageSchema });

function sentBy(context: { current: { user: { id: string; firstName: string | null; lastName: string | null } } }) {
  const { id, firstName, lastName } = context.current.user;
  return { sentByUserId: id, sentByName: [firstName, lastName].filter(Boolean).join(" ") || undefined };
}

// ── Saved pages ─────────────────────────────────────────────────────────

export const create = userRequired.input(createInputSchema).handler(async ({ input, context }) => {
  await context.access.require("ADMIN", { site: input.siteId });
  const result = await paging.createPage(input);
  if ("error" in result) throwServiceError(result);
  return result.data;
});

export const list = userRequired.input(listInputSchema).handler(async ({ input, context }) => {
  const scope = context.access.list("VIEW", input.siteId);
  return paging.listPages({ ...input, ...scope });
});

export const get = userRequired.input(idInputSchema).handler(async ({ input, context }) => {
  await context.access.require("VIEW", { overheadPage: input.id });
  return unwrap(await paging.getPageById(input.id), { notFoundMessage: "Overhead page not found" });
});

export const update = userRequired.input(updateInputSchema).handler(async ({ input, context }) => {
  await context.access.require("ADMIN", { overheadPage: input.id });
  const { id, ...data } = input;
  const result = await paging.updatePage(id, data);
  if ("error" in result) throwServiceError(result);
  return result.data;
});

export const archive = userRequired.input(idInputSchema).handler(async ({ input, context }) => {
  await context.access.require("ADMIN", { overheadPage: input.id });
  const result = await paging.archivePage(input.id);
  if ("error" in result) throwServiceError(result);
  return result.data;
});

// ── Sending + log ───────────────────────────────────────────────────────

/** A one-off page typed in by hand. Returns the log entry (status SENT / PARTIAL / FAILED). */
export const send = userRequired.input(sendInputSchema).handler(async ({ input, context }) => {
  await context.access.require("MANAGE", { site: input.siteId });
  const gatewayError = await paging.validateGateways(input.siteId, input.gatewayIds);
  if (gatewayError) throwServiceError(gatewayError);
  return (await paging.sendPage({ ...input, ...sentBy(context) })).data;
});

/** A saved page, exactly as saved. Returns the log entry. */
export const sendSaved = userRequired.input(idInputSchema).handler(async ({ input, context }) => {
  await context.access.require("MANAGE", { overheadPage: input.id });
  const result = await paging.sendSavedPage({ id: input.id, ...sentBy(context) });
  if ("error" in result) throwServiceError(result);
  return result.data;
});

export const logList = userRequired.input(logListInputSchema).handler(async ({ input, context }) => {
  const scope = context.access.list("VIEW", input.siteId);
  return paging.listLogs({ ...input, ...scope });
});

/** Voices and bundled chimes the editor offers. */
export const options = userRequired.handler(async ({ context }) => {
  context.access.requireSomewhere("VIEW");
  return { voices: [...ANNOUNCE_VOICES], chimes: [...ANNOUNCE_CHIMES] };
});
