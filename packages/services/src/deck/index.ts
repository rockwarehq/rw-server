import { createHash, randomBytes } from "node:crypto";
import prisma, { type Prisma } from "@rw/db";
import { dateOnly } from "./days.js";
import { buildEdition } from "./edition.js";
import type { DeckRange, DeckSlide } from "./types.js";

// Report decks (ADR-0018): decks, their editions, and links that open
// editions without signing in.

export { deckSpan } from "./edition.js";
export * from "./types.js";

type ServiceError = { error: string; code: string };
type Result<T> = { data: T } | ServiceError;

const DECK_SELECT = {
  id: true,
  siteId: true,
  workcenterId: true,
  name: true,
  range: true,
  slides: true,
  visibility: true,
  createdById: true,
  createdAt: true,
  updatedAt: true,
} as const;

const EDITION_SUMMARY = {
  id: true,
  deckId: true,
  asOf: true,
  dateFrom: true,
  dateTo: true,
  source: true,
  automationId: true,
  createdById: true,
  createdAt: true,
} as const;

const toDate = (date: Date | null) => (date ? dateOnly(date) : null);

function presentDeck(row: Prisma.ReportDeckGetPayload<{ select: typeof DECK_SELECT }>) {
  return { ...row, range: row.range as DeckRange, slides: row.slides as unknown as DeckSlide[] };
}

function presentEdition<T extends { dateFrom: Date | null; dateTo: Date | null }>(row: T) {
  return { ...row, dateFrom: toDate(row.dateFrom), dateTo: toDate(row.dateTo) };
}

// ── Decks ──────────────────────────────────────────────────────────────────

/** A site's decks, each with when its latest edition was made. */
export async function listDecks(scope: { siteId: string; workcenterIds?: string[] }) {
  const rows = await prisma.reportDeck.findMany({
    where: { siteId: scope.siteId, ...(scope.workcenterIds ? { workcenterId: { in: scope.workcenterIds } } : {}) },
    orderBy: { name: "asc" },
    select: {
      ...DECK_SELECT,
      editions: { orderBy: { asOf: "desc" }, take: 1, select: EDITION_SUMMARY },
      _count: { select: { editions: true } },
    },
  });
  return rows.map(({ editions, _count, ...deck }) => ({
    ...presentDeck(deck),
    latestEdition: editions[0] ? presentEdition(editions[0]) : null,
    editionCount: _count.editions,
  }));
}

export async function getDeck(id: string) {
  const row = await prisma.reportDeck.findUnique({ where: { id }, select: DECK_SELECT });
  return row ? presentDeck(row) : null;
}

async function checkWorkcenter(siteId: string, workcenterId: string): Promise<ServiceError | null> {
  const workcenter = await prisma.workcenter.findUnique({ where: { id: workcenterId }, select: { siteId: true } });
  return workcenter?.siteId === siteId
    ? null
    : { error: "The workcenter isn't at this site.", code: "WORKCENTER_NOT_FOUND" };
}

export async function createDeck(input: {
  siteId: string;
  name: string;
  range: DeckRange;
  workcenterId: string;
  slides: DeckSlide[];
  createdById: string | null;
}) {
  const invalid = await checkWorkcenter(input.siteId, input.workcenterId);
  if (invalid) return invalid;
  const row = await prisma.reportDeck.create({
    data: { ...input, slides: input.slides as unknown as Prisma.InputJsonValue },
    select: DECK_SELECT,
  });
  return { data: presentDeck(row) };
}

export async function updateDeck(
  id: string,
  patch: { name?: string; range?: DeckRange; workcenterId?: string; slides?: DeckSlide[] },
) {
  const deck = await prisma.reportDeck.findUnique({ where: { id }, select: { siteId: true } });
  if (!deck) return { error: "Deck not found", code: "DECK_NOT_FOUND" };
  if (patch.workcenterId) {
    const invalid = await checkWorkcenter(deck.siteId, patch.workcenterId);
    if (invalid) return invalid;
  }
  const row = await prisma.reportDeck.update({
    where: { id },
    data: { ...patch, slides: patch.slides as unknown as Prisma.InputJsonValue | undefined },
    select: DECK_SELECT,
  });
  return { data: presentDeck(row) };
}

/** Deletes the deck, its editions, and their links' hold on them. */
export async function deleteDeck(id: string): Promise<boolean> {
  const { count } = await prisma.reportDeck.deleteMany({ where: { id } });
  return count > 0;
}

// ── Editions ───────────────────────────────────────────────────────────────

/** The deck worked out now, not saved. */
export async function previewDeck(id: string) {
  const deck = await getDeck(id);
  if (!deck) return null;
  const built = await buildEdition(deck, new Date());
  return { ...built, asOf: built.asOf.toISOString() };
}

