/**
 * Report decks (ADR-0018). A deck is workcenter data: VIEW on its workcenter
 * to see it and its editions, MANAGE to change it, make editions and create
 * or revoke links. `viewLink` is public: it returns a stored snapshot for
 * anyone holding the token and never runs a query.
 */

import * as deck from "@rw/services/deck/index";
import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { throwServiceError } from "./errors.js";
import { publicProcedure, userRequired } from "./middleware.js";

const idInput = z.object({ id: z.uuid() });

const deckFields = {
  name: z.string().trim().min(1).max(120),
  range: z.enum(deck.DECK_RANGES),
  workcenterId: z.uuid(),
  slides: deck.slidesSchema,
};

const found = <T>(value: T | null | undefined, message: string): T => {
  if (value === null || value === undefined) throw new ORPCError("NOT_FOUND", { message });
  return value;
};

const unwrap = <T>(result: { data: T } | { error: string; code: string }): T =>
  "error" in result ? throwServiceError(result) : result.data;

// ── Decks ──────────────────────────────────────────────────────────────────

export const list = userRequired.input(z.object({ siteId: z.uuid() })).handler(async ({ input, context }) => {
  return deck.listDecks(context.access.list("VIEW", input.siteId, "WORKCENTER"));
});

export const get = userRequired.input(idInput).handler(async ({ input, context }) => {
  await context.access.require("VIEW", { reportDeck: input.id });
  return found(await deck.getDeck(input.id), "Deck not found");
});

export const create = userRequired
  .input(z.object({ siteId: z.uuid(), ...deckFields }))
  .handler(async ({ input, context }) => {
    await context.access.require("MANAGE", { workcenter: input.workcenterId });
    return unwrap(await deck.createDeck({ ...input, createdById: context.current.user.id }));
  });

export const update = userRequired
  .input(
    z.object({
      id: z.uuid(),
      name: deckFields.name.optional(),
      range: deckFields.range.optional(),
      workcenterId: deckFields.workcenterId.optional(),
      slides: deckFields.slides.optional(),
    }),
  )
  .handler(async ({ input, context }) => {
    await context.access.require("MANAGE", { reportDeck: input.id });
    if (input.workcenterId) await context.access.require("MANAGE", { workcenter: input.workcenterId });
    const { id, ...patch } = input;
    return unwrap(await deck.updateDeck(id, patch));
  });

export const remove = userRequired.input(idInput).handler(async ({ input, context }) => {
  await context.access.require("MANAGE", { reportDeck: input.id });
  return { ok: await deck.deleteDeck(input.id) };
});

/** The deck worked out now, results and all, without keeping it. */
export const preview = userRequired.input(idInput).handler(async ({ input, context }) => {
  await context.access.require("VIEW", { reportDeck: input.id });
  return found(await deck.previewDeck(input.id), "Deck not found");
});

// ── Editions ───────────────────────────────────────────────────────────────

export const makeEdition = userRequired.input(z.object({ deckId: z.uuid() })).handler(async ({ input, context }) => {
  await context.access.require("MANAGE", { reportDeck: input.deckId });
  return unwrap(
    await deck.makeEdition(input.deckId, {
      asOf: new Date(),
      source: "MANUAL",
      createdById: context.current.user.id,
    }),
  );
});

export const listEditions = userRequired.input(z.object({ deckId: z.uuid() })).handler(async ({ input, context }) => {
  await context.access.require("VIEW", { reportDeck: input.deckId });
  return deck.listEditions(input.deckId);
});

export const getEdition = userRequired.input(idInput).handler(async ({ input, context }) => {
  await context.access.require("VIEW", { reportDeckEdition: input.id });
  return found(await deck.getEdition(input.id), "Edition not found");
});

export const deleteEdition = userRequired.input(idInput).handler(async ({ input, context }) => {
  await context.access.require("MANAGE", { reportDeckEdition: input.id });
  return { ok: await deck.deleteEdition(input.id) };
});

// ── Links ──────────────────────────────────────────────────────────────────

export const createLink = userRequired
  .input(
    z.object({
      editionIds: z.array(z.uuid()).min(1).max(20),
      label: z.string().trim().min(1).max(200),
      /** Null: until revoked. */
      expiresInHours: z
        .number()
        .int()
        .min(1)
        .max(24 * 366)
        .nullable(),
    }),
  )
  .handler(async ({ input, context }) => {
    let siteId = "";
    for (const editionId of input.editionIds) {
      siteId = (await context.access.require("MANAGE", { reportDeckEdition: editionId })).siteId;
    }
    return unwrap(
      await deck.createLink({
        siteId,
        editionIds: input.editionIds,
        label: input.label,
        expiresAt: input.expiresInHours ? new Date(Date.now() + input.expiresInHours * 3_600_000) : null,
        createdById: context.current.user.id,
      }),
    );
  });

export const listLinks = userRequired.input(z.object({ editionId: z.uuid() })).handler(async ({ input, context }) => {
  await context.access.require("VIEW", { reportDeckEdition: input.editionId });
  return deck.listLinks(input.editionId);
});

export const revokeLink = userRequired.input(idInput).handler(async ({ input, context }) => {
  await context.access.require("MANAGE", { reportDeckLink: input.id });
  return { ok: await deck.revokeLink(input.id) };
});

/** Public: what a link opens. The token is the only credential. */
export const viewLink = publicProcedure
  .input(z.object({ token: z.string().min(16).max(128) }))
  .handler(async ({ input }) => unwrap(await deck.viewLink(input.token)));
