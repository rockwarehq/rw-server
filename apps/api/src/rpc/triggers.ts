import { ORPCError } from "@orpc/server";
import * as z from "zod";
import { getTriggerFramework } from "../triggers/index.js";
import { validateActionInputs } from "../triggers/validate.js";
import { publicProcedure } from "./middleware.js";

// NOTE: uses `publicProcedure` (no auth) because the framework is backed by a MOCK store today.
// When the store moves to @rw/db (workspace-scoped), switch these to `authRequired` and thread the
// workspace context, mirroring the other routers (e.g. metric-catalog.ts).

const conditionsSchema = z.object({
  combinator: z.string(),
  rules: z.array(z.any()),
  not: z.boolean().optional(),
});

const actionSchema = z.object({
  type: z.string(),
  inputs: z.record(z.string(), z.unknown()),
});

/** Catalog (event + action schemas, facts, variables) — drives a UI editor. */
export const getCatalog = publicProcedure.handler(async () => getTriggerFramework().catalog());

export const listTriggers = publicProcedure.handler(async () => getTriggerFramework().store.list());

export const createTrigger = publicProcedure
  .input(
    z.object({
      label: z.string().min(1),
      enabled: z.boolean().optional(),
      conditions: conditionsSchema,
      action: actionSchema,
    }),
  )
  .handler(async ({ input }) => {
    const fw = getTriggerFramework();
    const v = validateActionInputs(input.action.type, input.action.inputs);
    if (!v.ok) throw new ORPCError("BAD_REQUEST", { message: `action.inputs invalid — ${v.error}` });

    const trigger = fw.store.upsert({
      id: fw.store.newId(),
      label: input.label,
      enabled: input.enabled ?? true,
      event: "job.changed",
      conditions: input.conditions,
      action: { type: input.action.type, inputs: v.value },
    });
    fw.engine.reload();
    return trigger;
  });

export const updateTrigger = publicProcedure
  .input(
    z.object({
      id: z.string(),
      label: z.string().optional(),
      enabled: z.boolean().optional(),
      conditions: conditionsSchema.optional(),
      action: actionSchema.optional(),
    }),
  )
  .handler(async ({ input }) => {
    const fw = getTriggerFramework();
    const existing = fw.store.get(input.id);
    if (!existing) throw new ORPCError("NOT_FOUND", { message: "trigger not found" });

    let action = existing.action;
    if (input.action) {
      const v = validateActionInputs(input.action.type, input.action.inputs);
      if (!v.ok) throw new ORPCError("BAD_REQUEST", { message: `action.inputs invalid — ${v.error}` });
      action = { type: input.action.type, inputs: v.value };
    }

    const updated = fw.store.upsert({
      ...existing,
      label: input.label ?? existing.label,
      enabled: input.enabled ?? existing.enabled,
      conditions: input.conditions ?? existing.conditions,
      action,
    });
    fw.engine.reload();
    return updated;
  });

export const deleteTrigger = publicProcedure.input(z.object({ id: z.string() })).handler(async ({ input }) => {
  const fw = getTriggerFramework();
  if (!fw.store.remove(input.id)) throw new ORPCError("NOT_FOUND", { message: "trigger not found" });
  fw.engine.reload();
  return { ok: true };
});