export async function makeEdition(
  deckId: string,
  input: { asOf: Date; source: "MANUAL" | "SCHEDULE"; automationId?: string | null; createdById?: string | null },
) {
  const deck = await getDeck(deckId);
  if (!deck) return { error: "Deck not found", code: "DECK_NOT_FOUND" };
  const built = await buildEdition(deck, input.asOf);
  const row = await prisma.reportDeckEdition.create({
    data: {
      deckId,
      siteId: deck.siteId,
      asOf: built.asOf,
      dateFrom: built.dateFrom ? new Date(built.dateFrom) : null,
      dateTo: built.dateTo ? new Date(built.dateTo) : null,
      source: input.source,
      automationId: input.automationId ?? null,
      createdById: input.createdById ?? null,
      setup: built.setup as unknown as Prisma.InputJsonValue,
      pages: built.pages as unknown as Prisma.InputJsonValue,
      facts: built.facts as Prisma.InputJsonValue,
    },
    select: EDITION_SUMMARY,
  });
  return { data: presentEdition(row) };
}

export async function listEditions(deckId: string) {
  const rows = await prisma.reportDeckEdition.findMany({
    where: { deckId },
    orderBy: { asOf: "desc" },
    select: EDITION_SUMMARY,
  });
  return rows.map(presentEdition);
}

export async function latestEdition(deckId: string) {
  const row = await prisma.reportDeckEdition.findFirst({
    where: { deckId },
    orderBy: { asOf: "desc" },
    select: EDITION_SUMMARY,
  });
  return row ? presentEdition(row) : null;
}

const EDITION_FULL = { ...EDITION_SUMMARY, setup: true, pages: true, facts: true } as const;

export async function getEdition(id: string) {
  const row = await prisma.reportDeckEdition.findUnique({ where: { id }, select: EDITION_FULL });
  return row ? presentEdition(row) : null;
}

export async function deleteEdition(id: string): Promise<boolean> {
  const { count } = await prisma.reportDeckEdition.deleteMany({ where: { id } });
  return count > 0;
}

// ── Links ──────────────────────────────────────────────────────────────────

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

/** A new link to editions, in order. The token is returned once and only its hash is kept. */
export async function createLink(input: {
  siteId: string;
  editionIds: string[];
  label: string;
  expiresAt: Date | null;
  createdById?: string | null;
  automationId?: string | null;
}): Promise<Result<{ id: string; label: string; expiresAt: Date | null; createdAt: Date; token: string }>> {
  const editions = await prisma.reportDeckEdition.findMany({
    where: { id: { in: input.editionIds }, siteId: input.siteId },
    select: { id: true },
  });
  if (editions.length !== new Set(input.editionIds).size) {
    return { error: "Edition not found", code: "EDITION_NOT_FOUND" };
  }
  const token = randomBytes(24).toString("base64url");
  const row = await prisma.reportDeckLink.create({
    data: {
      siteId: input.siteId,
      tokenHash: hashToken(token),
      label: input.label,
      expiresAt: input.expiresAt,
      createdById: input.createdById ?? null,
      automationId: input.automationId ?? null,
      editions: { create: input.editionIds.map((editionId, position) => ({ editionId, position })) },
    },
    select: { id: true, label: true, expiresAt: true, createdAt: true },
  });
  return { data: { ...row, token } };
}

/** The links that open an edition, newest first. Tokens are never returned again. */
export async function listLinks(editionId: string) {
  return prisma.reportDeckLink.findMany({
    where: { editions: { some: { editionId } } },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      label: true,
      expiresAt: true,
      revokedAt: true,
      createdById: true,
      automationId: true,
      createdAt: true,
    },
  });
}

export async function revokeLink(id: string): Promise<boolean> {
  const { count } = await prisma.reportDeckLink.updateMany({
    where: { id, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return count > 0;
}

/** What a link opens, for anyone holding its token: its editions as stored, nothing live. */
export async function viewLink(token: string, now = new Date()) {
  const link = await prisma.reportDeckLink.findUnique({
    where: { tokenHash: hashToken(token) },
    select: {
      label: true,
      expiresAt: true,
      revokedAt: true,
      siteId: true,
      editions: { orderBy: { position: "asc" }, select: { edition: { select: EDITION_FULL } } },
    },
  });
  if (!link) return { error: "Link not found", code: "LINK_NOT_FOUND" };
  if (link.revokedAt) return { error: "This link was turned off.", code: "LINK_REVOKED" };
  if (link.expiresAt && link.expiresAt <= now) return { error: "This link has expired.", code: "LINK_EXPIRED" };
  const site = await prisma.site.findUnique({ where: { id: link.siteId }, select: { name: true, timezone: true } });
  return {
    data: {
      label: link.label,
      expiresAt: link.expiresAt,
      site: { name: site?.name ?? "", timezone: site?.timezone ?? "UTC" },
      editions: link.editions.map(({ edition }) => presentEdition(edition)),
    },
  };
}
