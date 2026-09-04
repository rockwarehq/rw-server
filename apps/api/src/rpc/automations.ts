import { ORPCError } from "@orpc/server";
import type { Automation, AutomationAction, AutomationFramework } from "@rw/automations";
import * as z from "zod";
import { getAutomationFramework } from "../automations/index.js";
import { authRequired } from "./middleware.js";
import { authorize, authorizeList } from "@rw/auth/iam/policy";
import { grant } from "./authz.js";

// Automations belong to a site (the engine's `partition`). Handlers resolve the single shared
// framework (cached after first build; the first call pays the Prisma initial-load cost) and gate
// on `settings:*` at the automation's site via the `automation` policy resolver. Legacy rows with
// no site are global; the resolver's null-site rule applies to them.

const conditionsSchema = z.object({
  combinator: z.string(),
  rules: z.array(z.any()),
  not: z.boolean().optional(),
});

// Per-action input: type + optional version (defaults to the action's `latest`) + inputs + optional delay.
const actionSchema = z.object({
  type: z.string(),
  version: z.string().min(1).optional(),
  inputs: z.record(z.string(), z.unknown()),
  delayMs: z.number().int().min(0).nullable().optional(),
  repeat: z.boolean().nullable().optional(),
});

/** An automation has one or more actions, run sequentially when conditions match. */
const actionsSchema = z.array(actionSchema).min(1);

/** Wire shape: the engine's `partition` is presented as `siteId`. */
function present(a: Automation) {
  const { partition, ...rest } = a;
  return { ...rest, siteId: partition ?? null };
}

/**
 * Validate every action's inputs (against the chosen version's inputSchema) and return the
 * normalized `AutomationAction[]`. If a client omits `version`, the action's `latest` is filled in.
 * Throws on the first bad action.
 */
