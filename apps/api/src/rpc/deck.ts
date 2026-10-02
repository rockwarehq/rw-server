/**
 * Report decks (ADR-0018). A deck is workcenter data: VIEW on its workcenter
 * to see it and its editions, MANAGE to change it, make editions and create
 * or revoke links. `viewLink` is public: it returns the editions a link names
 * (their pages and saved queries, no results) for anyone holding the token,
 * and never runs a query. Two public reads do, and
 * only what the edition kept: `linkRecap`, a shift recap page's shift, and
 * `linkPage`, one of a page's saved queries. The caller never names a dataset,
 * a filter, a date or a workcenter — a token does what was saved and no more.
 */

import * as deck from "@rw/services/deck/index";
import { reportOrderBySchema, reportSummaryItemsSchema } from "@rw/services/reporting/schema";
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

export const list = userRequired
  .input(
    z.object({
      siteId: z.uuid(),
      /** DECK unless asked: a SHIFT_RECAP is listed from its recap page. */
      kind: z.enum(deck.DECK_KINDS).optional(),
      workcenterId: z.uuid().optional(),
    }),
  )
  .handler(async ({ input, context }) => {
    return deck.listDecks(context.access.list("VIEW", input.siteId, "WORKCENTER"), {
      kind: input.kind,
      workcenterId: input.workcenterId,
    });
  });

export const get = userRequired.input(idInput).handler(async ({ input, context }) => {
  await context.access.require("VIEW", { reportDeck: input.id });
  return found(await deck.getDeck(input.id), "Deck not found");
});

export const create = userRequired
  .input(z.object({ siteId: z.uuid(), kind: z.enum(deck.DECK_KINDS).optional(), ...deckFields }))
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

/** The deck worked out now — its days and pages — without keeping it. Pages are read with `previewPage`. */
export const preview = userRequired.input(idInput).handler(async ({ input, context }) => {
  await context.access.require("VIEW", { reportDeck: input.id });
  return found(await deck.previewDeck(input.id), "Deck not found");
});

/** The days a deck would cover now, and their shifts: what the builder shows its pages for. */
export const span = userRequired
  .input(
    z.object({
      range: deckFields.range,
      workcenterId: z.uuid(),
      /** The shift names "last-shift" picks among. */
      shiftNames: z.array(z.string().min(1).max(64)).max(10).optional(),
    }),
  )
  .handler(async ({ input, context }) => {
    await context.access.require("VIEW", { workcenter: input.workcenterId });
    return deck.deckSpan(input.range, input.workcenterId, new Date(), input.shiftNames);
  });

// ── Editions ───────────────────────────────────────────────────────────────

export const makeEdition = userRequired
  .input(
    z.object({
      deckId: z.uuid(),
      /**
       * The moment the edition is worked out as of; now when omitted. A past
       * moment keeps an earlier period — a shift recap as of a shift's end is
       * THAT shift's recap, which is how any past shift is shared. Never the
       * future: an edition is what had finished by then.
       */
      asOf: z.coerce.date().optional(),
    }),
  )
  .handler(async ({ input, context }) => {
    await context.access.require("MANAGE", { reportDeck: input.deckId });
    const now = new Date();
    return unwrap(
      await deck.makeEdition(input.deckId, {
        asOf: input.asOf && input.asOf.getTime() < now.getTime() ? input.asOf : now,
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

/**
 * Public: a link's shift recap page, read live — only the workcenter and
 * shift its edition kept. The token is the only credential.
 */
export const linkRecap = publicProcedure
  .input(z.object({ token: z.string().min(16).max(128), editionId: z.uuid(), pageKey: z.string().min(1).max(200) }))
  .handler(async ({ input }) => unwrap(await deck.linkRecap(input.token, input.editionId, input.pageKey)));

// ── Pages, read live ───────────────────────────────────────────────────────

/** Which saved query of which page, and what a reader may ask of it. */
const pageReadFields = {
  pageKey: z.string().min(1).max(200),
  slot: z.string().min(1).max(40),
  /** A row list: which rows, and their order. Which rows MATCH is the page's. */
  limit: z.number().int().min(1).max(1000).optional(),
  // Deep enough for any log a person pages through; a public read stays bounded.
  offset: z.number().int().min(0).max(100_000).optional(),
  orderBy: reportOrderBySchema.optional(),
  /** Figures over every row the list matches. */
  summary: reportSummaryItemsSchema.optional(),
};

const pageRead = ({ limit, offset, orderBy, summary }: z.infer<z.ZodObject<typeof pageReadFields>>) => ({
  limit,
  offset,
  orderBy,
  summary,
});

/** Public: a page of a link's edition, read live. The token is the only credential. */
export const linkPage = publicProcedure
  .input(z.object({ token: z.string().min(16).max(128), editionId: z.uuid(), ...pageReadFields }))
  .handler(async ({ input }) =>
    unwrap(await deck.linkPage(input.token, input.editionId, input.pageKey, input.slot, pageRead(input))),
  );

/** An edition's page, read live. */
export const editionPage = userRequired
  .input(z.object({ editionId: z.uuid(), ...pageReadFields }))
  .handler(async ({ input, context }) => {
    await context.access.require("VIEW", { reportDeckEdition: input.editionId });
    return unwrap(await deck.editionPage(input.editionId, input.pageKey, input.slot, pageRead(input)));
  });

/** A page of the deck as it stands now, read live: a preview's. */
export const previewPage = userRequired
  .input(z.object({ deckId: z.uuid(), ...pageReadFields }))
  .handler(async ({ input, context }) => {
    await context.access.require("VIEW", { reportDeck: input.deckId });
    return unwrap(await deck.previewPage(input.deckId, input.pageKey, input.slot, pageRead(input)));
  });