function validateActions(fw: AutomationFramework, actions: z.infer<typeof actionsSchema>): AutomationAction[] {
  return actions.map((a, idx) => {
    const schema = fw.actionSchemas[a.type];
    if (!schema) {
      throw new ORPCError("BAD_REQUEST", { message: `actions[${idx}].type unknown: "${a.type}"` });
    }
    const version = a.version ?? schema.latest;
    if (!schema.versions[version]) {
      throw new ORPCError("BAD_REQUEST", {
        message: `actions[${idx}] unknown version: "${a.type}@${version}" (known: ${Object.keys(schema.versions).join(", ")})`,
      });
    }
    try {
      return {
        type: a.type,
        version,
        inputs: fw.validateActionInputs(a.type, version, a.inputs),
        ...(a.delayMs ? { delayMs: a.delayMs } : {}),
        ...(a.repeat ? { repeat: true } : {}),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new ORPCError("BAD_REQUEST", { message: `actions[${idx}].inputs invalid — ${msg}` });
    }
  });
}

/** Every event and action schema the editor can pick from (`getCatalog` needs a chosen event). */
export const listSchemas = authRequired.handler(async ({ context }) => {
  grant(await authorize(context.iam, { permission: "settings:read", scope: { kind: "anySite" } }));

  const fw = await getAutomationFramework();
  return { events: Object.values(fw.eventSchemas), actions: Object.values(fw.actionSchemas) };
});

/**
 * Catalog (event + action schemas, facts, variables) for a specific (eventType, actionType) — and
 * optionally specific versions. If a version is omitted, the framework uses each schema's `latest`.
 */
export const getCatalog = authRequired
  .input(
    z.object({
      eventType: z.string().min(1),
      actionType: z.string().min(1),
      eventVersion: z.string().min(1).optional(),
      actionVersion: z.string().min(1).optional(),
    }),
  )
  .handler(async ({ input, context }) => {
    grant(await authorize(context.iam, { permission: "settings:read", scope: { kind: "anySite" } }));

    const fw = await getAutomationFramework();
    return fw.catalog(input.eventType, input.actionType, input.eventVersion, input.actionVersion);
  });

/**
 * Picker options for a ref-typed action input. The editor calls this to populate a dropdown for
 * any `SchemaProperty` declaring `ref: { source }`. Throws BAD_REQUEST if the source isn't
 * registered (startup validation would have caught a schema-side typo — this is defense against
 * typo'd client calls).
 */
export const listRefOptions = authRequired
  .input(z.object({ source: z.string().min(1), siteId: z.uuid().optional() }))
  .handler(async ({ input, context }) => {
    grant(await authorize(context.iam, { permission: "settings:read", scope: { kind: "anySite" } }));

    const fw = await getAutomationFramework();
    try {
      return await fw.listRefOptions(input.source, input.siteId ? { siteId: input.siteId } : {});
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new ORPCError("BAD_REQUEST", { message: msg });
    }
  });

/** Automations for one site (the requested site, or the token's active site) plus any global ones. */
export const listAutomations = authRequired
  .input(z.object({ siteId: z.uuid().optional() }).optional())
  .handler(async ({ input, context }) => {
    const scope = grant(
      await authorizeList(context.iam, { permission: "settings:read", requestedSiteId: input?.siteId }),
    );

    const fw = await getAutomationFramework();
    return fw.store
      .list()
      .filter((a) => a.partition == null || a.partition === scope.siteId)
      .map(present);
  });

export const createAutomation = authRequired
  .input(
    z.object({
      siteId: z.uuid(),
      label: z.string().min(1),
      enabled: z.boolean().optional(),
      // Automation pins to a specific event schema version (defaults to event's `latest`).
      event: z.string().min(1).default("job.changed"),
      eventVersion: z.string().min(1).optional(),
      conditions: conditionsSchema,
      // Allow creating a stub with no actions yet — the UI creates an empty
      // automation and the user configures actions afterward in the editor.
      actions: z.array(actionSchema).default([]),
      cooldownMs: z.number().int().min(0).nullable().optional(),
    }),
  )
  .handler(async ({ input, context }) => {
    grant(
      await authorize(context.iam, { permission: "settings:write", scope: { kind: "site", siteId: input.siteId } }),
    );

    const fw = await getAutomationFramework();
    const eventSchema = fw.eventSchemas[input.event];
    if (!eventSchema) throw new ORPCError("BAD_REQUEST", { message: `unknown event type: "${input.event}"` });
    const eventVersion = input.eventVersion ?? eventSchema.latest;
    if (!eventSchema.versions[eventVersion]) {
      throw new ORPCError("BAD_REQUEST", {
        message: `unknown event version: "${input.event}@${eventVersion}" (known: ${Object.keys(eventSchema.versions).join(", ")})`,
      });
    }
    const actions = validateActions(fw, input.actions);

    const automation = await fw.store.upsert({
      id: fw.store.newId(),
      label: input.label,
      enabled: input.enabled ?? true,
      event: input.event,
      eventVersion,
      partition: input.siteId,
      conditions: input.conditions,
      actions,
      cooldownMs: input.cooldownMs || null,
    });
    fw.engine.reload();
    return present(automation);
  });

export const updateAutomation = authRequired
  .input(
    z.object({
      id: z.string(),
      label: z.string().optional(),
      enabled: z.boolean().optional(),
      eventVersion: z.string().min(1).optional(),
      conditions: conditionsSchema.optional(),
      actions: actionsSchema.optional(),
      cooldownMs: z.number().int().min(0).nullable().optional(),
    }),
  )
  .handler(async ({ input, context }) => {
    grant(await authorize(context.iam, { permission: "settings:write", scope: { kind: "automation", id: input.id } }));

    const fw = await getAutomationFramework();
    const existing = fw.store.get(input.id);
    if (!existing) throw new ORPCError("NOT_FOUND", { message: "automation not found" });

    let eventVersion = existing.eventVersion;
    if (input.eventVersion) {
      const eventSchema = fw.eventSchemas[existing.event];
      if (!eventSchema?.versions[input.eventVersion]) {
        throw new ORPCError("BAD_REQUEST", {
          message: `unknown event version: "${existing.event}@${input.eventVersion}"`,
        });
      }
      eventVersion = input.eventVersion;
    }

    const actions = input.actions ? validateActions(fw, input.actions) : existing.actions;

    const updated = await fw.store.upsert({
      ...existing,
      label: input.label ?? existing.label,
      enabled: input.enabled ?? existing.enabled,
      eventVersion,
      conditions: input.conditions ?? existing.conditions,
      actions,
      cooldownMs: input.cooldownMs === undefined ? existing.cooldownMs : input.cooldownMs || null,
    });
    fw.engine.reload();
    return present(updated);
  });

export const deleteAutomation = authRequired.input(z.object({ id: z.string() })).handler(async ({ input, context }) => {
  grant(await authorize(context.iam, { permission: "settings:admin", scope: { kind: "automation", id: input.id } }));

  const fw = await getAutomationFramework();
  if (!(await fw.store.remove(input.id))) throw new ORPCError("NOT_FOUND", { message: "automation not found" });
  fw.engine.reload();
  return { ok: true };
});
